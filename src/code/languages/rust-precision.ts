import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { CodeNodeRecord, IndexedSourceFile } from "../../contracts.js";
import { sha256 } from "../../utils.js";
import type { OverlayPrecisionProvider, PrecisionOverlayBatch, ProjectDescriptor, SyntaxGraphBatch } from "../providers.js";

const PROBE_TIMEOUT_MS = 5_000;
const LSP_REQUEST_TIMEOUT_MS = 15_000;
const WORKSPACE_READY_TIMEOUT_MS = 30_000;
const MAX_LSP_MESSAGE_BYTES = 16 * 1024 * 1024;

interface CommandSpec { executable: string; args: string[] }
type RustAnalyzerPolicy = "safe" | "trusted" | "disabled" | "invalid";
type LspPositionEncoding = "utf-8" | "utf-16";

const ENVIRONMENT_POLICY_VERSION = "rust-analyzer-env-v2";
const SAFE_INITIALIZATION_OPTIONS = {
  cargo: { noDeps: true, autoreload: false, buildScripts: { enable: false } },
  procMacro: { enable: false },
  checkOnSave: false,
} as const;
const TRUSTED_INITIALIZATION_OPTIONS = {
  cargo: { noDeps: false, autoreload: false, buildScripts: { enable: true } },
  procMacro: { enable: true },
  checkOnSave: false,
} as const;

interface RustAnalyzerSnapshot {
  policy: RustAnalyzerPolicy;
  invalidPolicy?: string;
  command: CommandSpec;
  initializationOptions: typeof SAFE_INITIALIZATION_OPTIONS | typeof TRUSTED_INITIALIZATION_OPTIONS;
  env: NodeJS.ProcessEnv;
  identity: string;
}

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

function safeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CARGO_NET_OFFLINE: "true" };
  const exact = new Set([
    "RUSTC", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "RUSTDOC", "CARGO",
    "CARGO_BUILD_RUSTC", "CARGO_BUILD_RUSTC_WRAPPER", "CARGO_BUILD_RUSTDOC",
    "RUSTFLAGS", "RUSTDOCFLAGS", "CARGO_ENCODED_RUSTFLAGS", "CARGO_BUILD_RUSTFLAGS", "CARGO_BUILD_RUSTDOCFLAGS",
  ]);
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase();
    if (exact.has(normalized) || /^CARGO_BUILD_/.test(normalized)
      || /^CARGO_TARGET_.+_(?:RUNNER|LINKER|RUSTFLAGS)$/.test(normalized)) delete env[key];
  }
  return env;
}

function captureSnapshot(): RustAnalyzerSnapshot {
  if (process.env.CONTEXTMESH_RUST_ANALYZER_DISABLE === "1") {
    return { policy: "disabled", command: { executable: "disabled", args: [] },
      initializationOptions: SAFE_INITIALIZATION_OPTIONS, env: {}, identity: "disabled:no-probe" };
  }
  const rawPolicy = process.env.CONTEXTMESH_RUST_ANALYZER_POLICY?.trim() || "safe";
  if (rawPolicy !== "safe" && rawPolicy !== "trusted") {
    return { policy: "invalid", invalidPolicy: rawPolicy, command: { executable: "invalid", args: [] },
      initializationOptions: SAFE_INITIALIZATION_OPTIONS, env: {}, identity: "invalid:no-probe" };
  }
  let command: CommandSpec;
  try { command = configuredCommand(); }
  catch (error) {
    return { policy: "invalid", invalidPolicy: error instanceof Error ? error.message : String(error),
      command: { executable: "invalid", args: [] }, initializationOptions: SAFE_INITIALIZATION_OPTIONS,
      env: {}, identity: "invalid:no-probe" };
  }
  return {
    policy: rawPolicy,
    command,
    initializationOptions: rawPolicy === "safe" ? SAFE_INITIALIZATION_OPTIONS : TRUSTED_INITIALIZATION_OPTIONS,
    env: rawPolicy === "safe" ? safeEnvironment() : { ...process.env },
    identity: "unprobed",
  };
}

