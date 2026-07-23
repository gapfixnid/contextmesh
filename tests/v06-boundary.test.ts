import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ContextMeshApp } from "../src/app.js";
import { linkHttpBoundaries } from "../src/code/boundary.js";
import type { CodeEcosystem, CodeLanguage, Envelope, IndexedSourceFile } from "../src/contracts.js";
import { sha256 } from "../src/utils.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-v06-boundary-"));
  roots.push(root);
  return root;
}

async function symbolId(app: ContextMeshApp, name: string, language: string): Promise<string> {
  const response = await app.searchCode({ query: name, kinds: ["function"], limit: 20 }) as Envelope<{
    results: Array<{ id: string; name: string; language: string }>;
  }>;
  const exact = response.data.results.filter((item) => item.name === name && item.language === language);
  expect(exact).toHaveLength(1);
  return exact[0]!.id;
}

interface TraceData {
  edges: Array<{
    sourceId: string;
    targetId: string;
    kind: string;
    status: string;
    evidence?: Array<{ provider: string; details?: Record<string, unknown> }>;
  }>;
  unresolved: Array<{ sourceNodeId: string | null; kind: string; rawName: string; candidates?: string[] }>;
}

async function traceBoundaries(app: ContextMeshApp, symbolId: string): Promise<TraceData> {
  const response = await app.traceCode({
    symbolId,
    direction: "out",
    edgeKinds: ["REQUESTS", "HANDLED_BY"],
    depth: 2,
    limit: 50,
  }) as Envelope<TraceData>;
  return response.data;
}

function hasBoundaryEdge(trace: TraceData): boolean {
  return trace.edges.some((edge) =>
    edge.evidence?.some((item) => item.provider === "contextmesh_http_boundary"));
}

function ecosystemFor(language: CodeLanguage): CodeEcosystem {
  if (language === "python") return "pypi";
  if (language === "go") return "go";
  if (language === "rust") return "cargo";
  if (language === "java") return "maven";
  if (language === "csharp") return "nuget";
  return "npm";
}

function linkerInputs(app: ContextMeshApp, root: string): {
  files: IndexedSourceFile[];
  nodes: ReturnType<typeof app.database.getStoredGraphPartition>["nodes"];
} {
  const workspaceRecord = app.database.getWorkspace();
  const generation = workspaceRecord.currentGeneration;
  const files = app.database.getIndexedFileBaseline()
    .filter((item): item is typeof item & { language: CodeLanguage } => item.language !== null)
    .map((item): IndexedSourceFile => {
      const absolutePath = path.join(root, item.relativePath);
      const status = statSync(absolutePath);
      return {
        id: sha256(`${workspaceRecord.id}\0${item.pathKey}`),
        workspaceId: workspaceRecord.id,
        relativePath: item.relativePath,
        pathKey: item.pathKey,
        absolutePath,
        language: item.language,
        ecosystem: item.ecosystem as CodeEcosystem | undefined ?? ecosystemFor(item.language),
        sourceRoot: item.sourceRoot,
        adapterConfigHash: item.adapterConfigHash,
        content: readFileSync(absolutePath, "utf8"),
        contentHash: item.contentHash,
        sizeBytes: item.sizeBytes,
        mtimeMs: status.mtimeMs,
        parseStatus: item.parseStatus,
        diagnosticCount: item.diagnosticCount,
        generation,
      };
    });
  const partitions = [
    app.database.getStoredGraphPartition("non-python", false),
    app.database.getStoredGraphPartition("python", false),
  ];
  return { files, nodes: partitions.flatMap((partition) => partition.nodes) };
}

