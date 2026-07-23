import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  inspectBundleTarball,
  inspectInstalledBundle,
  verifyBundleSummary,
  type BundleManifest,
} from "./bundle-archive.js";

interface PackFile {
  path: string;
}

interface PackResult {
  filename: string;
  files: PackFile[];
  size: number;
  unpackedSize: number;
  bundled: string[];
}

interface InstalledPackage {
  name: string;
  version: string;
  path: string;
}

interface NpmTree {
  problems?: string[];
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
const resolvedNpmCli = npmCli;
const forbidden = [
  /(?:^|\/)\.env(?:\.|$)/i,
  /(?:^|\/)\.contextmesh(?:\/|$)/i,
  /(?:^|\/)(?:\.semantic-smoke-model|cache)(?:\/|$)/i,
  /\.(?:onnx|sqlite3?|db|wal|shm)$/i,
];

function installedPackages(nodeModulesRoot: string, consumerRoot: string): InstalledPackage[] {
  const result: InstalledPackage[] = [];
  const visited = new Set<string>();
  const visitNodeModules = (directory: string): void => {
    if (!existsSync(directory)) return;
    const canonical = path.resolve(directory).toLowerCase();
    if (visited.has(canonical)) return;
    visited.add(canonical);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".bin" || entry.name.startsWith(".")) continue;
      const first = path.join(directory, entry.name);
      const packageRoots = entry.name.startsWith("@")
        ? readdirSync(first, { withFileTypes: true })
            .filter((child) => child.isDirectory())
            .map((child) => path.join(first, child.name))
        : [first];
      for (const packageRoot of packageRoots) {
        if (lstatSync(packageRoot).isSymbolicLink()) throw new Error(`Consumer package symlink is prohibited: ${packageRoot}`);
        const packageJsonPath = path.join(packageRoot, "package.json");
        if (!existsSync(packageJsonPath)) continue;
        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown; version?: unknown };
        if (typeof packageJson.name !== "string" || typeof packageJson.version !== "string") {
          throw new Error(`Invalid installed package metadata: ${packageRoot}`);
        }
        result.push({
          name: packageJson.name,
          version: packageJson.version,
          path: path.relative(consumerRoot, packageRoot).replaceAll("\\", "/"),
        });
        visitNodeModules(path.join(packageRoot, "node_modules"));
      }
    }
  };
  visitNodeModules(nodeModulesRoot);
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function requireExactInstance(
  packages: InstalledPackage[],
  name: string,
  version: string,
  pathSuffix: string,
): void {
  const matches = packages.filter((item) => item.name === name);
  if (
    matches.length !== 1 ||
    matches[0]?.version !== version ||
    !matches[0].path.endsWith(pathSuffix)
  ) {
    throw new Error(`Unexpected consumer instances for ${name}: ${JSON.stringify(matches)}`);
  }
}

