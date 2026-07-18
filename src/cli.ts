#!/usr/bin/env node

import { parseArgs } from "node:util";

import { ContextMeshApp } from "./app.js";
import { MEMORY_TYPES } from "./contracts.js";
import { asContextMeshError, ContextMeshError } from "./errors.js";
import { runStdioServer } from "./mcp/server.js";

const HELP = `ContextMesh — local MCP code intelligence and long-term memory

Usage:
  contextmesh serve [--workspace PATH] [--watch] [--no-auto-index] [--freshness-mode fast|strict] [--semantic-model PATH]
  contextmesh index [--workspace PATH] [--full | --incremental]
  contextmesh status [--workspace PATH]
  contextmesh search QUERY [--kind function --limit 20 --offset 0]
  contextmesh trace SYMBOL_ID [--direction both --depth 2]
  contextmesh remember CONTENT --topic TOPIC --type fact
  contextmesh recall [QUERY] [--keyword WORD --token-budget 1000 --offset 0]
  contextmesh context QUERY [--symbol SYMBOL_ID --token-budget 2000]
  contextmesh explore QUERY [--symbol SYMBOL_ID --intent implementation|architecture|debugging --depth 2 --token-budget 2000]
  contextmesh reflect --session ID --summary TEXT [--learnings JSON]
  contextmesh forget FRAGMENT_ID --reason TEXT
  contextmesh doctor [--workspace PATH]

The default database is WORKSPACE/.contextmesh/contextmesh.sqlite3.
Semantic retrieval is disabled unless --semantic-model points to an approved local model directory.
`;