describe("v0.6 literal HTTP boundaries", () => {
  it("links a TypeScript fetch call to a Python route without a cross-language name match", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "client.ts"), [
      "export async function loadUsers() {",
      "  return fetch('/internal/users');",
      "}",
      "",
    ].join("\n"));
    writeFileSync(path.join(root, "service.py"), [
      "from fastapi import FastAPI",
      "app = FastAPI()",
      "",
      "@app.get('/internal/users')",
      "def list_users():",
      "    return []",
      "",
    ].join("\n"));

    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const client = await symbolId(app, "loadUsers", "typescript");
      const server = await symbolId(app, "list_users", "python");
      const inputs = linkerInputs(app, root);
      const linked = linkHttpBoundaries(inputs.files, inputs.nodes);
      const resource = linked.nodes.find((node) =>
        node.kind === "resource" && node.qualifiedName === "resource:http:GET:/internal/users");
      expect(resource).toBeDefined();
      expect(linked.edges).toContainEqual(expect.objectContaining({
        sourceId: client,
        targetId: resource?.id,
        kind: "REQUESTS",
        status: "resolved",
      }));
      expect(linked.edges).toContainEqual(expect.objectContaining({
        sourceId: resource?.id,
        targetId: server,
        kind: "HANDLED_BY",
        status: "resolved",
      }));

      const trace = await traceBoundaries(app, client);
      const boundary = trace.edges.find((edge) =>
        edge.sourceId === resource?.id && edge.targetId === server &&
        edge.evidence?.some((item) => item.provider === "contextmesh_http_boundary"));
      expect(boundary, JSON.stringify({ trace, linked }, null, 2)).toMatchObject({
        kind: "HANDLED_BY",
        status: "resolved",
      });
      expect(boundary?.evidence).toContainEqual(expect.objectContaining({
        provider: "contextmesh_http_boundary",
        details: expect.objectContaining({
          boundaryProtocol: "http",
          boundaryMethod: "GET",
          boundaryPath: "/internal/users",
          clientLanguage: "typescript",
          serverLanguage: "python",
        }),
      }));
    } finally {
      await app.close();
    }
  });

  it("withdraws a boundary link after the server literal changes and preserves an unresolved endpoint", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "client.ts"), [
      "export async function loadUsers() {",
      "  return fetch('/internal/users');",
      "}",
      "",
    ].join("\n"));
    const serverPath = path.join(root, "service.py");
    writeFileSync(serverPath, [
      "from fastapi import FastAPI",
      "app = FastAPI()",
      "@app.get('/internal/users')",
      "def list_users():",
      "    return []",
      "",
    ].join("\n"));

    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const client = await symbolId(app, "loadUsers", "typescript");
      writeFileSync(serverPath, [
        "from fastapi import FastAPI",
        "app = FastAPI()",
        "@app.get('/internal/accounts')",
        "def list_users():",
        "    return []",
        "",
      ].join("\n"));
      await app.indexWorkspace({ mode: "incremental" });

      const trace = await traceBoundaries(app, client);
      expect(hasBoundaryEdge(trace)).toBe(false);
      expect(trace.unresolved).toContainEqual(expect.objectContaining({
        sourceNodeId: client,
        kind: "HTTP_BOUNDARY_CALL",
        rawName: "GET /internal/users",
      }));
    } finally {
      await app.close();
    }
  });

  it("keeps duplicate cross-language server routes unresolved instead of choosing by name", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "client.ts"), [
      "export async function loadUsers() {",
      "  return fetch('/internal/users');",
      "}",
      "",
    ].join("\n"));
    for (const [filename, handler] of [["one.py", "first_users"], ["two.py", "second_users"]] as const) {
      writeFileSync(path.join(root, filename), [
        "from fastapi import FastAPI",
        "app = FastAPI()",
        "@app.get('/internal/users')",
        `def ${handler}():`,
        "    return []",
        "",
      ].join("\n"));
    }

    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const client = await symbolId(app, "loadUsers", "typescript");
      const trace = await traceBoundaries(app, client);

      expect(hasBoundaryEdge(trace)).toBe(false);
      expect(trace.unresolved).toContainEqual(expect.objectContaining({
        sourceNodeId: client,
        kind: "HTTP_BOUNDARY_CALL",
        rawName: "GET /internal/users",
      }));
    } finally {
      await app.close();
    }
  });

  it("does not map external URLs or composed strings onto a local route", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "client.ts"), [
      "export async function externalUsers() {",
      "  return fetch('https://example.invalid/internal/users');",
      "}",
      "export async function composedUsers(id: string) {",
      "  return fetch('/internal/' + id);",
      "}",
      "",
    ].join("\n"));
    writeFileSync(path.join(root, "service.py"), [
      "from fastapi import FastAPI",
      "app = FastAPI()",
      "@app.get('/internal/users')",
      "def list_users():",
      "    return []",
      "",
    ].join("\n"));

    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      for (const name of ["externalUsers", "composedUsers"]) {
        const client = await symbolId(app, name, "typescript");
        const trace = await traceBoundaries(app, client);
        expect(hasBoundaryEdge(trace)).toBe(false);
        expect(trace.unresolved.some((item) => item.kind === "HTTP_BOUNDARY_CALL")).toBe(false);
      }
    } finally {
      await app.close();
    }
  });

  it("does not treat example code embedded in a string as an executable HTTP call", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "client.ts"), [
      "export function documentationOnly() {",
      "  return \"fetch('/internal/users')\";",
      "}",
      "",
    ].join("\n"));
    writeFileSync(path.join(root, "service.py"), [
      "from fastapi import FastAPI",
      "app = FastAPI()",
      "@app.get('/internal/users')",
      "def list_users():",
      "    return []",
      "",
    ].join("\n"));

    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const client = await symbolId(app, "documentationOnly", "typescript");
      const trace = await traceBoundaries(app, client);
      expect(hasBoundaryEdge(trace)).toBe(false);
      expect(trace.unresolved.some((item) => item.kind === "HTTP_BOUNDARY_CALL")).toBe(false);
    } finally {
      await app.close();
    }
  });
});
