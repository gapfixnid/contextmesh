import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { ContextMeshApp } from "../src/app.js";
import type { Envelope } from "../src/contracts.js";
import type { ImpactData } from "../src/code/impact.js";
import { createMcpServer } from "../src/mcp/server.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-v06-impact-"));
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

async function linkedClient(app: ContextMeshApp): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = createMcpServer(app);
  const client = new Client({ name: "contextmesh-impact-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("v0.6 impact_code", () => {
  it("summarizes a resolved cross-language HTTP impact deterministically", async () => {
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
    let connection: Awaited<ReturnType<typeof linkedClient>> | null = null;
    try {
      await app.indexWorkspace({ mode: "full" });
      const clientSymbol = await symbolId(app, "loadUsers", "typescript");
      const serverSymbol = await symbolId(app, "list_users", "python");
      connection = await linkedClient(app);
      const argumentsValue = {
        symbolId: clientSymbol,
        direction: "out",
        edgeKinds: ["CALLS"],
        depth: 1,
        limit: 20,
        tokenBudget: 4000,
      };
      const first = await connection.client.callTool({ name: "impact_code", arguments: argumentsValue });
      const second = await connection.client.callTool({ name: "impact_code", arguments: argumentsValue });
      expect(first.isError).not.toBe(true);
      expect(second.isError).not.toBe(true);
      const firstEnvelope = first.structuredContent as unknown as Envelope<ImpactData>;
      const secondEnvelope = second.structuredContent as unknown as Envelope<ImpactData>;
      expect(firstEnvelope.data).toEqual(secondEnvelope.data);
      expect(firstEnvelope.estimatedTokens).toBeLessThanOrEqual(argumentsValue.tokenBudget);
      expect(firstEnvelope.warnings).toContain("IMPACT_STATIC_GRAPH_ONLY: runtime reachability is not proven");

      const target = firstEnvelope.data.affected.find((item) => item.id === serverSymbol);
      expect(target).toMatchObject({
        confirmed: true,
        verificationRequired: false,
        crossLanguage: true,
        minDepth: 1,
        relationKinds: ["CALLS"],
      });
      expect(target?.boundaries).toContainEqual(expect.objectContaining({
        protocol: "http",
        method: "GET",
        path: "/internal/users",
        clientLanguage: "typescript",
        serverLanguage: "python",
      }));
      expect(firstEnvelope.data.summary).toMatchObject({
        confirmedCount: 1,
        verificationRequiredCount: 0,
        crossLanguageCount: 1,
        boundaryCount: 1,
      });
    } finally {
      if (connection) await connection.close();
      await app.close();
    }
  });

  it("does not claim an impact when a literal boundary has duplicate server candidates", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "client.ts"), [
      "export async function loadUsers() {",
      "  return fetch('/internal/users');",
      "}",
      "",
    ].join("\n"));
    for (const [fileName, handler] of [["one.py", "first_users"], ["two.py", "second_users"]] as const) {
      writeFileSync(path.join(root, fileName), [
        "from fastapi import FastAPI",
        "app = FastAPI()",
        "@app.get('/internal/users')",
        `def ${handler}():`,
        "    return []",
        "",
      ].join("\n"));
    }

    const app = new ContextMeshApp(root);
    let connection: Awaited<ReturnType<typeof linkedClient>> | null = null;
    try {
      await app.indexWorkspace({ mode: "full" });
      const clientSymbol = await symbolId(app, "loadUsers", "typescript");
      connection = await linkedClient(app);
      const result = await connection.client.callTool({
        name: "impact_code",
        arguments: {
          symbolId: clientSymbol,
          direction: "out",
          edgeKinds: ["CALLS"],
          depth: 1,
          limit: 20,
          tokenBudget: 4000,
        },
      });
      expect(result.isError).not.toBe(true);
      const envelope = result.structuredContent as unknown as Envelope<ImpactData>;
      expect(envelope.data.affected.some((item) => item.boundaries.length > 0)).toBe(false);
      expect(envelope.data.summary.boundaryCount).toBe(0);
      expect(envelope.data.unresolved).toContainEqual(expect.objectContaining({
        sourceNodeId: clientSymbol,
        kind: "HTTP_BOUNDARY_CALL",
        rawName: "GET /internal/users",
      }));
      expect(envelope.warnings).toContain(
        "IMPACT_VERIFICATION_REQUIRED: candidate or unresolved paths require source verification",
      );
    } finally {
      if (connection) await connection.close();
      await app.close();
    }
  });
});
