import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("Python parser supply chain", () => {
  it("pins package integrity and the exact grammar WASM", () => {
    const manifest = JSON.parse(readFileSync(path.join(process.cwd(), "docs", "python-parser.manifest.json"), "utf8")) as {
      packages: Record<string, { version: string; integrity: string }>;
      artifacts: Record<string, { sha256: string }>;
    };
    const packageLock = JSON.parse(readFileSync(path.join(process.cwd(), "package-lock.json"), "utf8")) as {
      packages: Record<string, { version?: string; integrity?: string }>;
    };
    for (const [name, expected] of Object.entries(manifest.packages)) {
      expect(packageLock.packages[`node_modules/${name}`]).toMatchObject(expected);
    }
    const wasm = readFileSync(path.join(process.cwd(), "node_modules", "tree-sitter-python", "tree-sitter-python.wasm"));
    expect(createHash("sha256").update(wasm).digest("hex")).toBe(manifest.artifacts["tree-sitter-python.wasm"]?.sha256);
  });
});
