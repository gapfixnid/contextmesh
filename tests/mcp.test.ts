import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

import { ContextMeshApp } from "../src/app.js";
import { createMcpServer } from "../src/mcp/server.js";
import { createFixtureWorkspace, removeFixtureWorkspace } from "./helpers.js";

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) removeFixtureWorkspace(workspace);
});

describe("MCP protocol", () => {
  it("lists and calls every public tool over a linked transport", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    const app = new ContextMeshApp(root);
    const server = createMcpServer(app);
    const client = new Client({ name: "contextmesh-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(
        [
          "forget",
          "explore_context",
          "get_context",
          "impact_code",
          "index_workspace",
          "recall",
          "reflect",
          "remember",
          "search_code",
          "trace_code",
          "workspace_status",
        ].sort(),
      );
      const rememberTool = tools.tools.find((tool) => tool.name === "remember");
      const rememberProperties = (rememberTool?.inputSchema as { properties?: Record<string, unknown> }).properties;
      expect(rememberProperties?.anchor).toBeDefined();
      expect(rememberProperties?.isAnchor).toBeUndefined();
      const impactTool = tools.tools.find((tool) => tool.name === "impact_code");
      const impactProperties = (impactTool?.inputSchema as { properties?: Record<string, unknown> }).properties;
      expect(impactProperties?.direction).toBeDefined();
      expect(impactProperties?.tokenBudget).toBeDefined();

      const indexed = await client.callTool({ name: "index_workspace", arguments: { mode: "full" } });
      expect(indexed.isError).not.toBe(true);
      expect((indexed.structuredContent as { generation: number }).generation).toBe(1);

      const searched = await client.callTool({ name: "search_code", arguments: { query: "Calculator" } });
      expect(searched.isError).not.toBe(true);
      const structured = searched.structuredContent as {
        data: { results: Array<{ name: string }> };
        snapshot: { graphGeneration: number; successFence: number };
      };
      expect(structured.data.results.some((result) => result.name === "Calculator")).toBe(true);
      expect(structured.snapshot).toMatchObject({ graphGeneration: 1, successFence: 1 });

      const invalid = await client.callTool({ name: "search_code", arguments: { query: "" } });
      expect(invalid.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
      app.close();
    }
  });

  it(
    "starts as a clean stdio server without contaminating protocol stdout",
    async () => {
      const root = createFixtureWorkspace();
      workspaces.push(root);
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          "--import",
          "tsx",
          fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
          "serve",
          "--workspace",
          root,
          "--no-auto-index",
        ],
        stderr: "pipe",
      });
      const client = new Client({ name: "contextmesh-stdio-test", version: "1.0.0" });
      try {
        await client.connect(transport);
        const tools = await client.listTools();
        expect(tools.tools).toHaveLength(11);
        const status = await client.callTool({ name: "workspace_status", arguments: {} });
        expect(status.isError).not.toBe(true);
      } finally {
        await client.close();
      }
    },
    15_000,
  );
});