function snapshotVersion(snapshot: RustAnalyzerSnapshot): string {
  const digest = sha256(JSON.stringify({
    executable: snapshot.command.executable,
    args: snapshot.command.args,
    policy: snapshot.policy,
    initializationOptions: snapshot.initializationOptions,
    environmentPolicyVersion: ENVIRONMENT_POLICY_VERSION,
    rustAnalyzerIdentity: snapshot.identity,
  })).slice(0, 12);
  return `rust-analyzer-lsp-v2:${snapshot.policy}:${digest}`;
}

function normalizedIdentity(result: { code: number; stdout: string; stderr: string }): string {
  const version = (result.stdout || result.stderr).trim().split(/\r?\n/, 1)[0] ?? "";
  if (result.code !== 0) throw new Error(`RUST_ANALYZER_UNAVAILABLE: ${version || `probe exited ${result.code}`}`);
  if (!/^rust-analyzer \d+\.\d+\.\d+ \([0-9a-f]{7,} \d{4}-\d{2}-\d{2}\)$/.test(version)) {
    throw new Error(`RUST_ANALYZER_IDENTITY_INVALID: ${version || "empty version"}`);
  }
  return version;
}

function runProbe(command: CommandSpec, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(command.executable, [...command.args, "--version"], { windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] }); }
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
  const snapshot = captureSnapshot();
  if (snapshot.policy === "disabled") throw new Error("RUST_ANALYZER_DISABLED: analyzer disabled by policy");
  if (snapshot.policy === "invalid") throw new Error(`RUST_ANALYZER_POLICY_INVALID: ${snapshot.invalidPolicy}`);
  return { version: normalizedIdentity(await runProbe(snapshot.command, snapshot.env)) };
}

class JsonRpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private terminalError: Error | null = null;
  private stderr = "";
  private serverStatus: { health: "ok" | "warning" | "error"; quiescent: boolean; message?: string } | null = null;
  private readonly pending = new Map<number | string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  readonly diagnostics: string[] = [];

  constructor(
    command: CommandSpec,
    env: NodeJS.ProcessEnv,
    private readonly rootPath: string,
    private readonly configuration: RustAnalyzerSnapshot["initializationOptions"],
  ) {
    this.child = spawn(command.executable, command.args, { windowsHide: true, env, stdio: ["pipe", "pipe", "pipe"] });
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
    if ((typeof message.id === "number" || typeof message.id === "string") && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`RUST_ANALYZER_REQUEST_FAILED: ${String(message.error.message ?? "unknown error")}`));
      else pending.resolve(message.result);
      return;
    }
    if ((typeof message.id === "number" || typeof message.id === "string") && typeof message.method === "string") {
      void this.respondToServerRequest(message.id, message.method, message.params);
      return;
    }
    if (message.method === "textDocument/publishDiagnostics") {
      const diagnostics = (message.params as { diagnostics?: Array<{ message?: unknown }> } | undefined)?.diagnostics;
      for (const diagnostic of diagnostics?.slice(0, 1_000) ?? []) {
        if (typeof diagnostic.message === "string") this.diagnostics.push(diagnostic.message.slice(0, 4_000));
      }
    }
    if (message.method === "experimental/serverStatus") {
      const status = message.params as { health?: unknown; quiescent?: unknown; message?: unknown } | undefined;
      if ((status?.health === "ok" || status?.health === "warning" || status?.health === "error")
        && typeof status.quiescent === "boolean") {
        this.serverStatus = {
          health: status.health,
          quiescent: status.quiescent,
          ...(typeof status.message === "string" ? { message: status.message.slice(0, 4_000) } : {}),
        };
      }
    }
  }

  private scopeInsideRoot(scopeUri: unknown): boolean {
    if (scopeUri === undefined || scopeUri === null) return true;
    if (typeof scopeUri !== "string") return false;
    let absolute: string;
    try { absolute = fileURLToPath(scopeUri); } catch { return false; }
    const relative = path.relative(this.rootPath, absolute);
    return relative === "" || !(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
  }

  private configurationSection(section: unknown): unknown {
    if (section === "rust-analyzer") return this.configuration;
    if (typeof section !== "string" || !section.startsWith("rust-analyzer.")) return null;
    let value: unknown = this.configuration;
    for (const key of section.slice("rust-analyzer.".length).split(".")) {
      if (!value || typeof value !== "object" || Array.isArray(value) || !(key in value)) return null;
      value = (value as Record<string, unknown>)[key];
    }
    return value;
  }

  private async respondToServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      if (method === "workspace/configuration") {
        const items = (params as { items?: unknown } | undefined)?.items;
        if (!Array.isArray(items) || items.length > 1_000) throw new Error("RUST_ANALYZER_PROTOCOL_INVALID: invalid configuration request");
        const result = items.map((item) => {
          if (!item || typeof item !== "object") return null;
          const candidate = item as { section?: unknown; scopeUri?: unknown };
          return this.scopeInsideRoot(candidate.scopeUri) ? this.configurationSection(candidate.section) : null;
        });
        await this.write({ jsonrpc: "2.0", id, result });
        return;
      }
      if (method === "window/workDoneProgress/create") {
        await this.write({ jsonrpc: "2.0", id, result: null });
        return;
      }
      if (method === "workspace/workspaceFolders") {
        await this.write({ jsonrpc: "2.0", id, result: [{ uri: pathToFileURL(this.rootPath).href, name: path.basename(this.rootPath) }] });
        return;
      }
      await this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    } catch (error) {
      this.terminate(error instanceof Error ? error : new Error(String(error)));
      this.child.kill();
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

  async waitForWorkspaceReady(): Promise<void> {
    const deadline = Date.now() + WORKSPACE_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.terminalError) throw this.terminalError;
      if (this.serverStatus?.health === "error") {
        throw new Error(`RUST_ANALYZER_WORKSPACE_ERROR: ${this.serverStatus.message ?? "server reported an error"}`);
      }
      if (this.serverStatus?.quiescent) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`RUST_ANALYZER_WORKSPACE_TIMEOUT: server did not become quiescent within ${WORKSPACE_READY_TIMEOUT_MS}ms`);
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

