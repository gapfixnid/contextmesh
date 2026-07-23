import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(script: string, args: string[], timeout = 180_000) {
  return spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout,
  });
}

describe("v0.6 boundary impact evaluation", () => {
  it("generates deterministic source-bound evidence and verifies it fail-closed", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-v06-evidence-test-"));
    roots.push(root);
    const artifactPath = path.join(root, "v06-boundary-impact.json");
    const evaluated = run("scripts/evaluate-v06.ts", ["--runs", "2", "--output", artifactPath]);
    expect(evaluated.status, `${evaluated.stdout}\n${evaluated.stderr}`).toBe(0);
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
      release: string;
      runs: number;
      deterministic: boolean;
      passed: boolean;
      fixture: { caseCount: number; digest: string };
      metrics: { precision: number; recall: number; falsePositive: number };
      caseResults: Array<{ passed: boolean }>;
    };
    expect(artifact).toMatchObject({
      release: "v0.6",
      runs: 2,
      deterministic: true,
      passed: true,
      fixture: {
        caseCount: 11,
        digest: "dbb39a2900f5730ed1d13c5967648fed7e11ab1ffd818c0a8bdd5f99d7ac134f",
      },
      metrics: { precision: 1, recall: 1, falsePositive: 0 },
    });
    expect(artifact.caseResults.every((item) => item.passed)).toBe(true);

    const verified = run("scripts/verify-v06-artifact.ts", [
      "--artifact", artifactPath,
      "--minimum-runs", "2",
    ]);
    expect(verified.status, `${verified.stdout}\n${verified.stderr}`).toBe(0);

    const tampered = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown> & {
      metrics: Record<string, unknown>;
    };
    tampered.metrics.falsePositive = 1;
    writeFileSync(artifactPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
    const rejected = run("scripts/verify-v06-artifact.ts", [
      "--artifact", artifactPath,
      "--minimum-runs", "2",
    ]);
    expect(rejected.status).not.toBe(0);
    expect(`${rejected.stdout}\n${rejected.stderr}`).toContain("exact resolved-boundary precision/recall gate failed");
  }, 180_000);
});
