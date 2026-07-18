import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface RankedQueryArtifact {
  id: string;
  gateGroup: string;
  deterministic: boolean;
  relevantTotal: number;
  returned: string[];
  scoreMicro: number[];
}

export interface ContextQueryArtifact {
  id: string;
  deterministic: boolean;
  relevantTotal: number;
  orderedCode: Array<{ id: string; scoreMicro: number }>;
  orderedMemory: string[];
}

interface RankedAggregate {
  macroRecall: number;
  macroMrr: number;
  macroNdcg: number;
  microRecall: number;
}

export interface ParityArtifact {
  evaluatorVersion: string;
  fixture: { sha256: string; digestVersion: string; goldDigest: string };
  baseline: { commit: string; lexicalReferenceDigest: string | null };
  environment: {
    node: string;
    resolvedBackend: string;
    modelManifestDigest: string | null;
    transformersVersion: string | null;
    onnxruntimeNodeVersion: string | null;
  };
  gates: { evaluated: boolean; passed: boolean };
  evaluation: {
    code: { aggregate: RankedAggregate; queries: RankedQueryArtifact[] };
    memory: { aggregate: RankedAggregate; queries: RankedQueryArtifact[] };
    context: {
      macroEvidenceCoverage: number;
      microEvidenceCoverage: number;
      macroDuplicateWaste: number;
      queries: ContextQueryArtifact[];
    };
  };
}

const RANKED_QUALITY_TOLERANCE = 0.05;
const CONTEXT_QUALITY_TOLERANCE = 0.05;

function provenance(artifact: ParityArtifact) {
  return {
    sourceCommitSha: artifact.baseline.commit,
    fixtureDigest: artifact.fixture.sha256,
    fixtureDigestVersion: artifact.fixture.digestVersion,
    goldDigest: artifact.fixture.goldDigest,
    modelManifestDigest: artifact.environment.modelManifestDigest,
    baselineDigest: artifact.baseline.lexicalReferenceDigest,
    evaluatorVersion: artifact.evaluatorVersion,
    nodeVersion: artifact.environment.node,
    transformersVersion: artifact.environment.transformersVersion,
    onnxruntimeNodeVersion: artifact.environment.onnxruntimeNodeVersion,
  };
}

