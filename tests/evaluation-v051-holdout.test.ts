import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";
import { stableStringify, v04CommitSourceManifest } from "../scripts/v04-artifact-contract.js";

function sourceManifest(commit: string): Array<{ path: string; sha256: string }> {
  const embedded = path.join(process.cwd(), "SOURCE_MANIFEST.json");
  if (existsSync(embedded)) {
    return JSON.parse(readFileSync(embedded, "utf8")) as Array<{ path: string; sha256: string }>;
  }
  return v04CommitSourceManifest(commit);
}

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

const fixturePath = path.join(process.cwd(), "evaluation", "fixtures", "v051-external-holdout-v3.json");
const corpusRoot = path.join(process.cwd(), "evaluation", "fixtures", "v051-external-corpus-v1");
const hasGo = spawnSync("go", ["version"], { encoding: "utf8", windowsHide: true }).status === 0;

describe("v0.5.1 external holdout release contract", () => {
  it("pins licensed upstream source bytes and non-synthetic repository profiles", () => {
    expect(existsSync(fixturePath)).toBe(true);
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as ExternalFixture;
    expect(fixture).toMatchObject({
      schemaVersion: 3,
      id: "contextmesh-v051-external-holdout-v3",
      immutable: true,
      thresholds: { precision: 0.9, recall: 0.8, classificationCoverage: 1 },
    });
    expect(fixture.repositories.map((item) => item.repository).sort()).toEqual([
      "kubernetes/client-go",
      "nrwl/nx",
      "pallets/flask",
      "rust-lang/rustlings",
    ]);
    expect(new Set(fixture.repositories.flatMap((item) => item.profiles))).toEqual(
      new Set(["complex-src-layout", "generated-code", "large-monorepo", "multi-binary-workspace"]),
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
    expect(fixture.cases.length).toBeGreaterThanOrEqual(24);
    for (const language of ["typescript", "python", "go", "rust"]) {
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
    expect(run.stdout).not.toContain('"lastError"');
    expect(run.stdout).toContain('"passed":true');
    const artifact = JSON.parse(readFileSync(output, "utf8")) as {
      release: string;
      fixture: { repositoryCount: number; caseCount: number; profiles: string[] };
      languageResults: Array<{ language: string; precision: number; recall: number; classificationCoverage: number }>;
      determinism: { scope: string; runs: number; identical: boolean; signatures: string[] };
      passed: boolean;
    };
    expect(artifact.release).toBe("v0.5.1");
    expect(artifact.fixture).toMatchObject({ repositoryCount: 4 });
    expect(artifact.fixture.caseCount).toBeGreaterThanOrEqual(24);
    expect(new Set(artifact.fixture.profiles)).toEqual(new Set(["complex-src-layout", "generated-code", "large-monorepo", "multi-binary-workspace"]));
    expect(artifact.languageResults).toHaveLength(4);
    expect(artifact.languageResults.every((item) => item.precision >= 0.9 && item.recall >= 0.8 && item.classificationCoverage === 1)).toBe(true);
    expect(artifact.determinism).toMatchObject({
      scope: "20 fresh Node processes with independent application, database, and materialized workspace instances",
      runs: 20,
      identical: true,
    });
    expect(new Set(artifact.determinism.signatures).size).toBe(1);
    expect(artifact.passed).toBe(true);
  }, 300_000);

  it("rejects archive evidence that names a different source commit than the artifact", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-v051-archive-contract-"));
    try {
      const fixtureDirectory = path.join(root, "evaluation", "fixtures");
      mkdirSync(fixtureDirectory, { recursive: true });
      cpSync(fixturePath, path.join(fixtureDirectory, path.basename(fixturePath)));
      cpSync(corpusRoot, path.join(fixtureDirectory, path.basename(corpusRoot)), { recursive: true });
      const artifactPath = path.join(root, "artifact.json");
      cpSync(path.join(process.cwd(), "artifacts", "v051-external-holdout.json"), artifactPath);
      const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as { source: Record<string, unknown> };
      const mismatchedCommit = "a".repeat(40);
      writeFileSync(path.join(root, "SOURCE_COMMIT"), mismatchedCommit, "utf8");
      writeFileSync(path.join(root, "SOURCE_EVIDENCE.json"), JSON.stringify({
        ...artifact.source,
        headCommit: mismatchedCommit,
      }), "utf8");
      const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
      const run = spawnSync(process.execPath, [tsxCli, path.join(process.cwd(), "scripts", "verify-v051-holdout.ts"), artifactPath], {
        cwd: root, env: process.env, encoding: "utf8", timeout: 60_000,
      });
      expect(run.status).not.toBe(0);
      expect(`${run.stdout}\n${run.stderr}`).toMatch(/archive source evidence mismatch/);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("rehashes archive source files instead of trusting embedded evidence", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-v051-archive-tamper-"));
    try {
      const artifact = JSON.parse(
        readFileSync(path.join(process.cwd(), "artifacts", "v051-external-holdout.json"), "utf8"),
      ) as { source: { headCommit: string } & Record<string, unknown> };
      const manifest = sourceManifest(artifact.source.headCommit);
      for (const item of manifest) {
        const target = path.join(root, item.path);
        mkdirSync(path.dirname(target), { recursive: true });
        cpSync(path.join(process.cwd(), item.path), target);
      }
      const artifactPath = path.join(root, "artifacts", "v051-external-holdout.json");
      mkdirSync(path.dirname(artifactPath), { recursive: true });
      cpSync(path.join(process.cwd(), "artifacts", "v051-external-holdout.json"), artifactPath);
      writeFileSync(path.join(root, "SOURCE_COMMIT"), artifact.source.headCommit, "utf8");
      writeFileSync(path.join(root, "SOURCE_EVIDENCE.json"), JSON.stringify(artifact.source), "utf8");
      writeFileSync(path.join(root, "SOURCE_MANIFEST.json"), `${stableStringify(manifest)}\n`, "utf8");
      appendFileSync(path.join(root, "README.md"), "\narchive tamper\n", "utf8");
      const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
      const run = spawnSync(process.execPath, [tsxCli, path.join(process.cwd(), "scripts", "verify-v051-holdout.ts"), artifactPath], {
        cwd: root, env: process.env, encoding: "utf8", timeout: 60_000,
      });
      expect(run.status).not.toBe(0);
      expect(`${run.stdout}\n${run.stderr}`).toMatch(/archive source file does not match manifest/);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