function npmJsonAllowingKnownHonoOverride(arguments_: string[], cwd: string): NpmTree {
  try {
    return JSON.parse(
      execFileSync(process.execPath, [resolvedNpmCli, ...arguments_], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ) as NpmTree;
  } catch (error) {
    const stdout = (error as { stdout?: string | Buffer }).stdout;
    const text = typeof stdout === "string" ? stdout : stdout instanceof Buffer ? stdout.toString("utf8") : "";
    if (!text) throw error;
    const tree = JSON.parse(text) as NpmTree;
    const problems = tree.problems ?? [];
    if (
      problems.length === 0 ||
      problems.some((problem) => !problem.includes("invalid: @hono/node-server@2.0.11"))
    ) {
      throw error;
    }
    return tree;
  }
}

try {
  const dryRun = JSON.parse(
    execFileSync(process.execPath, [npmCli, "pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" }),
  ) as PackResult[];
  const files = dryRun[0]?.files.map((file) => file.path.replaceAll("\\", "/")) ?? [];
  if (files.length === 0) throw new Error("npm pack --dry-run produced no files");
  const leaked = files.filter(
    (file) => !file.startsWith("node_modules/") && forbidden.some((pattern) => pattern.test(file)),
  );
  if (leaked.length > 0) throw new Error(`npm package contains forbidden files: ${leaked.join(", ")}`);

  const packed = JSON.parse(
    execFileSync(process.execPath, [npmCli, "pack", "--json", "--pack-destination", temporary], {
      cwd: root,
      encoding: "utf8",
    }),
  ) as PackResult[];
  const archive = path.join(temporary, packed[0]?.filename ?? "");
  const manifest = JSON.parse(
    readFileSync(path.join(root, "scripts", "bundled-sdk-manifest.json"), "utf8"),
  ) as BundleManifest;
  const archiveSummary = inspectBundleTarball(archive);
  verifyBundleSummary(archiveSummary, manifest);
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
  const installedRoot = path.join(consumer, "node_modules", "contextmesh");
  const installedSummary = inspectInstalledBundle(installedRoot);
  verifyBundleSummary(installedSummary, manifest);
  const installed = installedPackages(path.join(consumer, "node_modules"), consumer);
  requireExactInstance(
    installed,
    "@modelcontextprotocol/sdk",
    "1.29.0",
    "node_modules/contextmesh/node_modules/@modelcontextprotocol/sdk",
  );
  requireExactInstance(
    installed,
    "@hono/node-server",
    "2.0.11",
    "node_modules/contextmesh/node_modules/@hono/node-server",
  );
  requireExactInstance(
    installed,
    "fast-uri",
    "3.1.4",
    "node_modules/contextmesh/node_modules/fast-uri",
  );
  if (installed.some((item) => item.name === "@hono/node-server" && item.version.startsWith("1."))) {
    throw new Error("Consumer tree contains @hono/node-server 1.x");
  }
  const npmTree = npmJsonAllowingKnownHonoOverride(["ls", "--all", "--json"], consumer);
  const dedupe = npmJsonAllowingKnownHonoOverride(["find-dupes", "--json"], consumer) as NpmTree & {
    added?: number;
    changed?: number;
    removed?: number;
  };
  if ((dedupe.added ?? 0) !== 0 || (dedupe.changed ?? 0) !== 0 || (dedupe.removed ?? 0) !== 0) {
    throw new Error(`Consumer bundle is unexpectedly deduplicable: ${JSON.stringify(dedupe)}`);
  }
  execFileSync(process.execPath, ["-e", "import('contextmesh').then(m=>{if(!m.ContextMeshApp)process.exit(2)})"], {
    cwd: consumer,
    stdio: "inherit",
  });
  const smokeWorkspace = path.join(temporary, "native-consumer-workspace");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(smokeWorkspace, { recursive: true }));
  writeFileSync(path.join(smokeWorkspace, "only.py"), "def packaged_kernel():\n    return 1\n", "utf8");
  writeFileSync(
    path.join(consumer, "native-smoke.mjs"),
    `import { ContextMeshApp } from "contextmesh";
const app = new ContextMeshApp(${JSON.stringify(smokeWorkspace)});
try {
  await app.indexWorkspace({ mode: "full" });
  const result = await app.searchCode({ query: "packaged_kernel" });
  if (result.data.results.length !== 1) process.exitCode = 3;
} finally { await app.close(); }
`,
    "utf8",
  );
  execFileSync(process.execPath, [path.join(consumer, "native-smoke.mjs")], { cwd: consumer, stdio: "inherit" });
  writeFileSync(
    path.join(consumer, "stdio-smoke.mjs"),
    `import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const entry = fileURLToPath(import.meta.resolve("contextmesh"));
const packageRoot = path.resolve(path.dirname(entry), "..");
const sdkRoot = path.join(packageRoot, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");
const { Client } = await import(pathToFileURL(path.join(sdkRoot, "client", "index.js")));
const { StdioClientTransport } = await import(pathToFileURL(path.join(sdkRoot, "client", "stdio.js")));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(packageRoot, "dist", "cli.js"), "serve", "--workspace", ${JSON.stringify(smokeWorkspace)}, "--no-auto-index"],
  stderr: "pipe",
});
const client = new Client({ name: "contextmesh-package-stdio-smoke", version: "1.0.0" });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const actualTools = tools.tools.map((tool) => tool.name).sort();
  const expectedTools = [
    "explore_context",
    "forget",
    "get_context",
    "impact_analysis",
    "impact_code",
    "index_workspace",
    "recall",
    "reflect",
    "remember",
    "search_code",
    "trace_code",
    "workspace_status",
  ].sort();
  if (JSON.stringify(actualTools) !== JSON.stringify(expectedTools)) process.exitCode = 4;
  const status = await client.callTool({ name: "workspace_status", arguments: {} });
  if (status.isError) process.exitCode = 5;
} finally { await client.close(); }
`,
    "utf8",
  );
  execFileSync(process.execPath, [path.join(consumer, "stdio-smoke.mjs")], { cwd: consumer, stdio: "inherit" });
  execFileSync(
    process.execPath,
    ["--import", "tsx", path.join(root, "scripts", "audit-production.ts"), "--cwd", consumer],
    { cwd: root, stdio: "inherit" },
  );
  process.stdout.write(
    `${JSON.stringify({
      dryRunFiles: files.length,
      installedVersion: packageJson.version,
      forbiddenFiles: leaked,
      packedSizeBytes: archiveSummary.packedSizeBytes,
      unpackedSizeBytes: archiveSummary.unpackedSizeBytes,
      bundledPackageCount: archiveSummary.bundledPackageCount,
      bundledFileCount: archiveSummary.bundledFileCount,
      bundledTreeSha256: archiveSummary.bundledTreeSha256,
      npmTreeProblems: npmTree.problems ?? [],
    }, null, 2)}\n`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true, maxRetries: 5 });
}
