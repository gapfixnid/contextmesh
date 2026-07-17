import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  APPROVED_MODEL_KEY,
  APPROVED_MODEL_MANIFEST,
  canonicalJson,
  LOCAL_MODEL_MANIFEST_FILE,
  SemanticModelValidationError,
  validateApprovedModelDirectory,
} from "../src/semantic/manifest.js";
import { isTransformersRuntimeLoaded } from "../src/semantic/transformers-backend.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

describe("approved semantic model contract", () => {
  it("has a stable canonical digest and exact Node session options", () => {
    expect(APPROVED_MODEL_KEY).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalJson(JSON.parse(JSON.stringify(APPROVED_MODEL_MANIFEST)))).toBe(
      canonicalJson(APPROVED_MODEL_MANIFEST),
    );
    expect(APPROVED_MODEL_MANIFEST.backend.requestedSessionOptions).toEqual({
      intraOpNumThreads: 4,
      interOpNumThreads: 1,
      executionMode: "sequential",
    });
    expect(APPROVED_MODEL_MANIFEST.backend.requestedExecutionProviders).toEqual(["cpu"]);
  });

  it("rejects a missing model directory before dynamically loading Transformers.js", async () => {
    expect(isTransformersRuntimeLoaded()).toBe(false);
    await expect(validateApprovedModelDirectory(path.join(tmpdir(), "contextmesh-missing-model"))).rejects.toMatchObject({
      reason: "MODEL_DIRECTORY_MISSING",
    });
    expect(isTransformersRuntimeLoaded()).toBe(false);
  });

  it("rejects a local manifest that differs from the embedded approval", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "contextmesh-model-contract-"));
    roots.push(root);
    mkdirSync(path.join(root, "onnx"));
    writeFileSync(
      path.join(root, LOCAL_MODEL_MANIFEST_FILE),
      JSON.stringify({ ...APPROVED_MODEL_MANIFEST, textBuilderVersion: 2 }),
    );
    const error = await validateApprovedModelDirectory(root).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SemanticModelValidationError);
    expect(error).toMatchObject({ reason: "MANIFEST_INVALID" });
  });
});
