import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { Language, Parser, type Node as SyntaxNode } from "web-tree-sitter";
import { createRequire } from "node:module";

import type { ScannedFile } from "./scanner.js";

export const GRAPH_KERNEL_PROTOCOL = "contextmesh.graph-kernel/v1";
export type GraphKernelPolicy = "native-required" | "portable";

export interface KernelSpan {
  startByte: number; endByte: number; startLine: number; startColumn: number; endLine: number; endColumn: number;
}
export interface KernelDeclaration {
  nativeKind: string; name: string; symbolPath: string; containerKind: "function" | "class" | "method";
  containerStartByte: number | null; isAsync: boolean; signature: string; content: string; span: KernelSpan;
}
export interface KernelImport {
  fromImport: boolean; rawModule: string; names: Array<{ name: string; alias: string | null }>; span: KernelSpan; rawText: string;
}
export interface KernelReference { ownerStartByte: number | null; rawName: string; simpleIdentifier: boolean; span: KernelSpan }
export interface PythonKernelFacts {
  relativePath: string; hasError: boolean; declarations: KernelDeclaration[]; imports: KernelImport[];
  inheritances: KernelReference[]; calls: KernelReference[];
}
export interface PythonKernelBatch {
  files: PythonKernelFacts[];
  mode: "sidecar" | "portable";
  providerVersion: string;
  diagnostics: string[];
  filesParsed: number;
}

interface KernelResponse<T> {
  protocol: string; requestId: string; status: string; data: T;
  diagnostics: Array<{ code: string; severity: string; message: string; path?: string }>;
}

const require = createRequire(import.meta.url);
let portableParserPromise: Promise<Parser> | null = null;

async function portableParser(): Promise<Parser> {
  if (!portableParserPromise) portableParserPromise = (async () => {
    const runtimeDirectory = path.dirname(require.resolve("web-tree-sitter"));
    await Parser.init({ locateFile: (file: string) => path.join(runtimeDirectory, file) });
    const grammarDirectory = path.dirname(require.resolve("tree-sitter-python/package.json"));
    const language = await Language.load(path.join(grammarDirectory, "tree-sitter-python.wasm"));
    return new Parser().setLanguage(language);
  })();
  return portableParserPromise;
}

function span(node: SyntaxNode): KernelSpan {
  return { startByte: node.startIndex, endByte: node.endIndex, startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column + 1, endLine: node.endPosition.row + 1, endColumn: node.endPosition.column + 1 };
}

function importedName(node: SyntaxNode): { name: string; alias: string | null } | null {
  if (node.type === "aliased_import") {
    const name = node.childForFieldName("name")?.text.trim();
    return name ? { name, alias: node.childForFieldName("alias")?.text.trim() ?? null } : null;
  }
  const name = node.text.trim();
  return name ? { name, alias: null } : null;
}

