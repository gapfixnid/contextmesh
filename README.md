# ContextMesh

ContextMesh is a local-first MCP server that combines a multi-language structural code graph, independently versioned precision overlays, and persistent workspace-scoped memory. It contains no LLM and makes no runtime network calls; the connected MCP client remains the reasoning layer.

## Requirements

- Node.js 24.18.x
- npm 11.x
- Rust 1.85+ for source builds (`cargo build --locked`); installed host packages include the matching sidecar binary
- Go 1.23+ only when the optional Go `go/types` precision overlay is desired

## Install and build

```powershell
npm install
npm run check
npm run benchmark
npm run benchmark:semantic
npm run benchmark:hydration
npm run benchmark:unavailable -- --model-path C:/models/multilingual-e5-small
npm run evaluate:v05
npm run evaluate:v051-holdout -- --output artifacts/v051-external-holdout.json
npm run verify:package
```

The local database is created at `.contextmesh/contextmesh.sqlite3` and is ignored by Git and the indexer. Override it with `--db-path` when needed.

## CLI

```powershell
node dist/cli.js index --full
node dist/cli.js index --incremental
node dist/cli.js serve --watch
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
- `explore_context`: one-shot implementation, architecture, or debugging evidence with current snippets
- `reflect`: atomic session episode plus structured learnings
- `forget`: auditable soft deletion

## Indexing model

ContextMesh reads `tsconfig.json` or `jsconfig.json` when available and otherwise creates a synthetic TypeScript project. It supports the TypeScript/JavaScript family plus `.py`, `.go`, `.rs`, `.java`, and `.cs`. The graph contains modules, external modules, functions, classes, methods, interfaces, type aliases, enums, and variables, connected by `CONTAINS`, `IMPORTS`, `EXPORTS`, `CALLS`, `EXTENDS`, and `IMPLEMENTS` edges.

Syntax candidates are always available. Go and Rust syntax use pinned Tree-sitter WASM grammars, while Java and C# remain deterministic syntax prototypes. TypeScript TypeChecker, the Python local-package resolver, optional Go `go/types`, and optional Rust `rust-analyzer` results are stored as independently fenced precision overlays. `workspace_status` reports provider capability and failure state; missing Go/Rust tooling does not prevent base indexing. `CONTEXTMESH_TYPESCRIPT_PRECISION_DISABLE=1`, `CONTEXTMESH_PYTHON_PRECISION_DISABLE=1`, `CONTEXTMESH_GO_TYPES_DISABLE=1`, and `CONTEXTMESH_RUST_ANALYZER_DISABLE=1` exercise the base-only policies.

Dynamic JavaScript calls that cannot be resolved safely are retained as unresolved evidence rather than guessed. Source bodies are not copied into SQLite; snippets are read from disk only after validating the indexed file hash.

Fast freshness compares the configured path set, size, and modification time, then hashes only changed candidates. A same-size edit whose modification time is deliberately restored can therefore remain undetected until strict verification or indexing. Every returned snippet is independently read once through a file descriptor, hashed, and sliced from those same verified bytes.

## Privacy and limits

- No telemetry, remote embedding service, remote database, or runtime external API calls. Optional embeddings remain in the local SQLite database.
- `.git`, `.contextmesh`, `node_modules`, common build directories, `.env*`, credentials, and key/certificate files are excluded by default.
- Symbol traversal depth and result counts are bounded.
- Memory is returned as untrusted contextual data, never promoted to system instructions.
- Add project-specific exclusions to `.contextmeshignore` using `.gitignore` syntax.
- Run only one `index_workspace` writer at a time for a workspace. ContextMesh enforces this across processes with a durable SQLite lease: concurrent writers receive `DB_BUSY`, expired owners are fenced from heartbeat/commit/fail, and a later writer may take over only after expiry. Multiple reader processes continue to serve the last committed generation. Index-time code embedding additionally acquires its own lease fenced to the pending target generation before inference.

`search_code` and `recall` accept bounded `offset` pagination and return `nextOffset`. Every successful tool response uses the same versioned envelope and every error uses a stable ContextMesh error code.

## Library API in 0.5.0

Configure semantic retrieval and the additive watcher through the constructor; the original nine MCP tool input schemas are unchanged.

```ts
import { ContextMeshApp } from "contextmesh";

const app = new ContextMeshApp(workspacePath, undefined, {
  semantic: { modelPath: "C:/absolute/path/to/multilingual-e5-small" },
  watcher: true,
});

await app.remember(input);
await app.recall(query);
await app.reflect(reflection);
await app.close();
```

`remember`, `recall`, `reflect`, and `close` remain asynchronous. Version 0.5.0 adds independent precision revisions, provider leases, Python alias/package resolution, Go/Rust syntax, optional Go `go/types`, and Java/C# syntax prototypes without changing schemaVersion 1 or existing MCP tool inputs. See [multilanguage provider support](docs/multilanguage.md).
