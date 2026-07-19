import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import type { CodeNodeRecord } from "../../contracts.js";
import type { OverlayPrecisionProvider, PrecisionOverlayBatch, ProjectDescriptor, SyntaxGraphBatch } from "../providers.js";

const outputSchema = z.object({
  edges: z.array(z.object({ sourceFile: z.string(), sourceName: z.string(), targetFile: z.string(), targetName: z.string() })).max(1_000_000),
  diagnostics: z.array(z.string()).max(100_000),
});

function runGo(args: string[], cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn("go", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { reject(error); return; }
    let stdout = ""; let stderr = ""; let settled = false;
    const finish = (value: { stdout: string; stderr: string; code: number }): void => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const fail = (error: Error): void => { if (settled) return; settled = true; clearTimeout(timer); reject(error); };
    const timer = setTimeout(() => { child.kill(); finish({ stdout, stderr: `${stderr}\nGO_TYPES_TIMEOUT`, code: -1 }); }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); if (stdout.length > 64 * 1024 * 1024) child.kill(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); if (stderr.length > 4 * 1024 * 1024) child.kill(); });
    child.once("error", fail);
    child.once("exit", (code) => finish({ stdout, stderr, code: code ?? -1 }));
  });
}

export class GoTypesProvider implements OverlayPrecisionProvider {
  readonly id = "go_types";
  readonly version = "go/types-stdlib-v1";
  readonly capability = "typed" as const;
  private readonly rootPath: string;
  constructor(project: ProjectDescriptor) { this.rootPath = (project.runtime as { rootPath?: string } | undefined)?.rootPath ?? process.cwd(); }

  async available(): Promise<{ available: boolean; diagnostic?: string }> {
    if (process.env.CONTEXTMESH_GO_TYPES_DISABLE === "1") return { available: false, diagnostic: "go/types disabled by policy" };
    try {
      const result = await runGo(["version"], this.rootPath, 5_000);
      return result.code === 0 ? { available: true } : { available: false, diagnostic: result.stderr.trim() || "go command failed" };
    } catch (error) { return { available: false, diagnostic: error instanceof Error ? error.message : String(error) }; }
  }

  async analyze(batch: SyntaxGraphBatch, baseGeneration: number): Promise<PrecisionOverlayBatch> {
    const helper = fileURLToPath(new URL("../../../native/go-provider/main.go", import.meta.url));
    const result = await runGo(["run", helper, "--root", this.rootPath], this.rootPath, 60_000);
    if (result.code !== 0) throw new Error(`GO_TYPES_FAILED: ${result.stderr.trim() || `exit ${result.code}`}`);
    const parsed = outputSchema.parse(JSON.parse(result.stdout) as unknown);
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
    const overlays = new Map<string, PrecisionOverlayBatch["edges"][number]>();
    const edgeKey = (edge: Pick<PrecisionOverlayBatch["edges"][number], "sourceId" | "targetId" | "kind">) => `${edge.sourceId}\0${edge.targetId}\0${edge.kind}`;
    for (const item of parsed.edges) {
      const sources = byPathAndName.get(`${item.sourceFile}\0${item.sourceName}`) ?? [];
      const targets = byPathAndName.get(`${item.targetFile}\0${item.targetName}`) ?? [];
      const source = sources.length === 1 ? sources[0] : moduleByPath.get(item.sourceFile);
      const target = targets.length === 1 ? targets[0] : undefined;
      if (!source || !target) continue;
      const resolved = { sourceId: source.id, targetId: target.id, kind: "CALLS" as const, status: "resolved" as const,
        confidence: 1, resolutionKind: source.fileId === target.fileId ? "local" as const : "import" as const,
        evidence: [{ provider: this.id, providerVersion: this.version, source: "type_checker" as const, confidence: 1,
          details: { sourceFile: item.sourceFile, targetFile: item.targetFile } }] };
      overlays.set(edgeKey(resolved), resolved);
      for (const candidate of batch.edges.filter((edge) => edge.kind === "CALLS" && edge.sourceId === source.id && edge.status === "candidate" && edge.targetId !== target.id)) {
        const rejected = { sourceId: candidate.sourceId, targetId: candidate.targetId, kind: candidate.kind, status: "rejected" as const,
          confidence: 1, resolutionKind: candidate.resolutionKind,
          evidence: [{ provider: this.id, providerVersion: this.version, source: "type_checker" as const, confidence: 1,
            details: { reason: "go_types_selected_different_target", selectedTargetId: target.id } }] };
        overlays.set(edgeKey(rejected), rejected);
      }
    }
    return { language: "go", provider: this.id, providerVersion: this.version, capability: this.capability,
      baseGeneration, edges: [...overlays.values()].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))),
      eligibleEdges: batch.edges.filter((edge) => edge.kind === "CALLS" && batch.nodes.some((node) => node.id === edge.sourceId && node.language === "go")).length,
      diagnostics: parsed.diagnostics, partial: parsed.diagnostics.length > 0 };
  }
}