function overlapSummary(left: RankedQueryArtifact[], right: RankedQueryArtifact[]) {
  const rightById = new Map(right.map((query) => [query.id, query]));
  const values = left.flatMap((query) => {
    const counterpart = rightById.get(query.id);
    if (!counterpart) return [];
    const rightIds = new Set(counterpart.returned);
    const intersection = query.returned.filter((id) => rightIds.has(id)).length;
    return [intersection / Math.max(1, Math.min(query.returned.length, counterpart.returned.length))];
  });
  return {
    minimum: values.length === 0 ? null : Math.min(...values),
    mean: values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

export function compareAcceptanceParity(windows: ParityArtifact, ubuntu: ParityArtifact) {
  const differences: Array<Record<string, unknown>> = [];
  const windowsProvenance = provenance(windows);
  const ubuntuProvenance = provenance(ubuntu);
  if (JSON.stringify(windowsProvenance) !== JSON.stringify(ubuntuProvenance)) {
    differences.push({ kind: "provenance", windows: windowsProvenance, ubuntu: ubuntuProvenance });
  }
  for (const [platform, artifact] of [["windows", windows], ["ubuntu", ubuntu]] as const) {
    if (!artifact.gates.evaluated || !artifact.gates.passed) {
      differences.push({ kind: "acceptance_gate", platform, gates: artifact.gates });
    }
  }

  const compareMetric = (
    scope: string,
    metric: string,
    left: number,
    right: number,
    tolerance: number,
  ) => {
    if (!Number.isFinite(left) || !Number.isFinite(right) || Math.abs(left - right) > tolerance) {
      differences.push({ kind: "quality_delta", scope, metric, windows: left, ubuntu: right, tolerance });
    }
  };
  for (const plane of ["code", "memory"] as const) {
    for (const metric of ["macroRecall", "macroMrr", "macroNdcg", "microRecall"] as const) {
      compareMetric(
        plane,
        metric,
        windows.evaluation[plane].aggregate[metric],
        ubuntu.evaluation[plane].aggregate[metric],
        RANKED_QUALITY_TOLERANCE,
      );
    }
  }
  for (const metric of ["macroEvidenceCoverage", "microEvidenceCoverage", "macroDuplicateWaste"] as const) {
    compareMetric(
      "context",
      metric,
      windows.evaluation.context[metric],
      ubuntu.evaluation.context[metric],
      CONTEXT_QUALITY_TOLERANCE,
    );
  }

  const compareQueryContract = (
    plane: "code" | "memory",
    left: RankedQueryArtifact[],
    right: RankedQueryArtifact[],
  ) => {
    const rightById = new Map(right.map((query) => [query.id, query]));
    for (const query of left) {
      const counterpart = rightById.get(query.id);
      if (!counterpart) {
        differences.push({ kind: "missing_query", plane, id: query.id, platform: "ubuntu" });
        continue;
      }
      if (query.gateGroup !== counterpart.gateGroup || query.relevantTotal !== counterpart.relevantTotal) {
        differences.push({
          kind: "query_contract",
          plane,
          id: query.id,
          windows: { gateGroup: query.gateGroup, relevantTotal: query.relevantTotal },
          ubuntu: { gateGroup: counterpart.gateGroup, relevantTotal: counterpart.relevantTotal },
        });
      }
      if (!query.deterministic || !counterpart.deterministic) {
        differences.push({ kind: "platform_determinism", plane, id: query.id });
      }
    }
    for (const query of right) {
      if (!left.some((counterpart) => counterpart.id === query.id)) {
        differences.push({ kind: "missing_query", plane, id: query.id, platform: "windows" });
      }
    }
  };
  compareQueryContract("code", windows.evaluation.code.queries, ubuntu.evaluation.code.queries);
  compareQueryContract("memory", windows.evaluation.memory.queries, ubuntu.evaluation.memory.queries);

  const ubuntuContexts = new Map(ubuntu.evaluation.context.queries.map((query) => [query.id, query]));
  for (const query of windows.evaluation.context.queries) {
    const counterpart = ubuntuContexts.get(query.id);
    if (!counterpart) {
      differences.push({ kind: "missing_query", plane: "context", id: query.id, platform: "ubuntu" });
      continue;
    }
    if (query.relevantTotal !== counterpart.relevantTotal) {
      differences.push({
        kind: "query_contract",
        plane: "context",
        id: query.id,
        windows: { relevantTotal: query.relevantTotal },
        ubuntu: { relevantTotal: counterpart.relevantTotal },
      });
    }
    if (!query.deterministic || !counterpart.deterministic) {
      differences.push({ kind: "platform_determinism", plane: "context", id: query.id });
    }
  }
  for (const query of ubuntu.evaluation.context.queries) {
    if (!windows.evaluation.context.queries.some((counterpart) => counterpart.id === query.id)) {
      differences.push({ kind: "missing_query", plane: "context", id: query.id, platform: "windows" });
    }
  }

  return {
    passed: differences.length === 0,
    contractVersion: "cross-platform-quality-parity-v1",
    exactRequirements: ["provenance", "query-contract", "20-run-determinism-within-each-runtime-profile"],
    qualityTolerances: {
      rankedAggregateAbsoluteDelta: RANKED_QUALITY_TOLERANCE,
      contextAggregateAbsoluteDelta: CONTEXT_QUALITY_TOLERANCE,
    },
    rankingDiagnostics: {
      codeTopKOverlap: overlapSummary(windows.evaluation.code.queries, ubuntu.evaluation.code.queries),
      memoryTopKOverlap: overlapSummary(windows.evaluation.memory.queries, ubuntu.evaluation.memory.queries),
      note: "OS-specific ONNX CPU kernels are quality-compared; raw embedding scores and irrelevant-candidate order are diagnostic only.",
    },
    windowsBackend: windows.environment.resolvedBackend,
    ubuntuBackend: ubuntu.environment.resolvedBackend,
    provenance: windowsProvenance,
    differences,
  };
}

function argument(name: string, required = true): string | null {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : null;
  if (required && !value) throw new Error(`Missing ${name}`);
  return value ? path.resolve(value) : null;
}

function main(): void {
  const windowsPath = argument("--windows")!;
  const ubuntuPath = argument("--ubuntu")!;
  const diagnosticPath = argument("--diagnostic-output", false);
  const windows = JSON.parse(readFileSync(windowsPath, "utf8")) as ParityArtifact;
  const ubuntu = JSON.parse(readFileSync(ubuntuPath, "utf8")) as ParityArtifact;
  const report = compareAcceptanceParity(windows, ubuntu);
  if (diagnosticPath) {
    mkdirSync(path.dirname(diagnosticPath), { recursive: true });
    writeFileSync(diagnosticPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) throw new Error("Windows/Ubuntu acceptance quality parity gate failed");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
