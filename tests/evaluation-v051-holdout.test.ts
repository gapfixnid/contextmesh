import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

interface ExternalFixture {
  schemaVersion: number;
  id: string;
  immutable: boolean;
  thresholds: { precision: number; recall: number; classificationCoverage: number };
  repositories: Array<{
    id: string;
    repository: string;
    commit: string;
    tag: string;
    license: string;
    profiles: string[];
    files: Array<{ upstreamPath: string; corpusPath: string; sha256: string }>;
  }>;
  cases: Array<{
    id: string;
    repositoryId: string;
    language: string;
    sourceQualifiedName: string;
    sourceStartLine: number;
    expectedCallEdges: Array<{ target: string; targetStartLine: number; status: string }>;
    expectedUnresolved?: { rawName: string };
  }>;
}

const fixturePath = path.join(process.cwd(), "evaluation", "fixtures", "v051-external-holdout-v1.json");
const corpusRoot = path.join(process.cwd(), "evaluation", "fixtures", "v051-external-corpus-v1");
const hasGo = spawnSync("go", ["version"], { encoding: "utf8", windowsHide: true }).status === 0;

describe("v0.5.1 external holdout release contract", () => {
  it("pins licensed upstream source bytes and non-synthetic repository profiles", () => {
    expect(existsSync(fixturePath)).toBe(true);
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as ExternalFixture;
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      id: "contextmesh-v051-external-holdout-v1",
      immutable: true,
      thresholds: { precision: 0.9, recall: 0.8, classificationCoverage: 1 },
    });
    expect(fixture.repositories.map((item) => item.repository).sort()).toEqual([
      "kubernetes/client-go",
      "nrwl/nx",
      "pallets/flask",
    ]);
    expect(new Set(fixture.repositories.flatMap((item) => item.profiles))).toEqual(
      new Set(["complex-src-layout", "generated-code", "large-monorepo"]),
    );
    expect(new Set(fixture.repositories.map((item) => item.license))).toEqual(
      new Set(["Apache-2.0", "BSD-3-Clause", "MIT"]),
    );
    for (const repository of fixture.repositories) {
      expect(repository.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(repository.tag.length).toBeGreaterThan(0);
      expect(repository.files.length).toBeGreaterThanOrEqual(3);
      for (const file of repository.files) {
        expect(file.corpusPath.startsWith(`${repository.id}/`)).toBe(true);
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
        const source = readFileSync(path.join(corpusRoot, file.corpusPath));
        expect(createHash("sha256").update(source).digest("hex")).toBe(file.sha256);
      }
    }
    expect(fixture.cases.length).toBeGreaterThanOrEqual(18);
    for (const language of ["typescript", "python", "go"]) {
      const cases = fixture.cases.filter((item) => item.language === language);
      expect(cases.length).toBeGreaterThanOrEqual(6);
      expect(cases.every((item) => Number.isSafeInteger(item.sourceStartLine) && item.sourceStartLine > 0)).toBe(true);
      expect(cases.flatMap((item) => item.expectedCallEdges)
        .every((edge) => Number.isSafeInteger(edge.targetStartLine) && edge.targetStartLine > 0)).toBe(true);
      expect(cases.some((item) => item.expectedCallEdges.length > 0)).toBe(true);
      expect(cases.some((item) => item.expectedUnresolved)).toBe(true);
    }
  });

  it.skipIf(!hasGo)("produces a deterministic external holdout artifact when the Go provider is available", () => {
    const output = path.join(process.env.TEMP ?? process.cwd(), `contextmesh-v051-${process.pid}.json`);
    const npmCli = process.env.npm_execpath;
    if (!npmCli) throw new Error("npm_execpath is required");
    const run = spawnSync(process.execPath, [npmCli, "run", "evaluate:v051-holdout", "--", "--output", output], {
      cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 300_000,
    });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    const artifact = JSON.parse(readFileSync(output, "utf8")) as {
      release: string;
      fixture: { repositoryCount: number; caseCount: number; profiles: string[] };
      languageResults: Array<{ language: string; precision: number; recall: number; classificationCoverage: number }>;
      determinism: { runs: number; identical: boolean; signatures: string[] };
      passed: boolean;
    };
    expect(artifact.release).toBe("v0.5.1");
    expect(artifact.fixture).toMatchObject({ repositoryCount: 3 });
    expect(artifact.fixture.caseCount).toBeGreaterThanOrEqual(18);
    expect(new Set(artifact.fixture.profiles)).toEqual(new Set(["complex-src-layout", "generated-code", "large-monorepo"]));
    expect(artifact.languageResults).toHaveLength(3);
    expect(artifact.languageResults.every((item) => item.precision >= 0.9 && item.recall >= 0.8 && item.classificationCoverage === 1)).toBe(true);
    expect(artifact.determinism).toMatchObject({ runs: 20, identical: true });
    expect(new Set(artifact.determinism.signatures).size).toBe(1);
    expect(artifact.passed).toBe(true);
  }, 300_000);
});
