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
  const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-v06-protocol-"));
  roots.push(root);
  return root;
}

async function symbolId(app: ContextMeshApp, name: string, language: string): Promise<string> {
  const response = await app.searchCode({ query: name, kinds: ["function"], limit: 50 }) as Envelope<{
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

async function trace(
  app: ContextMeshApp,
  symbol: string,
  edgeKinds: string[],
): Promise<Envelope<TraceData>> {
  return app.traceCode({
    symbolId: symbol,
    direction: "out",
    edgeKinds,
    depth: 1,
    limit: 50,
  }) as Promise<Envelope<TraceData>>;
}

function protocolEvidence(edge: TraceData["edges"][number], protocol: string): boolean {
  return Boolean(edge.evidence?.some((item) =>
    item.provider === "contextmesh_protocol_boundary" && item.details?.boundaryProtocol === protocol));
}

describe("v0.6 literal protocol boundaries", () => {
  it("links a TypeScript RPC call to one Python RPC handler", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "client.ts"), [
      "export function loadUser() {",
      "  return rpc.call('users.get', { id: 1 });",
      "}",
      "",
    ].join("\n"));
    writeFileSync(path.join(root, "service.py"), [
      "@rpc.method('users.get')",
      "def get_user():",
      "    return {'id': 1}",
      "",
    ].join("\n"));

    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const client = await symbolId(app, "loadUser", "typescript");
      const server = await symbolId(app, "get_user", "python");
      const result = await trace(app, client, ["CALLS"]);
      const boundary = result.data.edges.find((edge) =>
        edge.sourceId === client && edge.targetId === server && protocolEvidence(edge, "rpc"));
      expect(boundary).toMatchObject({ kind: "CALLS", status: "resolved" });
      expect(boundary?.evidence).toContainEqual(expect.objectContaining({
        provider: "contextmesh_protocol_boundary",
        details: expect.objectContaining({
          boundaryProtocol: "rpc",
          boundaryOperation: "call",
          boundaryResource: "users.get",
          sourceRole: "client",
          targetRole: "server",
          sourceLanguage: "typescript",
          targetLanguage: "python",
        }),
      }));
    } finally {
      await app.close();
    }
  });

  it("links one queue publication to every exact cross-language consumer", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "producer.py"), [
      "def publish_order():",
      "    queue.publish('orders.created', {'id': 1})",
      "",
    ].join("\n"));
    writeFileSync(path.join(root, "consumer.ts"), [
      "export function handleOrder() { return true; }",
      "queue.subscribe('orders.created', handleOrder);",
      "",
    ].join("\n"));
    writeFileSync(path.join(root, "consumer.rs"), [
      "fn handle_order() {}",
      "fn register() { queue.subscribe(\"orders.created\", handle_order); }",
      "",
    ].join("\n"));

    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const producer = await symbolId(app, "publish_order", "python");
      const tsConsumer = await symbolId(app, "handleOrder", "typescript");
      const rustConsumer = await symbolId(app, "handle_order", "rust");
      const result = await trace(app, producer, ["CALLS"]);
      const targets = result.data.edges
        .filter((edge) => edge.sourceId === producer && protocolEvidence(edge, "queue"))
        .map((edge) => edge.targetId)
        .sort();
      expect(targets).toEqual([tsConsumer, rustConsumer].sort());
    } finally {
      await app.close();
    }
  });

  it("links a Go SQL writer to a Python reader through one exact table", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "writer.go"), [
      "package store",
      "func SaveUser() {",
      "  db.Exec(\"INSERT INTO users (id) VALUES (1)\")",
      "}",
      "",
    ].join("\n"));
    writeFileSync(path.join(root, "reader.py"), [
      "def read_users():",
      "    return db.execute('SELECT id FROM users')",
      "",
    ].join("\n"));

    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const writer = await symbolId(app, "SaveUser", "go");
      const reader = await symbolId(app, "read_users", "python");
      const result = await trace(app, writer, ["REFERENCES"]);
      const boundary = result.data.edges.find((edge) =>
        edge.sourceId === writer && edge.targetId === reader && protocolEvidence(edge, "database"));
      expect(boundary).toMatchObject({ kind: "REFERENCES", status: "resolved" });
      expect(boundary?.evidence).toContainEqual(expect.objectContaining({
        details: expect.objectContaining({
          boundaryProtocol: "database",
          boundaryOperation: "insert_to_read",
          boundaryResource: "users",
          sourceRole: "writer",
          targetRole: "reader",
        }),
      }));
    } finally {
      await app.close();
    }
  });

  it("keeps duplicate RPC handlers unresolved instead of choosing by function name", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "client.ts"), [
      "export function loadUser() {",
      "  return rpc.call('users.get', { id: 1 });",
      "}",
      "",
    ].join("\n"));
    for (const [fileName, handler] of [["one.py", "first_user"], ["two.py", "second_user"]] as const) {
      writeFileSync(path.join(root, fileName), [
        "@rpc.method('users.get')",
        `def ${handler}():`,
        "    return {'id': 1}",
        "",
      ].join("\n"));
    }

    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const client = await symbolId(app, "loadUser", "typescript");
      const result = await trace(app, client, ["CALLS"]);
      expect(result.data.edges.some((edge) => protocolEvidence(edge, "rpc"))).toBe(false);
      expect(result.data.unresolved).toContainEqual(expect.objectContaining({
        sourceNodeId: client,
        kind: "RPC_BOUNDARY_CALL",
        rawName: "CALL users.get",
      }));
    } finally {
      await app.close();
    }
  });

  it("does not interpret composed RPC or queue resources as static boundaries", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "client.ts"), [
      "export function dynamicRpc(name: string) { return rpc.call('users.' + name, {}); }",
      "export function dynamicQueue(name: string) { return queue.publish('orders.' + name, {}); }",
      "",
    ].join("\n"));
    writeFileSync(path.join(root, "service.py"), [
      "@rpc.method('users.get')",
      "def get_user(): return {}",
      "@queue.consumer('orders.created')",
      "def consume_order(): return None",
      "",
    ].join("\n"));

    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      for (const name of ["dynamicRpc", "dynamicQueue"]) {
        const symbol = await symbolId(app, name, "typescript");
        const result = await trace(app, symbol, ["CALLS"]);
        expect(result.data.edges.some((edge) =>
          edge.evidence?.some((item) => item.provider === "contextmesh_protocol_boundary"))).toBe(false);
        expect(result.data.unresolved.some((item) =>
          item.kind === "RPC_BOUNDARY_CALL" || item.kind === "QUEUE_BOUNDARY_PUBLISH")).toBe(false);
      }
    } finally {
      await app.close();
    }
  });
});
