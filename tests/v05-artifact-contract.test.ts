import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { stableStringify } from "../scripts/v04-artifact-contract.js";

const roots: string[] = [];

function runVerifier(artifactPath?: string): ReturnType<typeof spawnSync> {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("npm_execpath is required for the v0.5 artifact verifier contract test");
  const args = [npmCli, "run", "verify:v05-artifact"];
  if (artifactPath) args.push("--", artifactPath);
  return spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    timeout: 60_000,
  });
}

function rejectedMutation(mutate: (artifact: Record<string, any>) => void): ReturnType<typeof spawnSync> {
  const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-v05-artifact-contract-"));
  roots.push(root);
  const artifact = JSON.parse(readFileSync(path.join(process.cwd(), "artifacts", "v05-quality.json"), "utf8")) as Record<string, any>;
  mutate(artifact);
  const target = path.join(root, "mutated.json");
  writeFileSync(target, `${JSON.stringify(JSON.parse(stableStringify(artifact)), null, 2)}\n`, "utf8");
  return runVerifier(target);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

describe("v0.5 quality artifact verifier", () => {
  it("accepts the checked artifact only when it represents the current exact source", () => {
    const run = runVerifier();
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
  });

  it("rejects a provider-absence run that does not match the exact base graph", () => {
    const run = rejectedMutation((artifact) => {
      artifact.providerAbsence[0].actualBaseDigest = "0".repeat(64);
      artifact.providerAbsence[0].exactBaseGraph = true;
      artifact.providerAbsence[0].preservesBase = true;
    });
    expect(run.status, `${run.stdout}\n${run.stderr}`).not.toBe(0);
  });

  it("rejects fabricated v0.5 determinism evidence", () => {
    const run = rejectedMutation((artifact) => {
      artifact.determinism.identical = true;
      artifact.determinism.signatures[19] = "f".repeat(64);
    });
    expect(run.status, `${run.stdout}\n${run.stderr}`).not.toBe(0);
  });
});
