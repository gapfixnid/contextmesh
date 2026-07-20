import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

describe("v0.5 resolved-edge quality gate", () => {
  it("scores immutable gold positives, false positives, ambiguous cases, and unresolved cases", () => {
    const fixturePath = path.join(process.cwd(), "evaluation", "fixtures", "v05-quality-v2.json");
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      immutable: boolean;
      provenance?: { origin?: string; mutationPolicy?: string };
      cases: Array<{ language: string; category: string; split?: string; expectedCallEdges?: unknown[] }>;
    };
    expect(fixture.immutable).toBe(true);
    expect(fixture.provenance).toMatchObject({ origin: expect.any(String), mutationPolicy: expect.any(String) });
    for (const language of ["typescript", "python", "go"]) {
      const languageCases = fixture.cases.filter((item) => item.language === language);
      expect(languageCases.length).toBeGreaterThanOrEqual(6);
      for (const split of ["development", "holdout"]) {
        const categories = new Set(languageCases.filter((item) => item.split === split).map((item) => item.category));
        expect(categories).toEqual(new Set(["positive", "negative", "ambiguous"]));
      }
      expect(languageCases.every((item) => Array.isArray(item.expectedCallEdges))).toBe(true);
    }

    const outputRoot = mkdtempSync(path.join(os.tmpdir(), "contextmesh-v05-evaluation-test-"));
    const output = path.join(outputRoot, "artifact.json");
    try {
      const npmCli = process.env.npm_execpath;
      if (!npmCli) throw new Error("npm_execpath is required for the v0.5 evaluator contract test");
      const run = spawnSync(process.execPath, [npmCli, "run", "evaluate:v05", "--", "--output", output], {
        cwd: process.cwd(),
        env: process.env,
        encoding: "utf8",
        timeout: 120_000,
      });
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      const artifact = JSON.parse(readFileSync(output, "utf8")) as {
        schemaVersion: number;
        source: { contract: string; treeDigest: string; files: number; headCommit: string; dirty: boolean };
        fixture: { digest: string; splitsByLanguage: Record<string, Record<string, number>> };
        languageResults: Array<{
          language: string;
          goldPositive: number;
          negativeCases: number;
          ambiguousCases: number;
          truePositive: number;
          falsePositive: number;
          falseNegative: number;
          precision: number;
          recall: number;
        }>;
        caseResults: Array<{ category: string; split: string; actualStatuses: string[]; unexpectedPaths: unknown[]; missingPaths: unknown[]; pathPassed: boolean; passed: boolean }>;
        providerAbsence: Array<{ language: string; preservesBase: boolean; providerState: string }>;
        checks: Record<string, boolean>;
        passed: boolean;
      };
      expect(artifact.schemaVersion).toBe(3);
      expect(artifact.source).toMatchObject({
        contract: expect.any(String), treeDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        files: expect.any(Number), headCommit: expect.stringMatching(/^[0-9a-f]{40}$/), dirty: expect.any(Boolean),
      });
      expect(artifact.fixture.digest).toBe(createHash("sha256").update(canonical(fixture)).digest("hex"));
      expect(artifact.languageResults).toHaveLength(3);
      for (const result of artifact.languageResults) {
        expect(result).toMatchObject({
          goldPositive: expect.any(Number),
          ambiguousCases: expect.any(Number),
          falsePositive: 0,
          falseNegative: 0,
          precision: 1,
          recall: 1,
        });
        expect(result.goldPositive).toBeGreaterThan(0);
        expect(result.ambiguousCases).toBeGreaterThanOrEqual(2);
        expect(result.negativeCases).toBeGreaterThanOrEqual(1);
        expect(result.truePositive).toBe(result.goldPositive);
      }
      expect(new Set(artifact.caseResults.flatMap((item) => item.actualStatuses))).toEqual(
        new Set(["candidate", "rejected", "resolved"]),
      );
      expect(artifact.caseResults.every((item) => item.passed)).toBe(true);
      expect(artifact.caseResults.every((item) => item.pathPassed && item.unexpectedPaths.length === 0 && item.missingPaths.length === 0)).toBe(true);
      expect(new Set(artifact.caseResults.map((item) => item.split))).toEqual(new Set(["development", "holdout"]));
      expect(artifact.providerAbsence).toHaveLength(3);
      expect(artifact.providerAbsence.every((item) => item.preservesBase && item.providerState === "not_configured")).toBe(true);
      expect(Object.values(artifact.checks).every(Boolean)).toBe(true);
      expect(artifact.passed).toBe(true);
    } finally {
      rmSync(outputRoot, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
