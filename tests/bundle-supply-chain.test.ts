import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  inspectBundleTarball,
  verifyBundleSummary,
  type BundleArchiveSummary,
  type BundleManifest,
} from "../scripts/bundle-archive.js";

function octal(value: number, length: number): Buffer {
  return Buffer.from(`${value.toString(8).padStart(length - 1, "0")}\0`, "ascii");
}

function tarHeader(name: string, type: string, size = 0, link = ""): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  octal(0o644, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(size, 12).copy(header, 124);
  octal(0, 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write(link, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(header, 148);
  return header;
}

function archive(entries: Array<{ name: string; type?: string; data?: string; link?: string }>): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? "", "utf8");
    chunks.push(tarHeader(entry.name, entry.type ?? "0", data.length, entry.link));
    chunks.push(data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function inspectSynthetic(entries: Array<{ name: string; type?: string; data?: string; link?: string }>): void {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "contextmesh-bundle-test-"));
  try {
    const archivePath = path.join(temporary, "fixture.tgz");
    writeFileSync(archivePath, archive(entries));
    inspectBundleTarball(archivePath);
  } finally {
    rmSync(temporary, { recursive: true, force: true, maxRetries: 5 });
  }
}

function manifest(): BundleManifest {
  return JSON.parse(
    readFileSync(path.join(process.cwd(), "scripts", "bundled-sdk-manifest.json"), "utf8"),
  ) as BundleManifest;
}

function summaryFromManifest(value: BundleManifest): BundleArchiveSummary {
  return {
    packedSizeBytes: value.baseline.packedSizeBytes,
    unpackedSizeBytes: value.baseline.unpackedSizeBytes,
    bundledPackageCount: value.baseline.bundledPackageCount,
    bundledFileCount: value.baseline.bundledFileCount,
    bundledTreeSha256: value.bundledTreeSha256,
    packages: structuredClone(value.packages),
    files: [],
    rootPackageJson: {
      dependencies: { "@modelcontextprotocol/sdk": "1.29.0" },
      bundleDependencies: ["@modelcontextprotocol/sdk"],
      overrides: { "@modelcontextprotocol/sdk": { "@hono/node-server": "2.0.11" } },
    },
  };
}

describe("bundled SDK supply-chain contract", () => {
  it("pins all three content-type instances by path, version, and digest", () => {
    const contentType = manifest().packages
      .filter((item) => item.name === "content-type")
      .map((item) => ({ path: item.path, version: item.version, digest: item.contentSha256 }));
    expect(contentType).toEqual([
      {
        path: "node_modules/body-parser/node_modules/content-type",
        version: "2.0.0",
        digest: "db681a2f1eecf61ca84e98a23de5adb23086e0a02c2c96f9cad36208e2ef1120",
      },
      {
        path: "node_modules/content-type",
        version: "1.0.5",
        digest: "7e96562b841c512abcf7dae465d3568243f876183222e4df7b835119b9598ca2",
      },
      {
        path: "node_modules/type-is/node_modules/content-type",
        version: "2.0.0",
        digest: "db681a2f1eecf61ca84e98a23de5adb23086e0a02c2c96f9cad36208e2ef1120",
      },
    ]);
  });

  it("rejects an added instance, version, digest, or lifecycle script", () => {
    const approved = manifest();
    for (const mutate of [
      (summary: BundleArchiveSummary) => summary.packages.push({ ...summary.packages[0]!, path: "node_modules/extra" }),
      (summary: BundleArchiveSummary) => { summary.packages[0]!.version = "999.0.0"; },
      (summary: BundleArchiveSummary) => { summary.packages[0]!.contentSha256 = "0".repeat(64); },
      (summary: BundleArchiveSummary) => { summary.packages[0]!.lifecycleScripts.install = "node install.js"; },
    ]) {
      const summary = summaryFromManifest(approved);
      mutate(summary);
      expect(() => verifyBundleSummary(summary, approved)).toThrow();
    }
  });

  it("rejects path traversal, symlinks, and case collisions in the tarball", () => {
    expect(() => inspectSynthetic([{ name: "package/../escape", data: "x" }])).toThrow(/Unsafe tar path/);
    expect(() => inspectSynthetic([
      { name: "package/node_modules/example/link", type: "2", link: "../../../../escape" },
    ])).toThrow(/links are prohibited/);
    expect(() => inspectSynthetic([
      { name: "package/Example", data: "a" },
      { name: "package/example", data: "b" },
    ])).toThrow(/Case-colliding/);
  });
});
