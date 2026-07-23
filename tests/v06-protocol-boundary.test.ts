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
    depth: 2,
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
      const result = await trace(app, client, ["REQUESTS", "HANDLED_BY"]);
      const request = result.data.edges.find((edge) =>
        edge.sourceId === client && edge.kind === "REQUESTS" && protocolEvidence(edge, "rpc"));
      const boundary = result.data.edges.find((edge) =>
        edge.sourceId === request?.targetId && edge.targetId === server && protocolEvidence(edge, "rpc"));
      expect(request).toMatchObject({ kind: "REQUESTS", status: "resolved" });
      expect(boundary).toMatchObject({ kind: "HANDLED_BY", status: "resolved" });
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
      const result = await trace(app, producer, ["PUBLISHES", "CONSUMES"]);
      const publication = result.data.edges.find((edge) =>
        edge.sourceId === producer && edge.kind === "PUBLISHES" && protocolEvidence(edge, "queue"));
      const targets = result.data.edges
        .filter((edge) =>
          edge.sourceId === publication?.targetId && edge.kind === "CONSUMES" && protocolEvidence(edge, "queue"))
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
      const result = await trace(app, writer, ["WRITES_TO", "READS_FROM"]);
      const write = result.data.edges.find((edge) =>
        edge.sourceId === writer && edge.kind === "WRITES_TO" && protocolEvidence(edge, "database"));
      const boundary = result.data.edges.find((edge) =>
        edge.sourceId === write?.targetId && edge.targetId === reader && protocolEvidence(edge, "database"));
      expect(write).toMatchObject({ kind: "WRITES_TO", status: "resolved" });
      expect(boundary).toMatchObject({ kind: "READS_FROM", status: "resolved" });
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
      const result = await trace(app, client, ["REQUESTS", "HANDLED_BY"]);
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
        const result = await trace(app, symbol, ["REQUESTS", "HANDLED_BY", "PUBLISHES", "CONSUMES"]);
        expect(result.data.edges.some((edge) =>
          edge.evidence?.some((item) => item.provider === "contextmesh_protocol_boundary"))).toBe(false);
        expect(result.data.unresolved.some((item) =>
          item.kind === "RPC_BOUNDARY_CALL" || item.kind === "QUEUE_BOUNDARY_PUBLISH")).toBe(false);
      }
    } finally {
      await app.close();
    }
  });

  it("ignores protocol examples and standalone SQL text that are not executable boundary calls", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "notes.ts"), [
      "export function protocolNotes() {",
      "  const rpcExample = \"rpc.call('users.get', {})\";",
      "  const queueExample = \"queue.publish('orders.created', {})\";",
      "  return rpcExample + queueExample;",
      "}",
      "export function migrationNotes() {",
      "  return 'INSERT INTO users (id) VALUES (1)';",
      "}",
      "",
    ].join("\n"));
    writeFileSync(path.join(root, "reader.py"), [
      "def test_expectation():",
      "    return 'SELECT id FROM users'",
      "@rpc.method('users.get')",
      "def get_user(): return {}",
      "@queue.consumer('orders.created')",
      "def consume_order(): return None",
      "",
    ].join("\n"));

    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      for (const name of ["protocolNotes", "migrationNotes"]) {
        const symbol = await symbolId(app, name, "typescript");
        const result = await trace(app, symbol, [
          "REQUESTS", "HANDLED_BY", "PUBLISHES", "CONSUMES", "WRITES_TO", "READS_FROM",
        ]);
        expect(result.data.edges.some((edge) =>
          edge.evidence?.some((item) => item.provider === "contextmesh_protocol_boundary"))).toBe(false);
        expect(result.data.unresolved.some((item) =>
          item.kind === "RPC_BOUNDARY_CALL" ||
          item.kind === "QUEUE_BOUNDARY_PUBLISH" ||
          item.kind === "DATABASE_BOUNDARY_WRITE")).toBe(false);
      }
    } finally {
      await app.close();
    }
  });
});