async function portableFacts(files: ScannedFile[]): Promise<PythonKernelBatch> {
  const parser = await portableParser();
  const output: PythonKernelFacts[] = [];
  for (const file of files) {
    const tree = parser.parse(file.content);
    if (!tree) throw new Error(`PORTABLE_PYTHON_PARSE_FAILED: ${file.relativePath}`);
    const facts: PythonKernelFacts = { relativePath: file.relativePath, hasError: tree.rootNode.hasError, declarations: [], imports: [], inheritances: [], calls: [] };
    const visit = (node: SyntaxNode, names: string[], containerKind: string, ownerStartByte: number | null): void => {
      if (node.type === "decorated_definition") {
        const definition = node.namedChildren.at(-1);
        if (definition) visit(definition, names, containerKind, ownerStartByte);
        return;
      }
      let activeNames = names;
      let activeKind = containerKind;
      let activeOwner = ownerStartByte;
      if (node.type === "function_definition" || node.type === "class_definition") {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          const name = nameNode.text;
          const kind = node.type === "class_definition" ? "class" : containerKind === "class" ? "method" : "function";
          activeNames = [...names, name]; activeKind = kind; activeOwner = node.startIndex;
          const content = node.text;
          facts.declarations.push({ nativeKind: node.type, name, symbolPath: activeNames.join("."), containerKind: kind,
            containerStartByte: ownerStartByte, isAsync: node.namedChildren.some((child) => child.type === "async"),
            signature: (content.split(/:\s*(?:#.*)?\r?\n/, 1)[0] ?? content).slice(0, 1000), content, span: span(node) });
        }
      }
      if (node.type === "import_statement" || node.type === "import_from_statement") {
        const fromImport = node.type === "import_from_statement";
        const moduleNode = fromImport ? node.namedChildren[0] : null;
        const rawModule = fromImport ? (moduleNode?.text.trim() ?? "") : "";
        const importNodes = fromImport ? node.namedChildren.slice(1) : node.namedChildren;
        facts.imports.push({ fromImport, rawModule, names: importNodes.map(importedName).filter((item): item is NonNullable<typeof item> => item !== null), span: span(node), rawText: node.text });
      }
      if (node.type === "class_definition") for (const base of node.childForFieldName("superclasses")?.namedChildren ?? []) {
        facts.inheritances.push({ ownerStartByte: activeOwner, rawName: base.text, simpleIdentifier: base.type === "identifier", span: span(base) });
      }
      if (node.type === "call") {
        const callable = node.childForFieldName("function");
        if (callable) facts.calls.push({ ownerStartByte: activeOwner, rawName: callable.text, simpleIdentifier: callable.type === "identifier", span: span(callable) });
      }
      for (const child of node.namedChildren) visit(child, activeNames, activeKind, activeOwner);
    };
    visit(tree.rootNode, [], "module", null);
    tree.delete();
    output.push(facts);
  }
  return { files: output.sort((a, b) => a.relativePath.localeCompare(b.relativePath)), mode: "portable", providerVersion: "web-tree-sitter@0.26.11/tree-sitter-python@0.25.0", diagnostics: [], filesParsed: output.length };
}

function kernelExecutable(): string | null {
  const executable = `contextmesh-graph-kernel${process.platform === "win32" ? ".exe" : ""}`;
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  if (process.env.CONTEXTMESH_GRAPH_KERNEL_PATH) return existsSync(process.env.CONTEXTMESH_GRAPH_KERNEL_PATH) ? process.env.CONTEXTMESH_GRAPH_KERNEL_PATH : null;
  const candidates = [
    path.join(moduleDirectory, "native", executable),
    path.resolve(moduleDirectory, "..", "native", executable),
    path.resolve(moduleDirectory, "..", "native", "graph-kernel", "target", "debug", executable),
    path.resolve(moduleDirectory, "..", "..", "native", "graph-kernel", "target", "debug", executable),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find(existsSync) ?? null;
}

async function nativeFacts(files: ScannedFile[]): Promise<PythonKernelBatch> {
  const executable = kernelExecutable();
  if (!executable) throw new Error("KERNEL_UNAVAILABLE: graph-kernel executable not found");
  const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  let stderr = ""; child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const iterator = lines[Symbol.asyncIterator]();
  const request = async <T>(payload: Record<string, unknown>): Promise<KernelResponse<T>> => {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    const result = await iterator.next();
    if (result.done) throw new Error(`KERNEL_CRASHED: ${stderr.slice(0, 500)}`);
    const response = JSON.parse(result.value) as KernelResponse<T>;
    if (response.protocol !== GRAPH_KERNEL_PROTOCOL) throw new Error(`KERNEL_PROTOCOL_MISMATCH: ${response.protocol}`);
    if (response.status !== "ok") throw new Error(response.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; ") || "KERNEL_FAILED");
    return response;
  };
  try {
    const hello = await request<{ kernelVersion: string }>({ operation: "hello", requestId: "hello" });
    const extracted = await request<{ files: PythonKernelFacts[] }>({ operation: "extract_python", requestId: "extract", files: files.map((file) => ({ relativePath: file.relativePath, content: file.content })) });
    return { files: extracted.data.files, mode: "sidecar", providerVersion: `contextmesh-graph-kernel@${hello.data.kernelVersion}/tree-sitter-python@0.25.0`, diagnostics: extracted.diagnostics.map((item) => `${item.code}: ${item.message}`), filesParsed: extracted.data.files.length };
  } finally {
    child.stdin.end(); child.kill(); lines.close();
  }
}

const pythonFactCache = new Map<string, { contentHash: string; facts: PythonKernelFacts }>();

export async function extractPythonKernelFacts(files: ScannedFile[], policy: GraphKernelPolicy = (process.env.CONTEXTMESH_KERNEL_POLICY === "portable" ? "portable" : "native-required"), bypassCache = false): Promise<PythonKernelBatch> {
  const keyed = files.map((file) => ({ file, key: `${policy}\0${file.absolutePath}` }));
  const stale = bypassCache ? files : keyed.filter(({ file, key }) => pythonFactCache.get(key)?.contentHash !== file.contentHash).map(({ file }) => file);
  const extracted = policy === "portable" ? await portableFacts(stale) : await nativeFacts(stale);
  for (const facts of extracted.files) {
    const file = stale.find((item) => item.relativePath === facts.relativePath);
    if (file) pythonFactCache.set(`${policy}\0${file.absolutePath}`, { contentHash: file.contentHash, facts });
  }
  const output = keyed.map(({ file, key }) => pythonFactCache.get(key)?.facts ?? extracted.files.find((item) => item.relativePath === file.relativePath));
  if (output.some((item) => !item)) throw new Error("KERNEL_INCOMPLETE_CACHE: a requested Python fact batch is missing");
  return { ...extracted, files: output.filter((item): item is PythonKernelFacts => Boolean(item)).sort((a, b) => a.relativePath.localeCompare(b.relativePath)), filesParsed: stale.length };
}

export function graphKernelExecutablePath(): string | null { return kernelExecutable(); }

export async function probeTypeScriptTreeSitter(content: string): Promise<{ declarations: number; imports: number; calls: number; nodes: number; hasError: boolean; rssBytes: number }> {
  const executable = kernelExecutable();
  if (!executable) throw new Error("KERNEL_UNAVAILABLE: graph-kernel executable not found");
  const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  try {
    child.stdin.write(`${JSON.stringify({ operation: "probe_typescript", requestId: "ts-probe", content })}\n`);
    const next = await lines[Symbol.asyncIterator]().next();
    if (next.done) throw new Error("KERNEL_CRASHED: TypeScript probe returned no response");
    const response = JSON.parse(next.value) as KernelResponse<{ declarations: number; imports: number; calls: number; nodes: number; hasError: boolean; rssBytes: number }>;
    if (response.protocol !== GRAPH_KERNEL_PROTOCOL || response.status !== "ok") throw new Error(response.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; "));
    return response.data;
  } finally { lines.close(); child.stdin.end(); child.kill(); }
}
