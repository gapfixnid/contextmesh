import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { CodeNodeRecord, IndexedSourceFile } from "../../contracts.js";
import type { OverlayPrecisionProvider, PrecisionOverlayBatch, ProjectDescriptor, SyntaxGraphBatch } from "../providers.js";

const PROBE_TIMEOUT_MS = 5_000;
const LSP_REQUEST_TIMEOUT_MS = 15_000;
const MAX_LSP_MESSAGE_BYTES = 16 * 1024 * 1024;

interface CommandSpec { executable: string; args: string[] }

function configuredCommand(): CommandSpec {
  const executable = process.env.CONTEXTMESH_RUST_ANALYZER_COMMAND?.trim() || "rust-analyzer";
  const source = process.env.CONTEXTMESH_RUST_ANALYZER_ARGS_JSON;
  if (!source) return { executable, args: [] };
  let value: unknown;
  try { value = JSON.parse(source); }
  catch (error) { throw new Error(`RUST_ANALYZER_CONFIGURATION_INVALID: ${error instanceof Error ? error.message : String(error)}`); }
  if (!Array.isArray(value) || value.length > 16 || value.some((item) => typeof item !== "string" || item.length > 4_000)) {
    throw new Error("RUST_ANALYZER_CONFIGURATION_INVALID: arguments must be an array of at most 16 bounded strings");
  }
  return { executable, args: value as string[] };
}

function runProbe(command: CommandSpec): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(command.executable, [...command.args, "--version"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { reject(error); return; }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => { child.kill(); finish(-1); }, PROBE_TIMEOUT_MS);
    timer.unref();
    child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); if (stdout.length > 1_000_000) child.kill(); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); if (stderr.length > 1_000_000) child.kill(); });
    child.once("error", reject);
    child.once("exit", (code) => finish(code ?? -1));
  });
}

export async function probeRustAnalyzerRuntime(): Promise<{ version: string }> {
  const result = await runProbe(configuredCommand());
  const version = (result.stdout || result.stderr).trim().split(/\r?\n/, 1)[0] ?? "";
  if (result.code !== 0) {
    throw new Error(`RUST_ANALYZER_UNAVAILABLE: ${version || `probe exited ${result.code}`}`);
  }
  if (!/^rust-analyzer \d+\.\d+\.\d+ \([0-9a-f]{8,} \d{4}-\d{2}-\d{2}\)$/.test(version)) {
    throw new Error(`RUST_ANALYZER_IDENTITY_INVALID: ${version || "empty version"}`);
  }
  return { version };
}

class JsonRpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private terminalError: Error | null = null;
  private stderr = "";
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  readonly diagnostics: string[] = [];

  constructor(command: CommandSpec) {
    this.child = spawn(command.executable, command.args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString("utf8");
      if (this.stderr.length > 1_000_000) this.stderr = this.stderr.slice(-1_000_000);
    });
    this.child.once("error", (error) => this.terminate(new Error(`RUST_ANALYZER_SPAWN_FAILED: ${error.message}`)));
    this.child.once("exit", (code, signal) => this.terminate(new Error(
      `RUST_ANALYZER_EXITED: exit=${code ?? "null"} signal=${signal ?? "none"}${this.stderr ? ` stderr=${this.stderr.slice(0, 1_000)}` : ""}`,
    )));
    this.child.stdin.on("error", (error) => this.terminate(new Error(`RUST_ANALYZER_WRITE_FAILED: ${error.message}`)));
  }

  private terminate(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_LSP_MESSAGE_BYTES) {
      this.terminate(new Error("RUST_ANALYZER_PROTOCOL_INVALID: response buffer exceeded 16 MiB"));
      this.child.kill();
      return;
    }
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const length = Number(header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i)?.[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_LSP_MESSAGE_BYTES) {
        this.terminate(new Error("RUST_ANALYZER_PROTOCOL_INVALID: malformed Content-Length"));
        this.child.kill();
        return;
      }
      const messageEnd = headerEnd + 4 + length;
      if (this.buffer.length < messageEnd) return;
      const body = this.buffer.subarray(headerEnd + 4, messageEnd).toString("utf8");
      this.buffer = this.buffer.subarray(messageEnd);
      let message: unknown;
      try { message = JSON.parse(body); }
      catch { this.terminate(new Error("RUST_ANALYZER_PROTOCOL_INVALID: malformed JSON")); this.child.kill(); return; }
      this.dispatch(message);
    }
  }

  private dispatch(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const message = value as { id?: unknown; method?: unknown; result?: unknown; error?: { message?: unknown }; params?: unknown };
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`RUST_ANALYZER_REQUEST_FAILED: ${String(message.error.message ?? "unknown error")}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "textDocument/publishDiagnostics") {
      const diagnostics = (message.params as { diagnostics?: Array<{ message?: unknown }> } | undefined)?.diagnostics;
      for (const diagnostic of diagnostics?.slice(0, 1_000) ?? []) {
        if (typeof diagnostic.message === "string") this.diagnostics.push(diagnostic.message.slice(0, 4_000));
      }
    }
  }

  private write(value: unknown): Promise<void> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    const body = Buffer.from(JSON.stringify(value), "utf8");
    if (body.length > MAX_LSP_MESSAGE_BYTES) return Promise.reject(new Error("RUST_ANALYZER_REQUEST_TOO_LARGE"));
    const packet = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
    return new Promise((resolve, reject) => this.child.stdin.write(packet, (error) => error ? reject(error) : resolve()));
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.child.kill();
        reject(new Error(`RUST_ANALYZER_TIMEOUT: ${method} exceeded ${LSP_REQUEST_TIMEOUT_MS}ms`));
      }, LSP_REQUEST_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ jsonrpc: "2.0", id, method, params }).catch((error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  notify(method: string, params: unknown): Promise<void> {
    return this.write({ jsonrpc: "2.0", method, params });
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    try { await this.request("shutdown", null); } catch { /* best-effort shutdown after an earlier failure */ }
    try { await this.notify("exit", null); } catch { /* process may already have exited */ }
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    this.child.stdin.end();
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill();
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
    }
  }
}

interface DefinitionLocation { uri: string; line: number; character: number }

function definitionLocations(value: unknown): DefinitionLocation[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  if (values.length > 100) throw new Error("RUST_ANALYZER_PROTOCOL_INVALID: too many definition locations");
  const output: DefinitionLocation[] = [];
  for (const item of values) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as {
      uri?: unknown;
      targetUri?: unknown;
      range?: { start?: { line?: unknown; character?: unknown } };
      targetSelectionRange?: { start?: { line?: unknown; character?: unknown } };
    };
    const uri = typeof candidate.uri === "string" ? candidate.uri : typeof candidate.targetUri === "string" ? candidate.targetUri : null;
    const start = candidate.range?.start ?? candidate.targetSelectionRange?.start;
    if (!uri || !Number.isSafeInteger(start?.line) || !Number.isSafeInteger(start?.character)) continue;
    output.push({ uri, line: Number(start!.line), character: Number(start!.character) });
  }
  return output;
}

function relativeUri(rootPath: string, uri: string): string | null {
  let absolute: string;
  try { absolute = fileURLToPath(uri); } catch { return null; }
  const relative = path.relative(rootPath, absolute).replaceAll("\\", "/");
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return null;
  return process.platform === "win32" ? relative.toLocaleLowerCase("en-US") : relative;
}

function containsPosition(node: CodeNodeRecord, line: number, character: number): boolean {
  const startLine = node.startLine - 1;
  const endLine = node.endLine - 1;
  if (line < startLine || line > endLine) return false;
  if (line === startLine && character < node.startColumn - 1) return false;
  if (line === endLine && character > node.endColumn - 1) return false;
  return true;
}

interface DefinitionQuery {
  sourceId: string;
  rawName: string;
  file: IndexedSourceFile;
  line: number;
  character: number;
}

export class RustAnalyzerProvider implements OverlayPrecisionProvider {
  readonly id = "rust_analyzer";
  readonly version = "rust-analyzer-lsp-v1";
  readonly capability = "resolved" as const;
  private readonly rootPath: string;

  constructor(project: ProjectDescriptor) {
    this.rootPath = (project.runtime as { rootPath?: string } | undefined)?.rootPath ?? process.cwd();
  }

  async available(): Promise<{ available: boolean; diagnostic?: string }> {
    if (process.env.CONTEXTMESH_RUST_ANALYZER_DISABLE === "1") return { available: false, diagnostic: "rust-analyzer disabled by policy" };
    try {
      const result = await runProbe(configuredCommand());
      if (result.code === 0) {
        const diagnostic = (result.stdout || result.stderr).trim().slice(0, 1_000);
        return diagnostic ? { available: true, diagnostic } : { available: true };
      }
      return { available: false, diagnostic: result.stderr.trim().slice(0, 1_000) || `rust-analyzer --version exited ${result.code}` };
    } catch (error) {
      return { available: false, diagnostic: error instanceof Error ? error.message : String(error) };
    }
  }

  async analyze(batch: SyntaxGraphBatch, baseGeneration: number): Promise<PrecisionOverlayBatch> {
    const rustFiles = batch.files.filter((file) => file.language === "rust");
    const rustNodes = batch.nodes.filter((node) => node.language === "rust");
    const nodeById = new Map(rustNodes.map((node) => [node.id, node]));
    const fileById = new Map(rustFiles.map((file) => [file.id, file]));
    const queries = new Map<string, DefinitionQuery>();
    for (const edge of batch.edges) {
      if (edge.kind !== "CALLS" || edge.status !== "candidate") continue;
      const source = nodeById.get(edge.sourceId);
      const file = source?.fileId ? fileById.get(source.fileId) : undefined;
      const span = edge.evidence?.find((item) => item.sourceSpan)?.sourceSpan;
      if (!source || !file || !span) continue;
      const rawName = typeof edge.metadata.rawName === "string" ? edge.metadata.rawName : nodeById.get(edge.targetId)?.name;
      if (!rawName) continue;
      queries.set(`${file.pathKey}\0${span.startByte}\0${source.id}\0${rawName}`, {
        sourceId: source.id, rawName, file, line: span.line - 1, character: span.column - 1,
      });
    }
    for (const reference of batch.unresolvedReferences) {
      if (reference.kind !== "CALLS" || !reference.sourceNodeId || !nodeById.has(reference.sourceNodeId)) continue;
      const file = fileById.get(reference.fileId);
      if (!file) continue;
      queries.set(`${file.pathKey}\0${reference.line}\0${reference.column}\0${reference.sourceNodeId}\0${reference.rawName}`, {
        sourceId: reference.sourceNodeId, rawName: reference.rawName, file,
        line: reference.line - 1, character: reference.column - 1,
      });
    }
    if (queries.size > 20_000) throw new Error("RUST_ANALYZER_QUERY_LIMIT: more than 20,000 call sites");

    const client = new JsonRpcClient(configuredCommand());
    const diagnostics: string[] = [];
    const overlays = new Map<string, PrecisionOverlayBatch["edges"][number]>();
    const edgeKey = (edge: Pick<PrecisionOverlayBatch["edges"][number], "sourceId" | "targetId" | "kind">): string =>
      `${edge.sourceId}\0${edge.targetId}\0${edge.kind}`;
    try {
      await client.request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(this.rootPath).href,
        capabilities: {},
        workspaceFolders: [{ uri: pathToFileURL(this.rootPath).href, name: path.basename(this.rootPath) }],
      });
      await client.notify("initialized", {});
      for (const file of rustFiles) {
        await client.notify("textDocument/didOpen", {
          textDocument: { uri: pathToFileURL(file.absolutePath).href, languageId: "rust", version: 1, text: file.content },
        });
      }
      const nodesByPath = new Map<string, CodeNodeRecord[]>();
      for (const node of rustNodes) {
        const file = node.fileId ? fileById.get(node.fileId) : undefined;
        if (!file) continue;
        const key = process.platform === "win32" ? file.relativePath.toLocaleLowerCase("en-US") : file.relativePath;
        const values = nodesByPath.get(key) ?? []; values.push(node); nodesByPath.set(key, values);
      }
      let workspaceReady = false;
      for (const query of queries.values()) {
        let response: unknown;
        try {
          response = await client.request("textDocument/definition", {
            textDocument: { uri: pathToFileURL(query.file.absolutePath).href },
            position: { line: query.line, character: query.character },
          });
          let locations = definitionLocations(response);
          for (let attempt = 0; !workspaceReady && locations.length === 0 && attempt < 10; attempt += 1) {
            await new Promise<void>((resolve) => setTimeout(resolve, 250));
            response = await client.request("textDocument/definition", {
              textDocument: { uri: pathToFileURL(query.file.absolutePath).href },
              position: { line: query.line, character: query.character },
            });
            locations = definitionLocations(response);
          }
          if (locations.length > 0) workspaceReady = true;
        } catch (error) {
          diagnostics.push(error instanceof Error ? error.message : String(error));
          continue;
        }
        const targets = new Map<string, CodeNodeRecord>();
        for (const location of definitionLocations(response)) {
          const pathKey = relativeUri(this.rootPath, location.uri);
          if (!pathKey) continue;
          const matches = (nodesByPath.get(pathKey) ?? [])
            .filter((node) => containsPosition(node, location.line, location.character))
            .sort((left, right) => (left.endByte - left.startByte) - (right.endByte - right.startByte) || left.id.localeCompare(right.id));
          if (matches[0]) targets.set(matches[0].id, matches[0]);
        }
        if (targets.size !== 1) continue;
        const target = [...targets.values()][0]!;
        const resolved = {
          sourceId: query.sourceId, targetId: target.id, kind: "CALLS" as const, status: "resolved" as const,
          confidence: 1, resolutionKind: target.fileId === nodeById.get(query.sourceId)?.fileId ? "local" as const : "import" as const,
          evidence: [{ provider: this.id, providerVersion: this.version, source: "language_server" as const, confidence: 1,
            details: { rawName: query.rawName, definition: target.qualifiedName } }],
        };
        overlays.set(edgeKey(resolved), resolved);
        for (const candidate of batch.edges.filter((edge) => edge.kind === "CALLS" && edge.status === "candidate"
          && edge.sourceId === query.sourceId && edge.targetId !== target.id && edge.evidence?.some((item) =>
            item.source === "syntax" && item.sourceSpan?.line === query.line + 1 &&
            item.sourceSpan.column === query.character + 1))) {
          const rejected = {
            sourceId: candidate.sourceId, targetId: candidate.targetId, kind: candidate.kind, status: "rejected" as const,
            confidence: 1, resolutionKind: candidate.resolutionKind,
            evidence: [{ provider: this.id, providerVersion: this.version, source: "language_server" as const, confidence: 1,
              details: { reason: "rust_analyzer_selected_different_target", selectedTargetId: target.id } }],
          };
          overlays.set(edgeKey(rejected), rejected);
        }
      }
      diagnostics.push(...client.diagnostics);
    } finally {
      await client.close();
    }
    const uniqueDiagnostics = [...new Set(diagnostics)].sort();
    return {
      language: "rust", provider: this.id, providerVersion: this.version, capability: this.capability,
      baseGeneration, edges: [...overlays.values()].sort((left, right) => edgeKey(left).localeCompare(edgeKey(right))),
      eligibleEdges: queries.size, diagnostics: uniqueDiagnostics, partial: uniqueDiagnostics.length > 0,
    };
  }
}
