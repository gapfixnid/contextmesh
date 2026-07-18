import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverPythonProject } from "../src/code/languages/python.js";
import { ContextMeshApp } from "../src/app.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Python source-root discovery", () => {
  it.each([
    { name: "non-empty mapping", mapping: 'acme = "lib"', root: "lib", expected: ["acme", "acme.helper"] },
    { name: "empty root mapping", mapping: '"" = "src"', root: "src/acme", expected: ["acme", "acme.helper"] },
  ])("indexes canonical modules and relative imports for $name", async ({ mapping, root: packageRoot, expected }) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-python-package-dir-")); roots.push(root);
    mkdirSync(path.join(root, packageRoot), { recursive: true });
    writeFileSync(path.join(root, "pyproject.toml"), `[tool.setuptools.package-dir]\n${mapping}\n`);
    writeFileSync(path.join(root, packageRoot, "__init__.py"), "from . import helper\n");
    writeFileSync(path.join(root, packageRoot, "helper.py"), "VALUE = 1\n");
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const graph = app.database.getStoredGraphPartition("python");
      const modules = graph.nodes.filter((node) => node.kind === "module");
      expect(modules.map((node) => node.name).sort()).toEqual(expected);
      const byId = new Map(modules.map((node) => [node.id, node.name]));
      expect(graph.edges).toContainEqual(expect.objectContaining({
        kind: "IMPORTS", confidence: 0.95,
        sourceId: modules.find((node) => node.name === "acme")!.id,
        targetId: modules.find((node) => node.name === "acme.helper")!.id,
      }));
      expect(graph.edges.some((edge) => edge.kind === "IMPORTS" && byId.get(edge.sourceId) === byId.get(edge.targetId))).toBe(false);
      const firstIds = modules.map((node) => [node.localKey, node.id]).sort();
      await app.indexWorkspace({ mode: "full" });
      const repeated = app.database.getStoredGraphPartition("python").nodes
        .filter((node) => node.kind === "module").map((node) => [node.localKey, node.id]).sort();
      expect(repeated).toEqual(firstIds);
    } finally {
      await app.close();
    }
  });

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
