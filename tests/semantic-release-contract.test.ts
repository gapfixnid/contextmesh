import { describe, expect, it } from "vitest";

import { canonicalControlJson } from "../src/semantic/control-json.js";
import {
  choosePrimaryFailure,
  dataRepairFailure,
  repairFingerprint,
  scaleLimitFailure,
  type SemanticDataDefect,
} from "../src/semantic/failures.js";

describe("semantic release-gate control contracts", () => {
  it("serializes integer-looking keys directly in UTF-16 order", () => {
    expect(canonicalControlJson({ "2": "b", 가: "d", a: "c", "10": "a" })).toBe(
      '{"10":"a","2":"b","a":"c","가":"d"}',
    );
  });

  it("uses the fixed primary failure priority", () => {
    const primary = choosePrimaryFailure([
      dataRepairFailure([]),
      { failureClass: "runtime_retryable", code: "SESSION_CREATION", detailCode: "ORT", safeSummary: "SESSION_CREATION" },
      scaleLimitFailure(50_001, 50_000),
      { failureClass: "material_sticky", code: "MODEL_FILE_HASH_MISMATCH", detailCode: "MODEL_FILE_HASH_MISMATCH", safeSummary: "MODEL_FILE_HASH_MISMATCH" },
    ]);
    expect(primary?.failureClass).toBe("material_sticky");
  });

  it("canonicalizes missing embeddings with null storage sentinels", () => {
    const missing: SemanticDataDefect = {
      entityId: "memory-1",
      defectCode: "MISSING_EMBEDDING",
      storedModelKey: null,
      generation: null,
      sourceHash: null,
      codec: null,
      blobLength: null,
      blobSha256: null,
    };
    expect(repairFingerprint([missing])).toMatch(/^[0-9a-f]{64}$/);
    expect(repairFingerprint([missing])).toBe(repairFingerprint([{ ...missing }]));
  });
});