export interface LspTextIndex {
  lineStartBytes: number[];
  lineStartUtf16Offsets: number[];
  readonly lineEndBytes: number[];
  readonly lineEndUtf16Offsets: number[];
  readonly bytes: Buffer;
  readonly source: string;
}

export function createLspTextIndex(source: string): LspTextIndex {
  const lineStartBytes = [0];
  const lineStartUtf16Offsets = [0];
  const lineEndBytes: number[] = [];
  const lineEndUtf16Offsets: number[] = [];
  let byteOffset = 0;
  let utf16Offset = 0;
  for (let index = 0; index < source.length;) {
    const character = source[index]!;
    if (character === "\r" || character === "\n") {
      lineEndBytes.push(byteOffset);
      lineEndUtf16Offsets.push(utf16Offset);
      const crlf = character === "\r" && source[index + 1] === "\n";
      byteOffset += crlf ? 2 : 1;
      utf16Offset += crlf ? 2 : 1;
      index += crlf ? 2 : 1;
      lineStartBytes.push(byteOffset);
      lineStartUtf16Offsets.push(utf16Offset);
      continue;
    }
    const codePoint = source.codePointAt(index)!;
    const width = codePoint > 0xffff ? 2 : 1;
    const value = source.slice(index, index + width);
    byteOffset += Buffer.byteLength(value, "utf8");
    utf16Offset += width;
    index += width;
  }
  lineEndBytes.push(byteOffset);
  lineEndUtf16Offsets.push(utf16Offset);
  return { lineStartBytes, lineStartUtf16Offsets, lineEndBytes, lineEndUtf16Offsets,
    bytes: Buffer.from(source, "utf8"), source };
}

function lineAtByte(index: LspTextIndex, byteOffset: number): number {
  let low = 0;
  let high = index.lineStartBytes.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (index.lineStartBytes[middle]! <= byteOffset) low = middle;
    else high = middle;
  }
  return low;
}

export function byteOffsetToLspPosition(
  index: LspTextIndex,
  byteOffset: number,
  encoding: LspPositionEncoding,
): { line: number; character: number } | null {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || byteOffset > index.bytes.length) return null;
  if (byteOffset < index.bytes.length && (index.bytes[byteOffset]! & 0xc0) === 0x80) return null;
  const line = lineAtByte(index, byteOffset);
  if (byteOffset > index.lineEndBytes[line]!) return null;
  const lineByte = index.lineStartBytes[line]!;
  if (encoding === "utf-8") return { line, character: byteOffset - lineByte };
  const prefix = index.bytes.subarray(lineByte, byteOffset).toString("utf8");
  if (Buffer.byteLength(prefix, "utf8") !== byteOffset - lineByte) return null;
  return { line, character: prefix.length };
}

