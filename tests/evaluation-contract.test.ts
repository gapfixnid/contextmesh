import { describe, expect, it } from "vitest";

import {
  addBaselineDigest,
  canonicalControlJson,
  metricsForGateGroup,
  normalizedFixtureDigest,
  requiredChallengeRecall,
  requiredNdcg,
  runEvaluationContractSelfTest,
  serializeCanonicalArtifact,
  sourceDateEpochIso,
} from "../scripts/evaluation-contract.js";

describe("acceptance-v2 evaluation contract", () => {
  it("serializes numeric-looking and Unicode keys in raw UTF-16 order", () => {
    expect(canonicalControlJson({ "2": "b", 가: "d", a: "c", "10": "a" })).toBe(
      '{"10":"a","2":"b","a":"c","가":"d"}',
    );
    runEvaluationContractSelfTest();
  });

  it("digests the canonical payload without self-reference and writes one LF without a BOM", () => {
    const artifact = addBaselineDigest({ version: 2, payload: { value: "stable" } });
    const bytes = serializeCanonicalArtifact(artifact);
    expect(bytes.subarray(0, 3).toString("hex")).not.toBe("efbbbf");
    expect(bytes.toString("utf8").endsWith("\n")).toBe(true);
    expect(bytes.toString("utf8").endsWith("\n\n")).toBe(false);
    expect(artifact.baselineDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses gateGroup subsets and attainable challenge thresholds", () => {
    const values = [
      { gateGroup: "semantic_challenge_en", recall: 0.8 },
      { gateGroup: "exact", recall: 1 },
      { gateGroup: "semantic_challenge_en", recall: 0.9 },
    ];
    expect(metricsForGateGroup(values, "semantic_challenge_en")).toHaveLength(2);
    expect(requiredChallengeRecall(0.5)).toBe(0.8);
    expect(requiredChallengeRecall(0.7)).toBeCloseTo(0.85);
    expect(requiredChallengeRecall(0.8)).toBe(0.9);
    expect(requiredNdcg(0.95)).toBe(1);
  });

  it("requires a fixed SOURCE_DATE_EPOCH", () => {
    expect(sourceDateEpochIso("0")).toBe("1970-01-01T00:00:00.000Z");
    expect(() => sourceDateEpochIso(undefined)).toThrow(/SOURCE_DATE_EPOCH/);
  });

  it("keeps the v2 fixture digest stable across checkout line endings", () => {
    expect(normalizedFixtureDigest(Buffer.from('{"value":1}\r\n'))).toBe(
      normalizedFixtureDigest(Buffer.from('{"value":1}\n')),
    );
  });
});
