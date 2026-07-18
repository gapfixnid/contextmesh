import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverPythonProject } from "../src/code/languages/python.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Python source-root discovery", () => {
  it("supports package-dir, multiple find.where roots, root/src, and PEP 420 layouts", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-python-layout-")); roots.push(root);
    mkdirSync(path.join(root, "src")); mkdirSync(path.join(root, "lib")); mkdirSync(path.join(root, "vendor"));
    writeFileSync(path.join(root, "pyproject.toml"), [
      "[tool.setuptools.package-dir]", '"" = "src"',
      "[tool.setuptools.packages.find]", 'where = ["lib", "vendor"]', "",
    ].join("\n"));
    expect(discoverPythonProject(root).sourceRoots).toEqual(["", "lib", "src", "vendor"]);
  });

  it("falls back without failing for unsupported dynamic backends", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-python-layout-")); roots.push(root);
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "pyproject.toml"), "[tool.poetry]\nname='demo'\n");
    const project = discoverPythonProject(root);
    expect(project.sourceRoots).toEqual(["", "src"]);
    expect(project.diagnostics[0]).toContain("PYTHON_LAYOUT_FALLBACK");
  });
});
