import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverPythonProject } from "../src/code/languages/python.js";
import { ContextMeshApp } from "../src/app.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Python source-root discovery", () => {
  it("keeps a missing pure-relative submodule unresolved without a self import", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-python-missing-relative-")); roots.push(root);
    mkdirSync(path.join(root, "src", "pkg"), { recursive: true });
    writeFileSync(path.join(root, "pyproject.toml"), '[tool.setuptools.package-dir]\n"" = "src"\n');
    writeFileSync(path.join(root, "src", "pkg", "__init__.py"), "from . import missing_helper\n");
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const graph = app.database.getStoredGraphPartition("python");
      const pkg = graph.nodes.find((node) => node.kind === "module" && node.name === "pkg")!;
      expect(graph.edges.filter((edge) => edge.kind === "IMPORTS" && edge.sourceId === pkg.id)).toHaveLength(0);
      expect(graph.edges.some((edge) => edge.kind === "IMPORTS" && edge.sourceId === edge.targetId)).toBe(false);
      expect(graph.unresolvedReferences).toContainEqual(expect.objectContaining({
        sourceNodeId: pkg.id, kind: "IMPORTS", rawName: ". import missing_helper", confidence: 0.5,
        evidence: [expect.objectContaining({ source: "syntax", confidence: 0.5 })],
      }));
    } finally { await app.close(); }
  });

  it("returns deterministic unresolved candidates for duplicate modules across source roots", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-python-ambiguous-root-")); roots.push(root);
    mkdirSync(path.join(root, "src")); mkdirSync(path.join(root, "lib"));
    writeFileSync(path.join(root, "pyproject.toml"), '[tool.setuptools.packages.find]\nwhere = ["src", "lib"]\n');
    writeFileSync(path.join(root, "src", "main.py"), "import shared\n");
    writeFileSync(path.join(root, "src", "shared.py"), "SOURCE = 'src'\n");
    writeFileSync(path.join(root, "lib", "shared.py"), "SOURCE = 'lib'\n");
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const graph = app.database.getStoredGraphPartition("python");
      const main = graph.nodes.find((node) => node.kind === "module" && node.name === "main")!;
      const sharedIds = graph.nodes.filter((node) => node.kind === "module" && node.name === "shared")
        .map((node) => node.id).sort();
      expect(sharedIds).toHaveLength(2);
      expect(graph.edges.filter((edge) => edge.kind === "IMPORTS" && edge.sourceId === main.id)).toHaveLength(0);
      const unresolved = graph.unresolvedReferences.find((item) => item.sourceNodeId === main.id && item.rawName === "shared")!;
      expect(unresolved).toMatchObject({ confidence: 0.5, candidates: sharedIds });
      await app.indexWorkspace({ mode: "full" });
      const repeated = app.database.getStoredGraphPartition("python").unresolvedReferences
        .find((item) => item.rawName === "shared")!;
      expect(repeated.candidates).toEqual(sharedIds);
    } finally { await app.close(); }
  });

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
