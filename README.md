# ContextMesh

ContextMesh is a local-first MCP server that combines a structural TypeScript/JavaScript code graph with persistent, workspace-scoped long-term memory. It contains no LLM and makes no runtime network calls; the connected MCP client remains the reasoning layer. Phase 4 optionally adds local CPU embeddings while retaining FTS5 and graph retrieval as the failure-safe path.

## Requirements

- Node.js 24.18.x
- npm 11.x

## Install and build

```powershell
npm install
npm run check
npm run benchmark
npm run benchmark:semantic
npm run benchmark:hydration
npm run benchmark:unavailable -- --model-path C:/models/multilingual-e5-small
npm run verify:package
```

The local database is created at `.contextmesh/contextmesh.sqlite3` and is ignored by Git and the indexer. Override it with `--db-path` when needed.

## CLI

```powershell
node dist/cli.js index --full
node dist/cli.js index --incremental
node dist/cli.js status
node dist/cli.js search ContextMeshApp
node dist/cli.js remember "Use SQLite for local persistence." --topic architecture --type decision --anchor
node dist/cli.js recall SQLite
node dist/cli.js context "How is local persistence implemented?"
node dist/cli.js doctor
```

Semantic retrieval is off by default. To enable it, provision the approved model locally as described in [Operations](docs/operations.md), then add `--semantic-model C:/absolute/path/to/model` to a CLI command or the MCP server arguments. Model files are never downloaded at runtime.

Run `node dist/cli.js help` for the complete command list.

Implementation details and the complete tool contract are documented in:

- [Architecture](docs/architecture.md)
- [MCP API](docs/mcp-api.md)
- [Operations](docs/operations.md)

## MCP configuration

Build the project, then register the stdio server with an absolute workspace path:

```json
{
  "mcpServers": {
    "contextmesh": {
      "command": "node",
      "args": [
        "C:/absolute/path/to/ContextMesh/dist/cli.js",
        "serve",
        "--workspace",
        "C:/absolute/path/to/your/project",
        "--semantic-model",
        "C:/absolute/path/to/multilingual-e5-small"
      ]
    }
  }
}
```

Omit `--semantic-model` for the Phase 1–3 lexical/graph behavior. When supplied, ContextMesh validates the embedded approved manifest and every model file before dynamically importing Transformers.js. The server validates the indexed baseline strictly at startup. Pass `--no-auto-index` to skip automatic indexing while retaining that validation. Normal requests use fast freshness checks; select full per-request verification with `serve --freshness-mode strict`. All operational logging goes to stderr so stdout remains a valid MCP stdio stream.

## MCP tools

- `index_workspace`: full or hash-aware incremental graph refresh
- `workspace_status`: generation, freshness, diagnostics, and entity counts
- `search_code`: exact, FTS5, and optional local semantic symbol search
- `trace_code`: bounded callers/callees/import/containment/inheritance traversal
- `remember`: atomic memory storage with deduplication, TTL, anchors, supersession, and code links
- `recall`: filtered lexical and optional semantic memory retrieval within a token budget
- `get_context`: combined code, graph, lexical, optional semantic, and memory context
- `reflect`: atomic session episode plus structured learnings
- `forget`: auditable soft deletion

## Indexing model

ContextMesh reads `tsconfig.json` or `jsconfig.json` when available and otherwise creates a synthetic project. It supports `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, and project-local `.d.ts` files. The graph contains modules, external modules, functions, classes, methods, interfaces, type aliases, enums, and named variables, connected by `CONTAINS`, `IMPORTS`, `EXPORTS`, `CALLS`, `EXTENDS`, and `IMPLEMENTS` edges.

Dynamic JavaScript calls that cannot be resolved safely are retained as unresolved evidence rather than guessed. Source bodies are not copied into SQLite; snippets are read from disk only after validating the indexed file hash.

Fast freshness compares the configured path set, size, and modification time, then hashes only changed candidates. A same-size edit whose modification time is deliberately restored can therefore remain undetected until strict verification or indexing. Every returned snippet is independently read once through a file descriptor, hashed, and sliced from those same verified bytes.

## Privacy and limits

- No telemetry, remote embedding service, remote database, or runtime external API calls. Optional embeddings remain in the local SQLite database.
- `.git`, `.contextmesh`, `node_modules`, common build directories, `.env*`, credentials, and key/certificate files are excluded by default.
- Symbol traversal depth and result counts are bounded.
- Memory is returned as untrusted contextual data, never promoted to system instructions.
- Add project-specific exclusions to `.contextmeshignore` using `.gitignore` syntax.
- Run only one `index_workspace` writer process for a workspace. Multiple reader processes and generation-change detection are supported; cross-process concurrent index writers are not. Index-time code embedding additionally acquires a DB lease fenced to the pending target generation before inference.

`search_code` and `recall` accept bounded `offset` pagination and return `nextOffset`. Every successful tool response uses the same versioned envelope and every error uses a stable ContextMesh error code.

## Library API in 0.2.0

Configure semantic retrieval only through the constructor; MCP tool input schemas are unchanged.

```ts
import { ContextMeshApp } from "contextmesh";

const app = new ContextMeshApp(workspacePath, undefined, {
  semantic: { modelPath: "C:/absolute/path/to/multilingual-e5-small" },
});

await app.remember(input);
await app.recall(query);
await app.reflect(reflection);
await app.close();
```

`remember`, `recall`, `reflect`, and `close` are asynchronous in 0.2.0. `search_code.data.results[].score` is now the deterministic final hybrid relevance in `[0,1]`, regardless of whether semantic retrieval is enabled.