export function lspPositionToByteOffset(
  index: LspTextIndex,
  position: { line: number; character: number },
  encoding: LspPositionEncoding,
): number | null {
  if (!Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.character)
    || position.line < 0 || position.character < 0 || position.line >= index.lineStartBytes.length) return null;
  const startByte = index.lineStartBytes[position.line]!;
  const endByte = index.lineEndBytes[position.line]!;
  if (encoding === "utf-8") {
    const target = startByte + position.character;
    if (target > endByte || target < index.bytes.length && (index.bytes[target]! & 0xc0) === 0x80) return null;
    return target;
  }
  const startUtf16 = index.lineStartUtf16Offsets[position.line]!;
  const endUtf16 = index.lineEndUtf16Offsets[position.line]!;
  const targetUtf16 = startUtf16 + position.character;
  if (targetUtf16 > endUtf16) return null;
  if (targetUtf16 > startUtf16 && targetUtf16 < endUtf16) {
    const previous = index.source.charCodeAt(targetUtf16 - 1);
    const current = index.source.charCodeAt(targetUtf16);
    if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) return null;
  }
  return startByte + Buffer.byteLength(index.source.slice(startUtf16, targetUtf16), "utf8");
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
    const start = candidate.targetSelectionRange?.start ?? candidate.range?.start;
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

interface DefinitionQuery {
  sourceId: string;
  rawName: string;
  file: IndexedSourceFile;
  byteOffset: number;
}

export class RustAnalyzerProvider implements OverlayPrecisionProvider {
  readonly id = "rust_analyzer";
  version: string;
  readonly capability = "resolved" as const;
  private readonly rootPath: string;
  private readonly snapshot: RustAnalyzerSnapshot;

  constructor(project: ProjectDescriptor) {
    this.rootPath = (project.runtime as { rootPath?: string } | undefined)?.rootPath ?? process.cwd();
    this.snapshot = captureSnapshot();
    this.version = snapshotVersion(this.snapshot);
  }

