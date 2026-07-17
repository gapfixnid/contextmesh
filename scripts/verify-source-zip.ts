import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim();
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
const modelPath = argument("--model-path");
const forbidden = [
  /(?:^|\/)\.env(?:\.|$)/i,
  /(?:^|\/)\.contextmesh(?:\/|$)/i,
  /(?:^|\/)(?:node_modules|\.semantic-smoke-model|cache)(?:\/|$)/i,
  /\.(?:onnx|sqlite3?|db|wal|shm)$/i,
];

try {
  execFileSync("git", ["archive", "--format=zip", `--output=${archive}`, "HEAD"], { cwd: project });
  if (process.platform === "win32") {
    mkdirSync(extracted, { recursive: true });
    execFileSync("tar.exe", ["-xf", archive, "-C", extracted], { stdio: "inherit" });
  } else {
    execFileSync("unzip", ["-q", archive, "-d", extracted], { stdio: "inherit" });
  }
  const files = walk(extracted);
  const leaked = files.filter((file) => forbidden.some((pattern) => pattern.test(file)));
  if (leaked.length > 0) throw new Error(`Source ZIP contains forbidden files: ${leaked.join(", ")}`);
  execFileSync(process.execPath, [npmCli, "ci"], { cwd: extracted, stdio: "inherit" });
  execFileSync(process.execPath, [npmCli, "run", "check"], { cwd: extracted, stdio: "inherit" });
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
