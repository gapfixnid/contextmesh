import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const artifactPath = path.resolve(process.argv[2] ?? "artifacts/v04-performance.json");
const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as { git: { commit: string }; thresholds: Record<string, boolean> };
execFileSync("git", ["merge-base", "--is-ancestor", artifact.git.commit, "HEAD"], { stdio: "inherit" });
if (Object.entries(artifact.thresholds).some(([key, value]) => key.endsWith("Passed") && value !== true)) throw new Error("Tracked v0.4 artifact contains a failed threshold");
process.stdout.write(`${JSON.stringify({ artifact: artifactPath, sourceCommit: artifact.git.commit, reachableFromHead: true })}\n`);
