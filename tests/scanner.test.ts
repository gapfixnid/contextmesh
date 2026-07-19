import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  scanWorkspaceMetadata,
  scanWorkspaceMetadataAsync,
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
    const asynchronous = await scanWorkspaceMetadataAsync(root, false, 32);

    expect(asynchronous).toEqual(synchronous);
    expect(asynchronous.files.map((file) => file.relativePath)).toEqual([
      "src/Main.TS",
      "src/nested/tool.py",
    ]);
    expect(asynchronous.diagnostics).toEqual([
      "Skipped oversized file (64 bytes): src/oversized.ts",
    ]);
  });
});
