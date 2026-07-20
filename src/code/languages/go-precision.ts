import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import type { CodeNodeRecord } from "../../contracts.js";
import type { OverlayPrecisionProvider, PrecisionOverlayBatch, ProjectDescriptor, SyntaxGraphBatch } from "../providers.js";

const outputSchema = z.object({
  edges: z.array(z.object({
    sourceFile: z.string(), sourceName: z.string(), sourceOffset: z.number().int().nonnegative(),
    callOffset: z.number().int().nonnegative(),
    targetFile: z.string(), targetName: z.string(), targetOffset: z.number().int().nonnegative(),
  })).max(1_000_000),
  diagnostics: z.array(z.string()).max(100_000),
  toolchain: z.string().regex(/^go\d+\.\d+/),
});

const GO_PROVIDER_BASE_VERSION = "go/types-stdlib-v2";
let cachedGoToolchain: string | null = null;

function runGo(args: string[], cwd: string, timeoutMs: number, stdin?: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    if (stdin !== undefined && Buffer.byteLength(stdin, "utf8") > 16 * 1024 * 1024) {
      reject(new Error("GO_TYPES_INPUT_TOO_LARGE"));
      return;
    }
    let child;
    try {
      child = spawn("go", args, {
        cwd,
        windowsHide: true,
        env: {
          ...process.env,
          GOENV: "off",
          GOPROXY: "off",
          GOSUMDB: "off",
          GOTOOLCHAIN: "local",
          GOVCS: "*:off",
        },
        stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    }
    catch (error) { reject(error); return; }
    let stdout = ""; let stderr = ""; let settled = false;
    const finish = (value: { stdout: string; stderr: string; code: number }): void => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const fail = (error: Error): void => { if (settled) return; settled = true; clearTimeout(timer); reject(error); };
    const timer = setTimeout(() => { child.kill(); finish({ stdout, stderr: `${stderr}\nGO_TYPES_TIMEOUT`, code: -1 }); }, timeoutMs);
    child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); if (stdout.length > 64 * 1024 * 1024) child.kill(); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); if (stderr.length > 4 * 1024 * 1024) child.kill(); });
    child.stdin?.on("error", () => { /* The process exit result is authoritative. */ });
    child.once("error", fail);
    child.once("exit", (code) => finish({ stdout, stderr, code: code ?? -1 }));
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

export class GoTypesProvider implements OverlayPrecisionProvider {
  readonly id = "go_types";
  version = cachedGoToolchain ? `${GO_PROVIDER_BASE_VERSION}+${cachedGoToolchain}` : GO_PROVIDER_BASE_VERSION;
  readonly capability = "typed" as const;
  private readonly rootPath: string;
  private toolchain = cachedGoToolchain;
  constructor(project: ProjectDescriptor) { this.rootPath = (project.runtime as { rootPath?: string } | undefined)?.rootPath ?? process.cwd(); }

  async available(): Promise<{ available: boolean; diagnostic?: string }> {
    if (process.env.CONTEXTMESH_GO_TYPES_DISABLE === "1") return { available: false, diagnostic: "go/types disabled by policy" };
    try {
      const result = await runGo(["version"], this.rootPath, 5_000);
      if (result.code !== 0) return { available: false, diagnostic: result.stderr.trim() || "go command failed" };
      const toolchain = result.stdout.trim().match(/^go version (go\S+)/)?.[1];
      if (!toolchain) return { available: false, diagnostic: "go version output is not recognized" };
      this.toolchain = toolchain;
      cachedGoToolchain = toolchain;
      this.version = `${GO_PROVIDER_BASE_VERSION}+${toolchain}`;
      return { available: true };
    } catch (error) { return { available: false, diagnostic: error instanceof Error ? error.message : String(error) }; }
  }

