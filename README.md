# ContextMesh

ContextMesh is a local-first MCP server that combines a structural TypeScript/JavaScript code graph with persistent, workspace-scoped long-term memory. It contains no LLM and makes no runtime network calls; the connected MCP client remains the reasoning layer.

## Requirements

- Node.js 24.18.x
- npm 11.x

## Install and build

```powershell
npm install
npm run check
npm run benchmark
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
        "C:/absolute/path/to/your/project"
      ]
    }
  }
}
```

The server validates the indexed baseline strictly at startup. Pass `--no-auto-index` to skip automatic indexing while retaining that validation. Normal requests use fast freshness checks; select full per-request verification with `serve --freshness-mode strict`. All operational logging goes to stderr so stdout remains a valid MCP stdio stream.

## MCP tools

- `index_workspace`: full or hash-aware incremental graph refresh
- `workspace_status`: generation, freshness, diagnostics, and entity counts
- `search_code`: exact and FTS5 symbol search
- `trace_code`: bounded callers/callees/import/containment/inheritance traversal
- `remember`: atomic memory storage with deduplication, TTL, anchors, supersession, and code links
- `recall`: filtered memory retrieval within a token budget
- `get_context`: combined code, graph, and memory context
- `reflect`: atomic session episode plus structured learnings
- `forget`: auditable soft deletion

## Indexing model

ContextMesh reads `tsconfig.json` or `jsconfig.json` when available and otherwise creates a synthetic project. It supports `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, and project-local `.d.ts` files. The graph contains modules, external modules, functions, classes, methods, interfaces, type aliases, enums, and named variables, connected by `CONTAINS`, `IMPORTS`, `EXPORTS`, `CALLS`, `EXTENDS`, and `IMPLEMENTS` edges.

Dynamic JavaScript calls that cannot be resolved safely are retained as unresolved evidence rather than guessed. Source bodies are not copied into SQLite; snippets are read from disk only after validating the indexed file hash.

Fast freshness compares the configured path set, size, and modification time, then hashes only changed candidates. A same-size edit whose modification time is deliberately restored can therefore remain undetected until strict verification or indexing. Every returned snippet is independently read once through a file descriptor, hashed, and sliced from those same verified bytes.

## Privacy and limits

- No telemetry, embeddings, remote database, or external API calls.
- `.git`, `.contextmesh`, `node_modules`, common build directories, `.env*`, credentials, and key/certificate files are excluded by default.
- Symbol traversal depth and result counts are bounded.
- Memory is returned as untrusted contextual data, never promoted to system instructions.
- Add project-specific exclusions to `.contextmeshignore` using `.gitignore` syntax.
- Run only one `index_workspace` writer process for a workspace. Multiple reader processes and generation-change detection are supported; cross-process concurrent index writers are not.

`search_code` and `recall` accept bounded `offset` pagination and return `nextOffset`. Every successful tool response uses the same versioned envelope and every error uses a stable ContextMesh error code.
