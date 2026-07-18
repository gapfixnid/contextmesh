import { describe, expect, it } from "vitest";

import {
  compareAcceptanceParity,
  type ParityArtifact,
} from "../scripts/compare-parity.js";

function artifact(platform: "win32" | "linux"): ParityArtifact {
  const rankedQuery = {
    id: "query-1",
    gateGroup: "semantic_challenge_en",
    deterministic: true,
    relevantTotal: 1,
    returned: platform === "win32" ? ["gold", "win-distractor"] : ["gold", "linux-distractor"],
    scoreMicro: platform === "win32" ? [900_000, 700_000] : [910_000, 680_000],
  };
  return {
    evaluatorVersion: "acceptance-v2@test",
    fixture: { sha256: "fixture", digestVersion: "v1", goldDigest: "gold" },
    baseline: { commit: "source", lexicalReferenceDigest: "baseline" },
    environment: {
      node: "v24",
      resolvedBackend: "onnxruntime-node@test",
      modelManifestDigest: "model",
      transformersVersion: "test",
      onnxruntimeNodeVersion: "test",
    },
    gates: { evaluated: true, passed: true },
    evaluation: {
      code: {
        aggregate: { macroRecall: 0.9, macroMrr: 0.9, macroNdcg: 0.9, microRecall: 0.9 },
        queries: [{ ...rankedQuery }],
      },
      memory: {
        aggregate: { macroRecall: 0.9, macroMrr: 0.9, macroNdcg: 0.9, microRecall: 0.9 },
        queries: [{ ...rankedQuery }],
      },
      context: {
        macroEvidenceCoverage: 0.9,
        microEvidenceCoverage: 0.9,
        macroDuplicateWaste: 0.01,
        queries: [{
          id: "context-1",
          deterministic: true,
          relevantTotal: 2,
          orderedCode: [{ id: platform === "win32" ? "win-code" : "linux-code", scoreMicro: 800_000 }],
          orderedMemory: [platform === "win32" ? "win-memory" : "linux-memory"],
        }],
      },
    },
  };
}

describe("cross-platform acceptance parity", () => {
  it("accepts OS-specific ranking drift when provenance, platform determinism, and quality agree", () => {
    const report = compareAcceptanceParity(artifact("win32"), artifact("linux"));
    expect(report.passed).toBe(true);
    expect(report.rankingDiagnostics.codeTopKOverlap.minimum).toBe(0.5);
  });

  it("rejects failed acceptance, provenance drift, and material quality drift", () => {
    const windows = artifact("win32");
    const ubuntu = artifact("linux");
    ubuntu.gates.passed = false;
    ubuntu.fixture.sha256 = "other-fixture";
    ubuntu.evaluation.code.aggregate.macroRecall = 0.84;
    const report = compareAcceptanceParity(windows, ubuntu);
    expect(report.passed).toBe(false);
    expect(report.differences.map((difference) => difference.kind)).toEqual(
      expect.arrayContaining(["acceptance_gate", "provenance", "quality_delta"]),
    );
  });

  it("rejects query-contract and within-profile determinism drift", () => {
    const windows = artifact("win32");
    const ubuntu = artifact("linux");
    ubuntu.evaluation.code.queries[0]!.gateGroup = "exact";
    ubuntu.evaluation.memory.queries[0]!.deterministic = false;
    const report = compareAcceptanceParity(windows, ubuntu);
    expect(report.passed).toBe(false);
    expect(report.differences.map((difference) => difference.kind)).toEqual(
      expect.arrayContaining(["query_contract", "platform_determinism"]),
    );
  });
});
