import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { inspectBundleTarball, type BundleManifest } from "./bundle-archive.js";

interface PackResult {
  filename: string;
}

function npmCli(): string {
  const resolved = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
  if (!resolved) throw new Error("Unable to resolve the npm CLI entry point");
  return resolved;
}

function roundUp(value: number, quantum: number): number {
  return Math.ceil(value / quantum) * quantum;
}

const root = process.cwd();
const temporary = mkdtempSync(path.join(os.tmpdir(), "contextmesh-bundle-manifest-"));
try {
  const packed = JSON.parse(
    execFileSync(process.execPath, [npmCli(), "pack", "--json", "--pack-destination", temporary], {
      cwd: root,
      encoding: "utf8",
    }),
  ) as PackResult[];
  const archive = path.join(temporary, packed[0]?.filename ?? "");
  const summary = inspectBundleTarball(archive);
  const manifest: BundleManifest = {
    schemaVersion: 1,
    directBundles: ["@modelcontextprotocol/sdk"],
    baseline: {
      packedSizeBytes: summary.packedSizeBytes,
      unpackedSizeBytes: summary.unpackedSizeBytes,
      bundledPackageCount: summary.bundledPackageCount,
      bundledFileCount: summary.bundledFileCount,
    },
    limits: {
      maxPackedSizeBytes: roundUp(summary.packedSizeBytes * 1.25, 100_000),
      maxUnpackedSizeBytes: roundUp(summary.unpackedSizeBytes * 1.25, 500_000),
      maxBundledPackageCount: summary.bundledPackageCount + 5,
      maxBundledFileCount: roundUp(summary.bundledFileCount * 1.1, 100),
    },
    bundledTreeSha256: summary.bundledTreeSha256,
    packages: summary.packages,
  };
  const output = path.join(root, "scripts", "bundled-sdk-manifest.json");
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output, ...manifest.baseline, ...manifest.limits }, null, 2)}\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true, maxRetries: 5 });
}