  async available(): Promise<{ available: boolean; diagnostic?: string; unavailableStatus?: "not_configured" | "failed" }> {
    if (this.snapshot.policy === "disabled") return { available: false, diagnostic: "rust-analyzer disabled by policy" };
    if (this.snapshot.policy === "invalid") throw new Error(`RUST_ANALYZER_POLICY_INVALID: ${this.snapshot.invalidPolicy}`);
    try {
      this.snapshot.identity = normalizedIdentity(await runProbe(this.snapshot.command, this.snapshot.env));
      this.version = snapshotVersion(this.snapshot);
      return { available: true, diagnostic: this.snapshot.identity };
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error);
      return { available: false, diagnostic,
        unavailableStatus: (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ? "not_configured" : "failed" };
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
        sourceId: source.id, rawName, file, byteOffset: span.startByte,
      });
    }
    for (const reference of batch.unresolvedReferences) {
      if (reference.kind !== "CALLS" || !reference.sourceNodeId || !nodeById.has(reference.sourceNodeId)) continue;
      const file = fileById.get(reference.fileId);
      const span = reference.evidence?.find((item) => item.sourceSpan)?.sourceSpan;
      if (!file || !span) continue;
      queries.set(`${file.pathKey}\0${span.startByte}\0${reference.sourceNodeId}\0${reference.rawName}`, {
        sourceId: reference.sourceNodeId, rawName: reference.rawName, file, byteOffset: span.startByte,
      });
    }
    if (queries.size > 20_000) throw new Error("RUST_ANALYZER_QUERY_LIMIT: more than 20,000 call sites");

    if (this.snapshot.policy === "disabled" || this.snapshot.policy === "invalid") {
      throw new Error(`RUST_ANALYZER_POLICY_UNAVAILABLE: ${this.snapshot.policy}`);
    }
    const client = new JsonRpcClient(this.snapshot.command, this.snapshot.env, this.rootPath, this.snapshot.initializationOptions);
    const diagnostics: string[] = [];
    const overlays = new Map<string, PrecisionOverlayBatch["edges"][number]>();
    const edgeKey = (edge: Pick<PrecisionOverlayBatch["edges"][number], "sourceId" | "targetId" | "kind">): string =>
      `${edge.sourceId}\0${edge.targetId}\0${edge.kind}`;
    try {
      const initializeResult = await client.request("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(this.rootPath).href,
        capabilities: {
          general: { positionEncodings: ["utf-8", "utf-16"] },
          workspace: { configuration: true, workspaceFolders: true },
          window: { workDoneProgress: true },
          experimental: { serverStatusNotification: true },
        },
        initializationOptions: this.snapshot.initializationOptions,
        workspaceFolders: [{ uri: pathToFileURL(this.rootPath).href, name: path.basename(this.rootPath) }],
      });
      const selectedEncoding = (initializeResult as { capabilities?: { positionEncoding?: unknown } } | undefined)
        ?.capabilities?.positionEncoding ?? "utf-16";
      if (selectedEncoding !== "utf-8" && selectedEncoding !== "utf-16") {
        throw new Error(`RUST_ANALYZER_PROTOCOL_INVALID: unsupported position encoding ${String(selectedEncoding)}`);
      }
      const positionEncoding: LspPositionEncoding = selectedEncoding;
      await client.notify("initialized", {});
      for (const file of rustFiles) {
        await client.notify("textDocument/didOpen", {
          textDocument: { uri: pathToFileURL(file.absolutePath).href, languageId: "rust", version: 1, text: file.content },
        });
      }
      await client.waitForWorkspaceReady();
      const nodesByPath = new Map<string, CodeNodeRecord[]>();
      const filesByPath = new Map<string, IndexedSourceFile>();
      const textIndexes = new Map<string, LspTextIndex>();
      const pathKeyForFile = (file: IndexedSourceFile): string => process.platform === "win32"
        ? file.relativePath.toLocaleLowerCase("en-US") : file.relativePath;
      const textIndexFor = (file: IndexedSourceFile): LspTextIndex => {
        const key = `${file.id}\0${file.contentHash}`;
        const existing = textIndexes.get(key);
        if (existing) return existing;
        const created = createLspTextIndex(file.content);
        textIndexes.set(key, created);
        return created;
      };
      for (const file of rustFiles) filesByPath.set(pathKeyForFile(file), file);
      for (const node of rustNodes) {
        const file = node.fileId ? fileById.get(node.fileId) : undefined;
        if (!file) continue;
        const key = pathKeyForFile(file);
        const values = nodesByPath.get(key) ?? []; values.push(node); nodesByPath.set(key, values);
      }
      for (const query of queries.values()) {
        const queryPosition = byteOffsetToLspPosition(textIndexFor(query.file), query.byteOffset, positionEncoding);
        if (!queryPosition) {
          diagnostics.push(`RUST_ANALYZER_POSITION_INVALID: ${query.file.relativePath}:${query.byteOffset}`);
          continue;
        }
        let response: unknown;
        try {
          response = await client.request("textDocument/definition", {
            textDocument: { uri: pathToFileURL(query.file.absolutePath).href },
            position: queryPosition,
          });
        } catch (error) {
          diagnostics.push(error instanceof Error ? error.message : String(error));
          continue;
        }
        const targets = new Map<string, CodeNodeRecord>();
        for (const location of definitionLocations(response)) {
          const pathKey = relativeUri(this.rootPath, location.uri);
          if (!pathKey) continue;
          const targetFile = filesByPath.get(pathKey);
          if (!targetFile) continue;
          const targetByte = lspPositionToByteOffset(textIndexFor(targetFile), location, positionEncoding);
          if (targetByte === null) {
            diagnostics.push(`RUST_ANALYZER_DEFINITION_POSITION_INVALID: ${targetFile.relativePath}:${location.line}:${location.character}`);
            continue;
          }
          const matches = (nodesByPath.get(pathKey) ?? [])
            .filter((node) => node.startByte <= targetByte && targetByte < node.endByte)
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
            item.source === "syntax" && item.sourceSpan?.startByte === query.byteOffset))) {
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