  async analyze(batch: SyntaxGraphBatch, baseGeneration: number): Promise<PrecisionOverlayBatch> {
    const helper = fileURLToPath(new URL("../../../native/go-provider/main.go", import.meta.url));
    const approvedFiles = batch.files
      .filter((file) => file.language === "go")
      .map((file) => ({ path: file.relativePath, sizeBytes: file.sizeBytes, contentHash: file.contentHash }))
      .sort((left, right) => left.path.localeCompare(right.path));
    const result = await runGo(
      ["run", helper, "--root", this.rootPath, "--files-stdin"],
      this.rootPath,
      60_000,
      JSON.stringify({ files: approvedFiles }),
    );
    if (result.code !== 0) throw new Error(`GO_TYPES_FAILED: ${result.stderr.trim() || `exit ${result.code}`}`);
    const parsed = outputSchema.parse(JSON.parse(result.stdout) as unknown);
    if (!this.toolchain || parsed.toolchain !== this.toolchain) {
      throw new Error(`GO_TYPES_TOOLCHAIN_MISMATCH: expected ${this.toolchain ?? "unprobed"}, received ${parsed.toolchain}`);
    }
    const nodes = batch.nodes.filter((node) => node.language === "go");
    const byPathAndName = new Map<string, CodeNodeRecord[]>();
    const moduleByPath = new Map<string, CodeNodeRecord>();
    for (const node of nodes) {
      const file = batch.files.find((item) => item.id === node.fileId);
      if (!file) continue;
      if (node.kind === "module") moduleByPath.set(file.relativePath, node);
      const key = `${file.relativePath}\0${node.name}`;
      const values = byPathAndName.get(key) ?? []; values.push(node); byPathAndName.set(key, values);
    }
    const nodeAtOffset = (relativePath: string, name: string, offset: number): CodeNodeRecord | undefined => {
      const candidates = byPathAndName.get(`${relativePath}\0${name}`) ?? [];
      const containing = candidates.filter((node) => node.startByte <= offset && node.endByte >= offset);
      return containing.length === 1 ? containing[0] : candidates.length === 1 ? candidates[0] : undefined;
    };
    const overlays = new Map<string, PrecisionOverlayBatch["edges"][number]>();
    const edgeKey = (edge: Pick<PrecisionOverlayBatch["edges"][number], "sourceId" | "targetId" | "kind">) => `${edge.sourceId}\0${edge.targetId}\0${edge.kind}`;
    for (const item of parsed.edges) {
      const source = nodeAtOffset(item.sourceFile, item.sourceName, item.sourceOffset) ?? moduleByPath.get(item.sourceFile);
      const target = nodeAtOffset(item.targetFile, item.targetName, item.targetOffset);
      if (!source || !target) continue;
      const resolved = { sourceId: source.id, targetId: target.id, kind: "CALLS" as const, status: "resolved" as const,
        confidence: 1, resolutionKind: source.fileId === target.fileId ? "local" as const : "import" as const,
        evidence: [{ provider: this.id, providerVersion: this.version, source: "type_checker" as const, confidence: 1,
          details: { sourceFile: item.sourceFile, sourceOffset: item.sourceOffset, callOffset: item.callOffset, targetFile: item.targetFile,
            targetOffset: item.targetOffset, toolchain: parsed.toolchain } }] };
      overlays.set(edgeKey(resolved), resolved);
      for (const candidate of batch.edges.filter((edge) => edge.kind === "CALLS" && edge.sourceId === source.id &&
        edge.status === "candidate" && edge.targetId !== target.id && edge.evidence?.some((evidence) =>
          evidence.source === "syntax" && evidence.sourceSpan?.startByte === item.callOffset))) {
        const rejected = { sourceId: candidate.sourceId, targetId: candidate.targetId, kind: candidate.kind, status: "rejected" as const,
          confidence: 1, resolutionKind: candidate.resolutionKind,
          evidence: [{ provider: this.id, providerVersion: this.version, source: "type_checker" as const, confidence: 1,
            details: { reason: "go_types_selected_different_target", selectedTargetId: target.id } }] };
        overlays.set(edgeKey(rejected), rejected);
      }
    }
    const goNodeIds = new Set(nodes.map((node) => node.id));
    const baseEligibleEdges = batch.edges.filter((edge) => edge.kind === "CALLS" && goNodeIds.has(edge.sourceId)).length;
    const unresolvedEligibleEdges = new Set(batch.unresolvedReferences.filter((item) =>
      item.kind === "CALLS" && item.sourceNodeId !== null && goNodeIds.has(item.sourceNodeId))
      .map((item) => `${item.sourceNodeId}\0${item.rawName}\0${item.line}\0${item.column}`)).size;
    const resolvedEdges = [...overlays.values()].filter((edge) => edge.status === "resolved").length;
    return { language: "go", provider: this.id, providerVersion: this.version, capability: this.capability,
      baseGeneration, edges: [...overlays.values()].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))),
      eligibleEdges: Math.max(baseEligibleEdges + unresolvedEligibleEdges, resolvedEdges),
      diagnostics: parsed.diagnostics, partial: parsed.diagnostics.length > 0 };
  }
}
