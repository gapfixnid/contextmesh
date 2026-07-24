import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";

import { z } from "zod";
import { Language, Parser, type Node as SyntaxNode } from "web-tree-sitter";

import type { ScannedFile } from "./scanner.js";

export const GRAPH_KERNEL_PROTOCOL = "contextmesh.graph-kernel/v1";
export const GRAPH_KERNEL_VERSION = "0.7.0";
export type GraphKernelPolicy = "native-required" | "portable";

const DEFAULT_KERNEL_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const PYTHON_FACT_CACHE_CAPACITY = 4_096;

export interface GraphKernelLaunch {
  executable: string;
  args?: string[];
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface KernelSpan {
  startByte: number;
  endByte: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface KernelDeclaration {
  nativeKind: string;
  name: string;
  symbolPath: string;
  containerKind: "function" | "class" | "method";
  containerStartByte: number | null;
  isAsync: boolean;
  signature: string;
  content: string;
  span: KernelSpan;
}

export interface KernelImport {
  fromImport: boolean;
  rawModule: string;
  names: Array<{ name: string; alias: string | null }>;
  span: KernelSpan;
  rawText: string;
}

export interface KernelReference {
  ownerStartByte: number | null;
  rawName: string;
  simpleIdentifier: boolean;
  span: KernelSpan;
}

export interface PythonKernelFacts {
  relativePath: string;
  hasError: boolean;
  declarations: KernelDeclaration[];
  imports: KernelImport[];
  inheritances: KernelReference[];
  calls: KernelReference[];
}

export interface PythonKernelBatch {
  files: PythonKernelFacts[];
  mode: "sidecar" | "portable";
  providerVersion: string;
  diagnostics: string[];
  filesParsed: number;
  kernelRssBytes: number;
}

interface KernelDiagnostic {
  code: string;
  severity: string;
  message: string;
  path?: string | undefined;
}

const diagnosticSchema = z.object({
  code: z.string().min(1).max(200),
  severity: z.string().min(1).max(40),
  message: z.string().max(4_000),
  path: z.string().max(4_000).optional(),
});

const responseSchema = z.object({
  protocol: z.string(),
  requestId: z.string(),
  status: z.string(),
  data: z.unknown(),
  diagnostics: z.array(diagnosticSchema).max(10_000),
});

const spanSchema = z.object({
  startByte: z.number().int().nonnegative(),
  endByte: z.number().int().nonnegative(),
  startLine: z.number().int().positive(),
  startColumn: z.number().int().positive(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().positive(),
});

const declarationSchema = z.object({
  nativeKind: z.string().min(1).max(200),
  name: z.string().max(1_000),
  symbolPath: z.string().max(4_000),
  containerKind: z.enum(["function", "class", "method"]),
  containerStartByte: z.number().int().nonnegative().nullable(),
  isAsync: z.boolean(),
  signature: z.string().max(1_000_000),
  content: z.string().max(16_000_000),
  span: spanSchema,
});

const importSchema = z.object({
  fromImport: z.boolean(),
  rawModule: z.string().max(4_000),
  names: z.array(z.object({ name: z.string().max(4_000), alias: z.string().max(4_000).nullable() })).max(100_000),
  span: spanSchema,
  rawText: z.string().max(1_000_000),
});

const referenceSchema = z.object({
  ownerStartByte: z.number().int().nonnegative().nullable(),
  rawName: z.string().max(1_000_000),
  simpleIdentifier: z.boolean(),
  span: spanSchema,
});

const pythonFactsSchema = z.object({
  relativePath: z.string().min(1).max(4_000),
  hasError: z.boolean(),
  declarations: z.array(declarationSchema).max(1_000_000),
  imports: z.array(importSchema).max(1_000_000),
  inheritances: z.array(referenceSchema).max(1_000_000),
  calls: z.array(referenceSchema).max(1_000_000),
});

const helloSchema = z.object({
  kernelVersion: z.string().min(1).max(100),
  grammarRegistry: z.array(z.object({
    language: z.string().min(1).max(100),
    provider: z.string().min(1).max(200),
    version: z.string().min(1).max(100),
  })).max(100),
});
export type GraphKernelHello = z.infer<typeof helloSchema>;
let lastObservedKernelVersion: string | null = null;

export function validateGraphKernelHello(data: unknown, prefix = "KERNEL"): GraphKernelHello {
  const parsed = helloSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`${prefix}_PROTOCOL_INVALID: hello data schema mismatch (${parsed.error.message.slice(0, 1_000)})`);
  }
  if (parsed.data.kernelVersion !== GRAPH_KERNEL_VERSION) {
    throw new Error(`${prefix}_VERSION_MISMATCH: expected ${GRAPH_KERNEL_VERSION}, received ${parsed.data.kernelVersion}`);
  }
  lastObservedKernelVersion = parsed.data.kernelVersion;
  return parsed.data;
}

export function observedGraphKernelVersion(): string | null {
  return lastObservedKernelVersion;
}

const pythonBatchSchema = z.object({
  files: z.array(pythonFactsSchema).max(100_000),
  rssBytes: z.number().int().nonnegative(),
});

const typeScriptProbeSchema = z.object({
  declarations: z.number().int().nonnegative(),
  imports: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
  nodes: z.number().int().nonnegative(),
  hasError: z.boolean(),
  rssBytes: z.number().int().nonnegative(),
  declarationNames: z.array(z.string().max(4_000)).max(1_000_000),
  importSpecifiers: z.array(z.string().max(4_000)).max(1_000_000),
  callNames: z.array(z.string().max(4_000)).max(1_000_000),
});

const require = createRequire(import.meta.url);
let portableParserPromise: Promise<Parser> | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedEnvironmentInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`KERNEL_CONFIGURATION_INVALID: ${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function configuredKernelArgs(): string[] {
  const source = process.env.CONTEXTMESH_GRAPH_KERNEL_ARGS_JSON;
  if (!source) return [];
  try {
    const value = JSON.parse(source) as unknown;
    if (!Array.isArray(value) || value.length > 16 || value.some((item) => typeof item !== "string" || item.length > 4_000)) {
      throw new Error("expected an array of at most 16 bounded strings");
    }
    return value;
  } catch (error) {
    throw new Error(`KERNEL_CONFIGURATION_INVALID: CONTEXTMESH_GRAPH_KERNEL_ARGS_JSON (${errorMessage(error)})`);
  }
}

async function portableParser(): Promise<Parser> {
  if (!portableParserPromise) {
    portableParserPromise = (async () => {
      const runtimeDirectory = path.dirname(require.resolve("web-tree-sitter"));
      await Parser.init({ locateFile: (file: string) => path.join(runtimeDirectory, file) });
      const grammarDirectory = path.dirname(require.resolve("tree-sitter-python/package.json"));
      const language = await Language.load(path.join(grammarDirectory, "tree-sitter-python.wasm"));
      return new Parser().setLanguage(language);
    })();
  }
  return portableParserPromise;
}

function span(node: SyntaxNode): KernelSpan {
  return {
    startByte: node.startIndex,
    endByte: node.endIndex,
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column + 1,
  };
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
    const facts: PythonKernelFacts = {
      relativePath: file.relativePath,
      hasError: tree.rootNode.hasError,
      declarations: [],
      imports: [],
      inheritances: [],
      calls: [],
    };
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
          activeNames = [...names, name];
          activeKind = kind;
          activeOwner = node.startIndex;
          const content = node.text;
          facts.declarations.push({
            nativeKind: node.type,
            name,
            symbolPath: activeNames.join("."),
            containerKind: kind,
            containerStartByte: ownerStartByte,
            isAsync: content.trimStart().startsWith("async "),
            signature: (content.split(/:\s*(?:#.*)?\r?\n/, 1)[0] ?? content).slice(0, 1_000),
            content,
            span: span(node),
          });
        }
      }
      if (node.type === "import_statement" || node.type === "import_from_statement") {
        const fromImport = node.type === "import_from_statement";
        const moduleNode = fromImport ? node.namedChildren[0] : null;
        const rawModule = fromImport ? (moduleNode?.text.trim() ?? "") : "";
        const importNodes = fromImport ? node.namedChildren.slice(1) : node.namedChildren;
        facts.imports.push({
          fromImport,
          rawModule,
          names: importNodes.map(importedName).filter((item): item is NonNullable<typeof item> => item !== null),
          span: span(node),
          rawText: node.text,
        });
      }
      if (node.type === "class_definition") {
        for (const base of node.childForFieldName("superclasses")?.namedChildren ?? []) {
          facts.inheritances.push({
            ownerStartByte: activeOwner,
            rawName: base.text,
            simpleIdentifier: base.type === "identifier",
            span: span(base),
          });
        }
      }
      if (node.type === "call") {
        const callable = node.childForFieldName("function");
        if (callable) {
          facts.calls.push({
            ownerStartByte: activeOwner,
            rawName: callable.text,
            simpleIdentifier: callable.type === "identifier",
            span: span(callable),
          });
        }
      }
      for (const child of node.namedChildren) visit(child, activeNames, activeKind, activeOwner);
    };
    visit(tree.rootNode, [], "module", null);
    tree.delete();
    output.push(facts);
  }
  return {
    files: output.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    mode: "portable",
    providerVersion: "web-tree-sitter@0.26.11/tree-sitter-python@0.25.0",
    diagnostics: [],
    filesParsed: output.length,
    kernelRssBytes: process.memoryUsage().rss,
  };
}

function kernelExecutable(): string | null {
  const executable = `contextmesh-graph-kernel${process.platform === "win32" ? ".exe" : ""}`;
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  if (process.env.CONTEXTMESH_GRAPH_KERNEL_PATH) {
    return existsSync(process.env.CONTEXTMESH_GRAPH_KERNEL_PATH) ? process.env.CONTEXTMESH_GRAPH_KERNEL_PATH : null;
  }
  const candidates = [
    path.join(moduleDirectory, "native", executable),
    path.resolve(moduleDirectory, "..", "native", executable),
    path.resolve(moduleDirectory, "..", "native", "graph-kernel", "target", "debug", executable),
    path.resolve(moduleDirectory, "..", "..", "native", "graph-kernel", "target", "debug", executable),
  ];
  return candidates.find(existsSync) ?? null;
}

export function graphKernelLaunchSpec(): GraphKernelLaunch | null {
  const executable = kernelExecutable();
  if (!executable) return null;
  return {
    executable,
    args: configuredKernelArgs(),
    timeoutMs: boundedEnvironmentInteger("CONTEXTMESH_GRAPH_KERNEL_TIMEOUT_MS", DEFAULT_KERNEL_TIMEOUT_MS, 100, 120_000),
    maxResponseBytes: boundedEnvironmentInteger(
      "CONTEXTMESH_GRAPH_KERNEL_MAX_RESPONSE_BYTES",
      DEFAULT_MAX_RESPONSE_BYTES,
      1_024,
      512 * 1024 * 1024,
    ),
  };
}

type KernelWaitOutcome =
  | { type: "line"; result: IteratorResult<string> }
  | { type: "terminal"; error: Error }
  | { type: "timeout" };

class KernelSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private readonly iterator: AsyncIterator<string>;
  private readonly terminal: Promise<KernelWaitOutcome>;
  private stderr = "";
  private responseBytes = 0;
  private closed = false;

  constructor(private readonly launch: Required<Pick<GraphKernelLaunch, "executable" | "args" | "timeoutMs" | "maxResponseBytes">>) {
    try {
      this.child = spawn(launch.executable, launch.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      throw new Error(`KERNEL_SPAWN_FAILED: ${errorMessage(error)}`);
    }
    this.lines = createInterface({ input: this.child.stdout });
    this.iterator = this.lines[Symbol.asyncIterator]();
    let resolveTerminal!: (value: KernelWaitOutcome) => void;
    this.terminal = new Promise<KernelWaitOutcome>((resolve) => { resolveTerminal = resolve; });
    let terminal = false;
    const fail = (error: Error): void => {
      if (terminal) return;
      terminal = true;
      resolveTerminal({ type: "terminal", error });
    };
    this.child.once("error", (error) => fail(new Error(`KERNEL_SPAWN_FAILED: ${error.message}`)));
    this.child.once("exit", (code, signal) => fail(new Error(
      `KERNEL_CRASHED: exit=${code ?? "null"} signal=${signal ?? "none"}${this.stderr ? ` stderr=${this.stderr.slice(0, 500)}` : ""}`,
    )));
    this.child.stdin.on("error", (error) => fail(new Error(`KERNEL_WRITE_FAILED: ${error.message}`)));
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderr += chunk.toString("utf8"); });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.responseBytes += chunk.byteLength;
      if (this.responseBytes > this.launch.maxResponseBytes) {
        fail(new Error(`KERNEL_RESPONSE_TOO_LARGE: exceeded ${this.launch.maxResponseBytes} bytes`));
        this.child.kill();
      }
    });
  }

  async request<T>(payload: Record<string, unknown>, dataSchema: z.ZodType<T>): Promise<{ data: T; diagnostics: KernelDiagnostic[] }> {
    if (this.closed) throw new Error("KERNEL_SESSION_CLOSED: request attempted after close");
    const requestId = typeof payload.requestId === "string" ? payload.requestId : "invalid";
    const operation = async (): Promise<KernelWaitOutcome> => {
      await new Promise<void>((resolve, reject) => {
        this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
          if (error) reject(new Error(`KERNEL_WRITE_FAILED: ${error.message}`));
          else resolve();
        });
      });
      return { type: "line", result: await this.iterator.next() };
    };
    let timeoutHandle: NodeJS.Timeout | null = null;
    const timeout = new Promise<KernelWaitOutcome>((resolve) => {
      timeoutHandle = setTimeout(() => resolve({ type: "timeout" }), this.launch.timeoutMs);
    });
    let outcome: KernelWaitOutcome;
    try {
      outcome = await Promise.race([operation(), this.terminal, timeout]);
    } catch (error) {
      throw error instanceof Error && error.message.startsWith("KERNEL_")
        ? error
        : new Error(`KERNEL_REQUEST_FAILED: ${errorMessage(error)}`);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
    if (outcome.type === "timeout") {
      this.child.kill();
      throw new Error(`KERNEL_TIMEOUT: request ${requestId} exceeded ${this.launch.timeoutMs}ms`);
    }
    if (outcome.type === "terminal") throw outcome.error;
    if (outcome.result.done) throw new Error(`KERNEL_CRASHED: request ${requestId} returned no response`);

    let parsed: z.infer<typeof responseSchema>;
    try {
      parsed = responseSchema.parse(JSON.parse(outcome.result.value) as unknown);
    } catch (error) {
      throw new Error(`KERNEL_PROTOCOL_INVALID: request ${requestId} returned invalid JSON/schema (${errorMessage(error)})`);
    }
    if (parsed.protocol !== GRAPH_KERNEL_PROTOCOL) {
      throw new Error(`KERNEL_PROTOCOL_MISMATCH: expected ${GRAPH_KERNEL_PROTOCOL}, received ${parsed.protocol}`);
    }
    if (parsed.requestId !== requestId) {
      throw new Error(`KERNEL_REQUEST_ID_MISMATCH: expected ${requestId}, received ${parsed.requestId}`);
    }
    if (parsed.status !== "ok") {
      const details = parsed.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; ");
      throw new Error(`KERNEL_REQUEST_FAILED: ${details || `request ${requestId} returned ${parsed.status}`}`);
    }
    const data = dataSchema.safeParse(parsed.data);
    if (!data.success) {
      throw new Error(`KERNEL_PROTOCOL_INVALID: request ${requestId} data schema mismatch (${data.error.message.slice(0, 1_000)})`);
    }
    return { data: data.data, diagnostics: parsed.diagnostics };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
    await Promise.race([
      this.terminal.then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }
}

function resolveLaunch(override?: GraphKernelLaunch): Required<Pick<GraphKernelLaunch, "executable" | "args" | "timeoutMs" | "maxResponseBytes">> {
  const configured = override ?? graphKernelLaunchSpec();
  if (!configured) throw new Error("KERNEL_UNAVAILABLE: graph-kernel executable not found");
  return {
    executable: configured.executable,
    args: configured.args ?? [],
    timeoutMs: configured.timeoutMs ?? DEFAULT_KERNEL_TIMEOUT_MS,
    maxResponseBytes: configured.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
  };
}

async function nativeFacts(files: ScannedFile[], launchOverride?: GraphKernelLaunch): Promise<PythonKernelBatch> {
  const session = new KernelSession(resolveLaunch(launchOverride));
  try {
    const hello = await session.request({ operation: "hello", requestId: "hello" }, helloSchema);
    const helloData = validateGraphKernelHello(hello.data);
    const pythonGrammar = helloData.grammarRegistry.find((grammar) => grammar.language === "python");
    if (pythonGrammar?.provider !== "tree-sitter-python" || pythonGrammar.version !== "0.25.0") {
      throw new Error("KERNEL_GRAMMAR_MISMATCH: expected tree-sitter-python@0.25.0");
    }
    const extracted = await session.request({
      operation: "extract_python",
      requestId: "extract",
      files: files.map((file) => ({ relativePath: file.relativePath, content: file.content })),
    }, pythonBatchSchema);
    const expectedPaths = files.map((file) => file.relativePath).sort((a, b) => a.localeCompare(b));
    const actualPaths = extracted.data.files.map((file) => file.relativePath);
    if (new Set(actualPaths).size !== actualPaths.length || JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
      throw new Error("KERNEL_INCOMPLETE_BATCH: response paths were missing, duplicated, extra, or non-deterministically ordered");
    }
    return {
      files: extracted.data.files,
      mode: "sidecar",
      providerVersion: `contextmesh-graph-kernel@${helloData.kernelVersion}/tree-sitter-python@0.25.0`,
      diagnostics: extracted.diagnostics.map((item) => `${item.code}: ${item.message}`),
      filesParsed: extracted.data.files.length,
      kernelRssBytes: extracted.data.rssBytes,
    };
  } finally {
    await session.close();
  }
}

interface PythonFactCacheEntry {
  contentHash: string;
  facts: PythonKernelFacts;
}

const pythonFactCache = new Map<string, PythonFactCacheEntry>();

function getCachedFact(key: string): PythonFactCacheEntry | undefined {
  const value = pythonFactCache.get(key);
  if (!value) return undefined;
  pythonFactCache.delete(key);
  pythonFactCache.set(key, value);
  return value;
}

function putCachedFact(key: string, value: PythonFactCacheEntry): void {
  pythonFactCache.delete(key);
  pythonFactCache.set(key, value);
  while (pythonFactCache.size > PYTHON_FACT_CACHE_CAPACITY) {
    const oldest = pythonFactCache.keys().next().value as string | undefined;
    if (!oldest) break;
    pythonFactCache.delete(oldest);
  }
}

export async function extractPythonKernelFacts(
  files: ScannedFile[],
  policy: GraphKernelPolicy = process.env.CONTEXTMESH_KERNEL_POLICY === "portable" ? "portable" : "native-required",
  bypassCache = false,
  launchOverride?: GraphKernelLaunch,
): Promise<PythonKernelBatch> {
  const keyed = files.map((file) => ({ file, key: `${policy}\0${file.absolutePath}` }));
  const stale = bypassCache
    ? files
    : keyed.filter(({ file, key }) => getCachedFact(key)?.contentHash !== file.contentHash).map(({ file }) => file);
  const extracted = stale.length === 0
    ? {
        files: [],
        mode: policy === "portable" ? "portable" as const : "sidecar" as const,
        providerVersion: policy === "portable"
          ? "web-tree-sitter@0.26.11/tree-sitter-python@0.25.0"
          : `contextmesh-graph-kernel@${observedGraphKernelVersion() ?? GRAPH_KERNEL_VERSION}/tree-sitter-python@0.25.0`,
        diagnostics: [],
        filesParsed: 0,
        kernelRssBytes: 0,
      }
    : policy === "portable"
      ? await portableFacts(stale)
      : await nativeFacts(stale, launchOverride);
  for (const facts of extracted.files) {
    const file = stale.find((item) => item.relativePath === facts.relativePath);
    if (file) putCachedFact(`${policy}\0${file.absolutePath}`, { contentHash: file.contentHash, facts });
  }
  const output = keyed.map(({ file, key }) => getCachedFact(key)?.facts
    ?? extracted.files.find((item) => item.relativePath === file.relativePath));
  if (output.some((item) => !item)) throw new Error("KERNEL_INCOMPLETE_CACHE: a requested Python fact batch is missing");
  return {
    ...extracted,
    files: output.filter((item): item is PythonKernelFacts => Boolean(item))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    filesParsed: stale.length,
  };
}

export function graphKernelExecutablePath(): string | null {
  return kernelExecutable();
}

export async function probeTypeScriptTreeSitter(
  content: string,
  launchOverride?: GraphKernelLaunch,
): Promise<z.infer<typeof typeScriptProbeSchema>> {
  const session = new KernelSession(resolveLaunch(launchOverride));
  try {
    const hello = await session.request({ operation: "hello", requestId: "hello" }, helloSchema);
    const helloData = validateGraphKernelHello(hello.data);
    const grammar = helloData.grammarRegistry.find((item) => item.language === "typescript-benchmark-only");
    if (grammar?.provider !== "tree-sitter-typescript" || grammar.version !== "0.23.2") {
      throw new Error("KERNEL_GRAMMAR_MISMATCH: expected tree-sitter-typescript@0.23.2");
    }
    return (await session.request({ operation: "probe_typescript", requestId: "ts-probe", content }, typeScriptProbeSchema)).data;
  } finally {
    await session.close();
  }
}
