import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

interface PackFile {
  path: string;
}

interface PackResult {
  filename: string;
  files: PackFile[];
}

const root = process.cwd();
const temporary = mkdtempSync(path.join(os.tmpdir(), "contextmesh-package-verify-"));
if (
  path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir()) ||
  !path.basename(temporary).startsWith("contextmesh-package-verify-")
) {
  throw new Error("Unexpected package verification path");
}
const npmCli = [
  process.env.npm_execpath,
  path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
if (!npmCli) throw new Error("Unable to resolve the npm CLI entry point");
const forbidden = [
  /(?:^|\/)\.env(?:\.|$)/i,
  /(?:^|\/)\.contextmesh(?:\/|$)/i,
  /(?:^|\/)(?:node_modules|\.semantic-smoke-model|cache)(?:\/|$)/i,
  /\.(?:onnx|sqlite3?|db|wal|shm)$/i,
];

try {
  const dryRun = JSON.parse(
    execFileSync(process.execPath, [npmCli, "pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" }),
  ) as PackResult[];
  const files = dryRun[0]?.files.map((file) => file.path.replaceAll("\\", "/")) ?? [];
  if (files.length === 0) throw new Error("npm pack --dry-run produced no files");
  const leaked = files.filter((file) => forbidden.some((pattern) => pattern.test(file)));
  if (leaked.length > 0) throw new Error(`npm package contains forbidden files: ${leaked.join(", ")}`);

  const packed = JSON.parse(
    execFileSync(process.execPath, [npmCli, "pack", "--json", "--pack-destination", temporary], {
      cwd: root,
      encoding: "utf8",
    }),
  ) as PackResult[];
  const archive = path.join(temporary, packed[0]?.filename ?? "");
  const consumer = path.join(temporary, "consumer");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(consumer, { recursive: true }));
  writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({ name: "contextmesh-package-consumer", private: true, type: "module" }),
    "utf8",
  );
  execFileSync(process.execPath, [npmCli, "install", "--ignore-scripts", "--no-audit", "--no-fund", archive], {
    cwd: consumer,
    stdio: "inherit",
  });
  const packageJson = JSON.parse(
    readFileSync(path.join(consumer, "node_modules", "contextmesh", "package.json"), "utf8"),
  ) as { version?: string };
  execFileSync(process.execPath, ["-e", "import('contextmesh').then(m=>{if(!m.ContextMeshApp)process.exit(2)})"], {
    cwd: consumer,
    stdio: "inherit",
  });
  process.stdout.write(
    `${JSON.stringify({ dryRunFiles: files.length, installedVersion: packageJson.version, forbiddenFiles: leaked }, null, 2)}\n`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true, maxRetries: 5 });
}
