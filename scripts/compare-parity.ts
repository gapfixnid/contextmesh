import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

interface RankedQueryArtifact {
  id: string;
  returned: string[];
  scoreMicro: number[];
}

interface ContextQueryArtifact {
  id: string;
  orderedCode: Array<{ id: string; scoreMicro: number }>;
  orderedMemory: string[];
}

interface ParityArtifact {
  evaluatorVersion: string;
  fixture: { sha256: string; goldDigest: string };
  baseline: { commit: string; lexicalReferenceDigest: string | null };
  environment: {
    node: string;
    resolvedBackend: string;
    modelManifestDigest: string | null;
    transformersVersion: string | null;
    onnxruntimeNodeVersion: string | null;
  };
  evaluation: {
    code: { queries: RankedQueryArtifact[] };
    memory: { queries: RankedQueryArtifact[] };
    context: { queries: ContextQueryArtifact[] };
  };
}

function argument(name: string, required = true): string | null {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : null;
  if (required && !value) throw new Error(`Missing ${name}`);
  return value ? path.resolve(value) : null;
}

const windowsPath = argument("--windows")!;
const ubuntuPath = argument("--ubuntu")!;
const diagnosticPath = argument("--diagnostic-output", false);
const windows = JSON.parse(readFileSync(windowsPath, "utf8")) as ParityArtifact;
const ubuntu = JSON.parse(readFileSync(ubuntuPath, "utf8")) as ParityArtifact;
const differences: Array<Record<string, unknown>> = [];

const provenance = (artifact: ParityArtifact) => ({
  sourceCommitSha: artifact.baseline.commit,
  fixtureDigest: artifact.fixture.sha256,
  goldDigest: artifact.fixture.goldDigest,
  modelManifestDigest: artifact.environment.modelManifestDigest,
  baselineDigest: artifact.baseline.lexicalReferenceDigest,
  evaluatorVersion: artifact.evaluatorVersion,
  nodeVersion: artifact.environment.node,
  transformersVersion: artifact.environment.transformersVersion,
  onnxruntimeNodeVersion: artifact.environment.onnxruntimeNodeVersion,
});
if (JSON.stringify(provenance(windows)) !== JSON.stringify(provenance(ubuntu))) {
  differences.push({ kind: "provenance", windows: provenance(windows), ubuntu: provenance(ubuntu) });
}

function compareRanked(plane: "code" | "memory", left: RankedQueryArtifact[], right: RankedQueryArtifact[]): void {
  const rightById = new Map(right.map((query) => [query.id, query]));
  for (const query of left) {
    const counterpart = rightById.get(query.id);
    if (!counterpart) {
      differences.push({ kind: "missing_query", plane, id: query.id });
      continue;
    }
    if (JSON.stringify(query.returned) !== JSON.stringify(counterpart.returned)) {
      differences.push({
        kind: "ordered_ids",
        plane,
        id: query.id,
        windows: query.returned,
        ubuntu: counterpart.returned,
      });
    }
    if (plane === "code") {
      for (let index = 0; index < Math.max(query.scoreMicro.length, counterpart.scoreMicro.length); index += 1) {
        const leftScore = query.scoreMicro[index];
        const rightScore = counterpart.scoreMicro[index];
        if (leftScore === undefined || rightScore === undefined || Math.abs(leftScore - rightScore) > 5) {
          differences.push({
            kind: "score_micro",
            plane,
            id: query.id,
            index,
            windows: leftScore ?? null,
            ubuntu: rightScore ?? null,
            tolerance: 5,
          });
        }
      }
    }
  }
  if (left.length !== right.length) differences.push({ kind: "query_count", plane, windows: left.length, ubuntu: right.length });
}

compareRanked("code", windows.evaluation.code.queries, ubuntu.evaluation.code.queries);
compareRanked("memory", windows.evaluation.memory.queries, ubuntu.evaluation.memory.queries);
const ubuntuContexts = new Map(ubuntu.evaluation.context.queries.map((query) => [query.id, query]));
for (const query of windows.evaluation.context.queries) {
  const counterpart = ubuntuContexts.get(query.id);
  if (!counterpart) {
    differences.push({ kind: "missing_context_query", id: query.id });
    continue;
  }
  if (JSON.stringify(query.orderedMemory) !== JSON.stringify(counterpart.orderedMemory)) {
    differences.push({ kind: "context_memory_ids", id: query.id, windows: query.orderedMemory, ubuntu: counterpart.orderedMemory });
  }
  const leftIds = query.orderedCode.map((item) => item.id);
  const rightIds = counterpart.orderedCode.map((item) => item.id);
  if (JSON.stringify(leftIds) !== JSON.stringify(rightIds)) {
    differences.push({ kind: "context_code_ids", id: query.id, windows: leftIds, ubuntu: rightIds });
  }
  for (let index = 0; index < Math.max(query.orderedCode.length, counterpart.orderedCode.length); index += 1) {
    const left = query.orderedCode[index]?.scoreMicro;
    const right = counterpart.orderedCode[index]?.scoreMicro;
    if (left === undefined || right === undefined || Math.abs(left - right) > 5) {
      differences.push({ kind: "context_score_micro", id: query.id, index, windows: left ?? null, ubuntu: right ?? null, tolerance: 5 });
    }
  }
}

const report = {
  passed: differences.length === 0,
  scoreMicroTolerance: 5,
  orderedIdsExact: true,
  topKMembershipExact: true,
  tieBoundaryOrderExact: true,
  windowsBackend: windows.environment.resolvedBackend,
  ubuntuBackend: ubuntu.environment.resolvedBackend,
  provenance: provenance(windows),
  differences,
};
if (diagnosticPath) {
  mkdirSync(path.dirname(diagnosticPath), { recursive: true });
  writeFileSync(diagnosticPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (differences.length > 0) throw new Error("Windows/Ubuntu semantic parity gate failed");
