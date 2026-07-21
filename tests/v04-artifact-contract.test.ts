import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  v04CanonicalSourceEvidence,
  v04SourceDifferencePaths,
  v04SourceEvidence,
} from "../scripts/v04-artifact-contract.js";

const roots: string[] = [];

function stableStringify(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalize(nested)]));
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

function rejectedMutation(mutate: (artifact: Record<string, any>) => void): ReturnType<typeof spawnSync> {
  const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-v04-artifact-contract-"));
  roots.push(root);
  const artifact = JSON.parse(
    readFileSync(path.join(process.cwd(), "artifacts", "v04-performance.json"), "utf8"),
  ) as Record<string, any>;
  mutate(artifact);
  const target = path.join(root, "mutated.json");
  writeFileSync(target, `${stableStringify(artifact)}\n`, "utf8");
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("npm_execpath is required for the artifact verifier contract test");
  return spawnSync(process.execPath, [npmCli, "run", "verify:v04-artifact", "--", target], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    timeout: 60_000,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

describe("v0.4 performance artifact verifier", () => {
  it("ignores Unix core dumps without hiding ordinary untracked source", () => {
    expect(spawnSync("git", ["check-ignore", "-q", "core"], { cwd: process.cwd() }).status).toBe(0);
    expect(spawnSync("git", ["check-ignore", "-q", "core.123"], { cwd: process.cwd() }).status).toBe(0);
    expect(spawnSync("git", ["check-ignore", "-q", "unexpected-source.ts"], { cwd: process.cwd() }).status).not.toBe(0);
  });

  it("canonicalizes artifact-only descendants to the exact non-artifact source commit", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-source-commit-contract-"));
    roots.push(root);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "-b", "main");
    git("config", "user.email", "contextmesh-test@example.invalid");
    git("config", "user.name", "ContextMesh Test");
    writeFileSync(path.join(root, "README.md"), "source one\n", "utf8");
    git("add", "README.md");
    git("commit", "-m", "source");
    const sourceCommit = git("rev-parse", "HEAD");
    mkdirSync(path.join(root, "artifacts"));
    writeFileSync(path.join(root, "artifacts", "evidence.json"), "{}\n", "utf8");
    git("add", "artifacts/evidence.json");
    git("commit", "-m", "artifact");
    expect(v04CanonicalSourceEvidence(root)).toMatchObject({ headCommit: sourceCommit, dirty: false });
    writeFileSync(path.join(root, "README.md"), "source two\n", "utf8");
    git("add", "README.md");
    git("commit", "-m", "source two");
    expect(v04CanonicalSourceEvidence(root)).toMatchObject({ headCommit: git("rev-parse", "HEAD"), dirty: false });
  });
  it("accepts the checked artifact across generated-artifact-only commits", () => {
    const npmCli = process.env.npm_execpath;
    if (!npmCli) throw new Error("npm_execpath is required for the artifact verifier contract test");
    const run = spawnSync(process.execPath, [npmCli, "run", "verify:v04-artifact"], {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
  });

  it("does not bind source evidence to generated release artifacts", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-v04-source-contract-"));
    roots.push(root);
    mkdirSync(path.join(root, "artifacts"), { recursive: true });
    mkdirSync(path.join(root, "evaluation", "artifacts"), { recursive: true });
    writeFileSync(path.join(root, "source.ts"), "export const source = true;\n", "utf8");
    writeFileSync(path.join(root, "artifacts", "v05-quality.json"), "{\"platform\":\"windows\"}\n", "utf8");
    writeFileSync(path.join(root, "evaluation", "artifacts", "mixed-language-v1.json"), "{\"run\":1}\n", "utf8");
    expect(spawnSync("git", ["init"], { cwd: root }).status).toBe(0);
    expect(spawnSync("git", ["add", "source.ts"], { cwd: root }).status).toBe(0);
    expect(spawnSync("git", ["-c", "user.name=ContextMesh Test", "-c", "user.email=contextmesh@example.invalid", "commit", "-m", "fixture"], { cwd: root }).status).toBe(0);

    const before = v04SourceEvidence(root);
    writeFileSync(path.join(root, "artifacts", "v05-quality.json"), "{\"platform\":\"linux\"}\n", "utf8");
    writeFileSync(path.join(root, "evaluation", "artifacts", "mixed-language-v1.json"), "{\"run\":2}\n", "utf8");
    const after = v04SourceEvidence(root);

    expect(after).toEqual(before);
    expect(after.dirty).toBe(false);
  });

  it("records a dirty source snapshot against its exact HEAD", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-v04-dirty-source-contract-"));
    roots.push(root);
    writeFileSync(path.join(root, "source.ts"), "export const source = 1;\n", "utf8");
    expect(spawnSync("git", ["init"], { cwd: root }).status).toBe(0);
    expect(spawnSync("git", ["add", "source.ts"], { cwd: root }).status).toBe(0);
    expect(spawnSync("git", ["-c", "user.name=ContextMesh Test", "-c", "user.email=contextmesh@example.invalid", "commit", "-m", "fixture"], { cwd: root }).status).toBe(0);
    const clean = v04SourceEvidence(root);
    writeFileSync(path.join(root, "source.ts"), "export const source = 2;\n", "utf8");
    const dirty = v04SourceEvidence(root);
    expect(clean.dirty).toBe(false);
    expect(dirty).toMatchObject({ headCommit: clean.headCommit, headTreeDigest: clean.treeDigest, dirty: true });
    expect(dirty.treeDigest).not.toBe(clean.treeDigest);
    expect(v04SourceDifferencePaths(root)).toEqual(["changed:source.ts"]);
    writeFileSync(path.join(root, "added.ts"), "export const added = true;\n", "utf8");
    expect(v04SourceDifferencePaths(root)).toEqual(["added:added.ts", "changed:source.ts"]);
  });

  it("rejects evidence bound to a stale source tree", () => {
    const run = rejectedMutation((artifact) => {
      artifact.source = { ...artifact.source, treeDigest: "0".repeat(64), files: 1 };
    });
    expect(run.status, `${run.stdout}\n${run.stderr}`).not.toBe(0);
  });

  it("rejects an artifact that claims a dirty measurement source", () => {
    const run = rejectedMutation((artifact) => {
      artifact.source = { ...artifact.source, dirty: true };
    });
    expect(run.status, `${run.stdout}\n${run.stderr}`).not.toBe(0);
  });

  it("rejects a native runtime version that does not match the measured handshake", () => {
    const run = rejectedMutation((artifact) => {
      artifact.runner.native = "contextmesh-graph-kernel@0.0.0";
    });
    expect(run.status, `${run.stdout}\n${run.stderr}`).not.toBe(0);
  });

  it("rejects evidence from outside the canonical fixed hardware profile", () => {
    const run = rejectedMutation((artifact) => {
      artifact.runner.cpu = "generic hosted CPU";
      artifact.runner.logicalCpus = 2;
      artifact.runner.ramBytes = 4 * 1024 * 1024 * 1024;
      artifact.runner.hardwareProfile = "unqualified-host";
      artifact.runner.powerSchemeGuid = "unknown";
    });
    expect(run.status, `${run.stdout}\n${run.stderr}`).not.toBe(0);
  });
});
