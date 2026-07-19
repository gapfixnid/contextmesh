import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import type { ContextMeshApp } from "../app.js";
import {
  forgetSchema,
  exploreContextSchema,
  getContextSchema,
  indexWorkspaceSchema,
  recallSchema,
  reflectSchema,
  rememberSchema,
  searchCodeSchema,
  traceCodeSchema,
  type Envelope,
} from "../contracts.js";
import { asContextMeshError } from "../errors.js";

const envelopeOutputSchema = z.object({
  schemaVersion: z.literal(1),
  workspaceId: z.string(),
  generation: z.number().int().nonnegative(),
  data: z.unknown(),
  warnings: z.array(z.string()),
  truncated: z.boolean(),
  estimatedTokens: z.number().int().nonnegative(),
  snapshot: z.object({
    graphGeneration: z.number().int().nonnegative(),
    precisionRevision: z.number().int().nonnegative(),
    freshness: z.enum(["fresh", "fast-verified", "stale"]),
  }).optional(),
});

function success(result: Envelope<unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result as unknown as Record<string, unknown>,
  };
}

function failure(error: unknown) {
  const normalized = asContextMeshError(error);
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ code: normalized.code, message: normalized.message, details: normalized.details ?? null }),
      },
    ],
  };
}

export function createMcpServer(app: ContextMeshApp): McpServer {
  const server = new McpServer({ name: "contextmesh", version: "0.5.0" });

  server.registerTool(
    "index_workspace",
    {
      title: "Index workspace",
      description: "Build or refresh the local TypeScript/JavaScript and Python code graph.",
      inputSchema: indexWorkspaceSchema,
      outputSchema: envelopeOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      try {
        return success(await app.indexWorkspace(input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "workspace_status",
    {
      title: "Workspace status",
      description: "Report graph generation, freshness, diagnostics, and memory counts.",
      inputSchema: z.object({}),
      outputSchema: envelopeOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return success(await app.workspaceStatus());
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "search_code",
    {
      title: "Search code",
      description: "Search indexed code symbols using exact, SQLite FTS5, and optional local semantic ranking.",
      inputSchema: searchCodeSchema,
      outputSchema: envelopeOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        return success(await app.searchCode(input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "trace_code",
    {
      title: "Trace code graph",
      description: "Traverse callers, callees, imports, containment, and inheritance with bounded breadth and depth.",
      inputSchema: traceCodeSchema,
      outputSchema: envelopeOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        return success(await app.traceCode(input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "remember",
    {
      title: "Remember",
      description: "Persist one atomic, workspace-scoped long-term memory fragment.",
      inputSchema: rememberSchema,
      outputSchema: envelopeOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      try {
        return success(await app.remember(input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "recall",
    {
      title: "Recall",
      description: "Retrieve active memories with keyword/FTS and optional local semantic ranking under a strict token budget.",
      inputSchema: recallSchema,
      outputSchema: envelopeOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      try {
        return success(await app.recall(input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_context",
    {
      title: "Get unified context",
      description: "Assemble code search, graph neighbors, anchors, and linked memories within one token budget.",
      inputSchema: getContextSchema,
      outputSchema: envelopeOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      try {
        return success(await app.getContext(input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "explore_context",
    {
      title: "Explore code context",
      description: "Return deterministic entry points, bounded relations, current snippets, and verification warnings in one read snapshot.",
      inputSchema: exploreContextSchema,
      outputSchema: envelopeOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try { return success(await app.exploreContext(input)); }
      catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "reflect",
    {
      title: "Reflect on session",
      description: "Atomically store a client-provided session episode and up to 50 structured learnings.",
      inputSchema: reflectSchema,
      outputSchema: envelopeOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      try {
        return success(await app.reflect(input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "forget",
    {
      title: "Forget memory",
      description: "Soft-delete an active memory while retaining an auditable event.",
      inputSchema: forgetSchema,
      outputSchema: envelopeOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      try {
        return success(app.forget(input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}

export async function runStdioServer(app: ContextMeshApp): Promise<void> {
  const server = createMcpServer(app);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
