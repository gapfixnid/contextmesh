import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MetadataStatPool } from "../src/code/metadata-stat-pool.js";
import {
  scanWorkspaceMetadata,
  scanWorkspaceMetadataFast,
} from "../src/code/scanner.js";
import { removeFixtureWorkspace, writeWorkspaceFile } from "./helpers.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  for (const target of cleanupPaths.splice(0)) removeFixtureWorkspace(target);
});

describe("workspace metadata scanner", () => {
  it("keeps async fast-mode metadata equivalent to the strict synchronous scan", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "contextmesh-scanner-"));
    cleanupPaths.push(root);
    writeWorkspaceFile(root, ".gitignore", "ignored/\n");
    writeWorkspaceFile(root, ".contextmeshignore", "src/local-only.ts\n");
    writeWorkspaceFile(root, "src/Main.TS", "export const main = true;\n");
    writeWorkspaceFile(root, "src/nested/tool.py", "def tool():\n    return True\n");
    writeWorkspaceFile(root, "src/local-only.ts", "export const localOnly = true;\n");
    writeWorkspaceFile(root, "ignored/hidden.ts", "export const hidden = true;\n");
    writeWorkspaceFile(root, ".env.ts", "export const secret = true;\n");
    writeWorkspaceFile(root, "src/oversized.ts", "x".repeat(64));
    writeWorkspaceFile(root, "README.md", "not a supported source file\n");

    const synchronous = scanWorkspaceMetadata(root, false, 32);
    const pool = new MetadataStatPool();
    let asynchronous: Awaited<ReturnType<typeof scanWorkspaceMetadataFast>>;
    try {
      asynchronous = await scanWorkspaceMetadataFast(root, false, pool, 32);
    } finally {
      pool.dispose();
    }

    expect(asynchronous).toEqual(synchronous);
    expect(asynchronous.files.map((file) => file.relativePath)).toEqual([
      "src/Main.TS",
      "src/nested/tool.py",
    ]);
    expect(asynchronous.diagnostics).toEqual([
      "Skipped oversized file (64 bytes): src/oversized.ts",
    ]);
  });

  it("rejects malformed worker responses instead of trusting incomplete metadata", async () => {
    const pool = new MetadataStatPool({
      workers: 1,
      workerSource: String.raw`
        const { parentPort } = require("node:worker_threads");
        parentPort.on("message", ({ requestId }) => {
          parentPort.postMessage({ requestId, stats: [] });
        });
      `,
    });
    try {
      await expect(pool.inspect(["missing.ts"])).rejects.toThrow("METADATA_STAT_PROTOCOL_INVALID");
      const root = mkdtempSync(path.join(tmpdir(), "contextmesh-scanner-fallback-"));
      cleanupPaths.push(root);
      writeWorkspaceFile(root, "src/fallback.ts", "export const fallback = true;\n");
      await expect(scanWorkspaceMetadataFast(root, true, pool)).resolves.toEqual(
        scanWorkspaceMetadata(root, true),
      );
    } finally {
      pool.dispose();
    }
  });

  it("bounds an unresponsive metadata worker", async () => {
    const pool = new MetadataStatPool({
      workers: 1,
      timeoutMs: 50,
      workerSource: String.raw`
        const { parentPort } = require("node:worker_threads");
        parentPort.on("message", () => {});
      `,
    });
    try {
      await expect(pool.inspect(["missing.ts"])).rejects.toThrow("METADATA_STAT_TIMEOUT");
    } finally {
      pool.dispose();
    }
  });
});
