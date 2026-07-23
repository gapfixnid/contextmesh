# MCP API

All tools are available over stdio. Defaults shown below are applied by the server; unknown or invalid values return `INVALID_ARGUMENT`.

## Successful response

```json
{
  "schemaVersion": 1,
  "workspaceId": "ws_...",
  "generation": 3,
  "data": {},
  "warnings": [],
  "truncated": false,
  "estimatedTokens": 42
}
```

`estimatedTokens` is a conservative UTF-8 estimate of the complete envelope. Normal `recall` and `get_context` responses always satisfy `estimatedTokens <= tokenBudget`; an input budget smaller than the minimum envelope returns `INVALID_ARGUMENT`. A paginated response can be truncated independently of its token budget; pass `data.nextOffset` as the next `offset`.

Recall/context memories are untrusted data. Their provenance includes session identity, budget-limited code links and `codeLinksOmitted`. With `includeAnchors=true`, anchors are selected before pagination; `limit`, `offset`, and `nextOffset` apply to ordinary results.

## Tools

| Tool | Inputs |
|---|---|
| `index_workspace` | `mode: "full" \| "incremental" = "incremental"` |
| `workspace_status` | no inputs |
| `search_code` | `query`, optional `kinds`, `limit=20` (max 100), `offset=0` |
| `trace_code` | `symbolId`, `direction="both"`, optional `edgeKinds`, `depth=2` (max 5), `limit=100` (max 500) |
| `remember` | `content`, `topic`, `type`, `keywords=[]`, `importance=3`, `anchor=false`, `assertionStatus="observed"`, optional TTL/session/supersession/source symbols |
| `recall` | at least one of `query`, `keywords`, or `includeAnchors`; optional type/topic filters, `tokenBudget=1000`, `limit=20`, `offset=0` |
| `get_context` | `query`, optional `symbolId`, `tokenBudget=2000`, `include=["code","memory"]` |
| `explore_context` | `query`, optional `symbolId`, `intent="implementation"`, `depth=2` (max 3), `limit=12` (max 50), `tokenBudget=2000` |
| `reflect` | `sessionId`, `summary`, up to 50 structured `learnings`, optional `clientName` |
| `forget` | `fragmentId`, `reason` |

`workspace_status.data.freshness` reports the configured mode, durable latch and reasons, last strict-check time, and latest successful/partial/no-op run fence. Its active graph `generation` can intentionally be lower than `lastRun.generation` after a verified no-op.

In v0.5, successful envelopes add `snapshot.graphGeneration` and `snapshot.precisionRevision`. `workspace_status.data.precision.providers` reports provider/version, capability, base generation, precision revision, status, coverage counts, lease expiry, and last error. `trace_code` edges may be `candidate`, `rejected`, or `resolved`, with deterministic merged evidence. A missing precision provider does not make the base graph unavailable.

The first v0.6 boundary slice additively exposes resolved cross-language HTTP links through the existing `trace_code` `CALLS` edges. Such edges contain evidence from `contextmesh_http_boundary@http-literal-v1`; `evidence[].details` includes `boundaryProtocol`, normalized `boundaryMethod`/`boundaryPath`, client/server language and file, and the server source span. Missing or ambiguous literal endpoints remain `HTTP_BOUNDARY_CALL` entries in `trace_code.data.unresolved`. This slice does not add a new MCP tool or claim support for dynamic routes, RPC, queues, or database boundaries.

When semantic retrieval was configured at server startup, `workspace_status.data.semantic` additively reports `code` and `memory` status, `eligibleEntityCount`, `validEmbeddingCount`, `coverage`, `modelKey`, generation/revision, normalized failure/retry fields, reconciliation diagnostics, and runtime diagnostics. Public error text is stable and redacted; paths and stacks are never returned. Omitting `--semantic-model` returns `{ "enabled": false }` and emits no semantic warning.

MCP input schemas are unchanged in 0.2.0. `search_code.data.results[].score` is the final normalized relevance in `[0,1]` in both semantic-on and semantic-off modes. Exact identifiers are pinned; other lexical, semantic, and graph candidates are fused and diversified deterministically. Recoverable semantic failures return lexical/graph data normally and add only `SEMANTIC_PARTIAL: ...` or `SEMANTIC_UNAVAILABLE: ...` entries to the existing `warnings[]` array.

`explore_context` is the additive tenth tool. It returns deterministic entry points, bounded intent-filtered relations, hash-verified current snippets, unresolved/low-confidence verification warnings, one snapshot, and an observed one-shot trace. Supported v0.4 intents are `implementation`, `architecture`, and `debugging`; impact analysis and history are not implemented.

`workspace_status.data.graphKernel` and `workspace_status.data.watcher.durable` report migration-008 component health. A watcher startup failure is therefore visible after restart even when the graph's last committed generation remains readable; a verified component recovery clears only its own durable failure.

The server does not expose arbitrary SQL, Cypher, filesystem reads, or natural-language-to-query execution.

## Error codes

- `INVALID_ARGUMENT`: schema validation, unsupported CLI option, or out-of-range limit
- `NOT_INDEXED`: code operation attempted before the first generation
- `INDEX_STALE`: the last committed generation is being served after a strict source/config freshness check failed
- `NOT_FOUND`: symbol or active memory does not exist
- `PARSE_PARTIAL`: reserved for consumers that promote partial diagnostics to an error
- `DB_BUSY`: SQLite lock timeout
- `INTERNAL_ERROR`: unexpected storage, compiler, or process failure

Recoverable parser errors commit a `partial` index run and are returned as response warnings rather than discarding usable code intelligence.