function numeric(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ContextMeshError("INVALID_ARGUMENT", `Expected a number, received: ${value}`);
  return parsed;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new ContextMeshError("INVALID_ARGUMENT", `Missing required ${name}`);
  return value;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }
  const { values, positionals } = parseArgs({
    args: process.argv.slice(3),
    allowPositionals: true,
    strict: true,
    options: {
      workspace: { type: "string", short: "w" },
      "db-path": { type: "string" },
      full: { type: "boolean", default: false },
      incremental: { type: "boolean", default: false },
      "no-auto-index": { type: "boolean", default: false },
      watch: { type: "boolean", default: false },
      "freshness-mode": { type: "string" },
      "semantic-model": { type: "string" },
      kind: { type: "string", multiple: true },
      limit: { type: "string" },
      offset: { type: "string" },
      direction: { type: "string" },
      "edge-kind": { type: "string", multiple: true },
      depth: { type: "string" },
      topic: { type: "string" },
      type: { type: "string" },
      keyword: { type: "string", multiple: true },
      importance: { type: "string" },
      anchor: { type: "boolean", default: false },
      "assertion-status": { type: "string" },
      "ttl-days": { type: "string" },
      "source-symbol": { type: "string", multiple: true },
      supersedes: { type: "string" },
      "token-budget": { type: "string" },
      "include-anchor": { type: "boolean", default: false },
      include: { type: "string", multiple: true },
      symbol: { type: "string" },
      intent: { type: "string" },
      session: { type: "string" },
      summary: { type: "string" },
      learnings: { type: "string" },
      client: { type: "string" },
      reason: { type: "string" },
    },
  });

  const workspace = values.workspace ?? process.cwd();
  const freshnessMode = values["freshness-mode"] ?? "fast";
  if (freshnessMode !== "fast" && freshnessMode !== "strict") {
    throw new ContextMeshError("INVALID_ARGUMENT", `Unknown freshness mode: ${freshnessMode}`);
  }
  const app = new ContextMeshApp(
    workspace,
    values["db-path"],
    values["semantic-model"]
      ? { freshnessMode, semantic: { modelPath: values["semantic-model"] }, watcher: values.watch }
      : { freshnessMode, watcher: values.watch },
  );

  if (command === "serve") {
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await app.close();
    };
    const shutdown = (): void => {
      void close().finally(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    try {
      await app.initialize(!values["no-auto-index"]);
      await runStdioServer(app);
      await new Promise<void>((resolve) => process.stdin.once("end", resolve));
    } catch (error) {
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
      await close();
      throw error;
    }
    await close();
    return;
  }

  try {
    await app.initialize(false);
    switch (command) {
      case "index":
        if (values.full && values.incremental) {
          throw new ContextMeshError("INVALID_ARGUMENT", "Choose either --full or --incremental, not both");
        }
        writeJson(await app.indexWorkspace({ mode: values.full ? "full" : "incremental" }));
        break;
      case "status":
        writeJson(await app.workspaceStatus());
        break;
      case "search":
        writeJson(
          await app.searchCode({
            query: required(positionals[0], "QUERY"),
            kinds: values.kind,
            limit: numeric(values.limit, 20),
            offset: numeric(values.offset, 0),
          }),
        );
        break;
      case "explore":
        writeJson(await app.exploreContext({ query: required(positionals[0], "QUERY"), symbolId: values.symbol,
          intent: values.intent ?? "implementation", depth: numeric(values.depth, 2), limit: numeric(values.limit, 12), tokenBudget: numeric(values["token-budget"], 2000) }));
        break;
      case "trace":
        writeJson(
          await app.traceCode({
            symbolId: required(positionals[0], "SYMBOL_ID"),
            direction: values.direction ?? "both",
            edgeKinds: values["edge-kind"],
            depth: numeric(values.depth, 2),
            limit: numeric(values.limit, 100),
          }),
        );
        break;
      case "remember": {
        const type = values.type ?? "fact";
        if (!MEMORY_TYPES.includes(type as (typeof MEMORY_TYPES)[number])) {
          throw new ContextMeshError("INVALID_ARGUMENT", `Unknown memory type: ${type}`);
        }
        writeJson(
          await app.remember({
            content: required(positionals[0], "CONTENT"),
            topic: required(values.topic, "--topic"),
            type,
            keywords: values.keyword ?? [],
            importance: numeric(values.importance, 3),
            anchor: values.anchor,
            assertionStatus: values["assertion-status"] ?? "observed",
            ttlDays: values["ttl-days"] === undefined ? undefined : numeric(values["ttl-days"], 1),
            sourceSymbolIds: values["source-symbol"] ?? [],
            supersedesId: values.supersedes,
            sessionId: values.session,
          }),
        );
        break;
      }
      case "recall":
        writeJson(
          await app.recall({
            query: positionals[0],
            keywords: values.keyword,
            tokenBudget: numeric(values["token-budget"], 1000),
            includeAnchors: values["include-anchor"],
            limit: numeric(values.limit, 20),
            offset: numeric(values.offset, 0),
          }),
        );
        break;
      case "context":
        writeJson(
          await app.getContext({
            query: required(positionals[0], "QUERY"),
            symbolId: values.symbol,
            tokenBudget: numeric(values["token-budget"], 2000),
            include: values.include ?? ["code", "memory"],
          }),
        );
        break;
      case "reflect":
        writeJson(
          await app.reflect({
            sessionId: required(values.session, "--session"),
            summary: required(values.summary, "--summary"),
            learnings: values.learnings ? (JSON.parse(values.learnings) as unknown) : [],
            clientName: values.client,
          }),
        );
        break;
      case "forget":
        writeJson(
          app.forget({
            fragmentId: required(positionals[0], "FRAGMENT_ID"),
            reason: required(values.reason, "--reason"),
          }),
        );
        break;
      case "doctor":
        writeJson(app.doctor());
        break;
      default:
        throw new ContextMeshError("INVALID_ARGUMENT", `Unknown command: ${command}\n\n${HELP}`);
    }
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  const normalized = asContextMeshError(error);
  process.stderr.write(`${JSON.stringify({ code: normalized.code, message: normalized.message, details: normalized.details ?? null })}\n`);
  process.exitCode = 1;
});
