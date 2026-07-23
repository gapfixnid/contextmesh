import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ContextMeshApp } from "../src/app.js";
import type { Envelope } from "../src/contracts.js";

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

async function traceCalls(app: ContextMeshApp, symbolId: string): Promise<TraceData> {
  const response = await app.traceCode({
    symbolId,
    direction: "out",
    edgeKinds: ["CALLS"],
    depth: 1,
    limit: 50,
  }) as Envelope<TraceData>;
  return response.data;
}

function hasBoundaryEdge(trace: TraceData): boolean {
  return trace.edges.some((edge) =>
    edge.evidence?.some((item) => item.provider === "contextmesh_http_boundary"));
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
      const trace = await traceCalls(app, client);

      const boundary = trace.edges.find((edge) =>
        edge.sourceId === client && edge.targetId === server &&
        edge.evidence?.some((item) => item.provider === "contextmesh_http_boundary"));
      expect(boundary).toMatchObject({ kind: "CALLS", status: "resolved" });
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

      const trace = await traceCalls(app, client);
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
      const trace = await traceCalls(app, client);

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
        const trace = await traceCalls(app, client);
        expect(hasBoundaryEdge(trace)).toBe(false);
        expect(trace.unresolved.some((item) => item.kind === "HTTP_BOUNDARY_CALL")).toBe(false);
      }
    } finally {
      await app.close();
    }
  });
});
