import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  stableStringify,
  v04CommitSourceManifest,
  v04SourceEvidence,
  verifyV04ArchiveSourceManifest,
} from "./v04-artifact-contract.js";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? path.resolve(process.argv[index + 1]!) : null;
}

function walk(root: string, current = root): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(current)) {
    const absolute = path.join(current, entry);
    if (statSync(absolute).isDirectory()) result.push(...walk(root, absolute));
    else result.push(path.relative(root, absolute).replaceAll("\\", "/"));
  }
  return result;
}

const project = process.cwd();
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: project, encoding: "utf8" }).trim();
if (dirty) throw new Error("Source ZIP verification requires a clean worktree");
const archiveCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim();
const currentEvidence = v04SourceEvidence(project);
if (currentEvidence.headCommit !== archiveCommit || currentEvidence.dirty) {
  throw new Error("Source ZIP evidence must identify the clean current HEAD");
}
const releaseEvidence = ["artifacts/v04-performance.json", "artifacts/v05-quality.json", "artifacts/v051-external-holdout.json"]
  .map((file) => JSON.parse(readFileSync(path.join(project, file), "utf8")) as {
    source: typeof currentEvidence;
  })
  .map((artifact) => artifact.source);
const sourceEvidence = releaseEvidence[0]!;
if (!releaseEvidence.every((evidence) =>
  evidence.headCommit === sourceEvidence.headCommit &&
  evidence.treeDigest === sourceEvidence.treeDigest &&
  evidence.files === sourceEvidence.files &&
  evidence.dirty === false) ||
  currentEvidence.treeDigest !== sourceEvidence.treeDigest || currentEvidence.files !== sourceEvidence.files) {
  throw new Error("Release artifacts must identify one exact non-artifact source commit and the current source tree");
}
const sourceCommit = sourceEvidence.headCommit;
execFileSync("git", ["merge-base", "--is-ancestor", sourceCommit, archiveCommit], { cwd: project, stdio: "inherit" });
execFileSync("git", [
  "diff", "--quiet", sourceCommit, archiveCommit, "--", ".",
  ":(exclude)artifacts/**", ":(exclude)evaluation/artifacts/**",
], { cwd: project, stdio: "inherit" });
const temporary = mkdtempSync(path.join(os.tmpdir(), "contextmesh-source-zip-"));
if (
  path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir()) ||
  !path.basename(temporary).startsWith("contextmesh-source-zip-")
) {
  throw new Error("Unexpected source ZIP verification path");
}
const npmCli = [
  process.env.npm_execpath,
  path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
if (!npmCli) throw new Error("Unable to resolve the npm CLI entry point");
const archive = path.join(temporary, "contextmesh-source.zip");
const extracted = path.join(temporary, "extracted");
const sourceManifestPath = path.join(temporary, "SOURCE_MANIFEST.json");
writeFileSync(sourceManifestPath, `${stableStringify(v04CommitSourceManifest(sourceCommit, project))}\n`, "utf8");
const modelPath = argument("--model-path");
const forbidden = [
  /(?:^|\/)\.env(?:\.|$)/i,
  /(?:^|\/)\.contextmesh(?:\/|$)/i,
  /(?:^|\/)(?:node_modules|\.semantic-smoke-model|cache)(?:\/|$)/i,
  /\.(?:onnx|sqlite3?|db|wal|shm)$/i,
];

try {
  execFileSync(
    "git",
    [
      "archive",
      "--format=zip",
      `--add-virtual-file=ARCHIVE_COMMIT:${archiveCommit}`,
      `--add-virtual-file=SOURCE_COMMIT:${sourceCommit}`,
      `--add-virtual-file=SOURCE_EVIDENCE.json:${stableStringify(sourceEvidence)}`,
      `--add-file=${sourceManifestPath}`,
      `--output=${archive}`,
      "HEAD",
    ],
    { cwd: project },
  );
  if (process.platform === "win32") {
    mkdirSync(extracted, { recursive: true });
    execFileSync("tar.exe", ["-xf", archive, "-C", extracted], { stdio: "inherit" });
  } else {
    execFileSync("unzip", ["-q", archive, "-d", extracted], { stdio: "inherit" });
  }
  const files = walk(extracted);
  const expectedFiles = execFileSync("git", ["ls-tree", "-rz", "--name-only", archiveCommit], {
    cwd: project, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  }).split("\0").filter(Boolean).map((file) => file.replaceAll("\\", "/"))
    .concat(["ARCHIVE_COMMIT", "SOURCE_COMMIT", "SOURCE_EVIDENCE.json", "SOURCE_MANIFEST.json"])
    .sort((left, right) => left.localeCompare(right));
  if (stableStringify([...files].sort((left, right) => left.localeCompare(right))) !== stableStringify(expectedFiles)) {
    throw new Error("Source ZIP file list differs from the exact archive commit");
  }
  if (readFileSync(path.join(extracted, "SOURCE_COMMIT"), "utf8") !== sourceCommit) {
    throw new Error("Source ZIP commit provenance does not match HEAD");
  }
  verifyV04ArchiveSourceManifest(sourceEvidence, extracted);
  const leaked = files.filter((file) => forbidden.some((pattern) => pattern.test(file)));
  if (leaked.length > 0) throw new Error(`Source ZIP contains forbidden files: ${leaked.join(", ")}`);
  execFileSync(process.execPath, [npmCli, "ci"], { cwd: extracted, stdio: "inherit" });
  execFileSync(process.execPath, [npmCli, "run", "check"], { cwd: extracted, stdio: "inherit" });
  execFileSync(process.execPath, [npmCli, "run", "verify:v04-artifact"], { cwd: extracted, stdio: "inherit" });
  execFileSync(process.execPath, [npmCli, "run", "verify:v05-artifact"], { cwd: extracted, stdio: "inherit" });
  execFileSync(process.execPath, [npmCli, "run", "verify:v051-holdout"], { cwd: extracted, stdio: "inherit" });
  execFileSync(process.execPath, [npmCli, "run", "verify:package"], { cwd: extracted, stdio: "inherit" });

  if (modelPath) {
    if (!existsSync(modelPath)) throw new Error(`External approved model cache is missing: ${modelPath}`);
    const relative = path.relative(extracted, modelPath);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      throw new Error("The approved model cache must remain outside the extracted source ZIP");
    }
    execFileSync(process.execPath, [npmCli, "run", "smoke:semantic", "--", "--model-path", modelPath], {
      cwd: extracted,
      stdio: "inherit",
    });
    execFileSync(
      process.execPath,
      [
        npmCli,
        "run",
        "evaluate:quality",
        "--",
        "--fixture",
        "acceptance-v2",
        "--semantic-model",
        modelPath,
        "--source-commit",
        sourceCommit,
      ],
      {
        cwd: extracted,
        stdio: "inherit",
        env: { ...process.env, SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH ?? "1784246400" },
      },
    );
  }
  process.stdout.write(
    `${JSON.stringify({ archive, files: files.length, forbiddenFiles: leaked, externalModelVerified: Boolean(modelPath) }, null, 2)}\n`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true, maxRetries: 5 });
}
