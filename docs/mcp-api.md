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

`estimatedTokens` is a conservative UTF-8 estimate of the complete envelope. Normal `recall`, `get_context`, `impact_analysis`, and `impact_code` responses always satisfy `estimatedTokens <= tokenBudget`; an input budget smaller than the minimum envelope returns `INVALID_ARGUMENT`. A paginated response can be truncated independently of its token budget; pass `data.nextOffset` as the next `offset`.

Recall/context memories are untrusted data. Their provenance includes session identity, budget-limited code links and `codeLinksOmitted`. With `includeAnchors=true`, anchors are selected before pagination; `limit`, `offset`, and `nextOffset` apply to ordinary results.

## Tools

| Tool | Inputs |
|---|---|
| `index_workspace` | `mode: "full" \| "incremental" = "incremental"` |
| `workspace_status` | no inputs |
| `search_code` | `query`, optional `kinds`, `limit=20` (max 100), `offset=0` |
| `trace_code` | `symbolId`, `direction="both"`, optional `edgeKinds`, `depth=2` (max 5), `limit=100` (max 500) |
| `impact_analysis` | `symbolId`, `direction="in" \| "out" = "in"`, optional `edgeKinds`, `depth=3` (max 5), `limit=50` (max 200), `tokenBudget=2000` |
| `impact_code` | Compatibility alias for `impact_analysis` |
| `remember` | `content`, `topic`, `type`, `keywords=[]`, `importance=3`, `anchor=false`, `assertionStatus="observed"`, optional TTL/session/supersession/source symbols |
| `review_memories` | `action="list" \| "run_maintenance" \| "resolve"`; bounded filters, maintenance kinds, or an explicit candidate decision |
| `recall` | at least one of `query`, `keywords`, or `includeAnchors`; optional type/topic filters, `tokenBudget=1000`, `limit=20`, `offset=0` |
| `get_context` | `query`, optional `symbolId`, `tokenBudget=2000`, `include=["code","memory"]` |
| `explore_context` | `query`, optional `symbolId`, `intent="implementation"`, `depth=2` (max 3), `limit=12` (max 50), `tokenBudget=2000` |
| `reflect` | `sessionId`, `summary`, up to 50 structured `learnings`, optional `clientName` |
| `forget` | `fragmentId`, `reason` |

### v0.7 memory validation and review

`remember` additively accepts timezone-qualified `validFrom`, `validTo`, and `observedAt`, plus structured `claims`. TTL controls record lifecycle (`expiresAt`); the validity interval controls when the remembered fact or decision may be used. An ended validity interval does not expire or delete the record.

Normal `recall` and `get_context` use one eligibility gate: the memory must be active, inside both lifecycle and validity windows, not rejected, not `review_required`, and have validation state `unlinked`, `valid`, or `relocated`. `stale`, `orphaned`, `contradicted`, and `needs_review` memories—including anchors and semantic candidates—are excluded. `contradicted` is produced only by an explicit structured code claim; free text is never interpreted as a contradiction.

`review_memories` supports:

- `{"action":"list","limit":20,"offset":0,"tokenBudget":2000}` for severity-ordered review items and audit summaries.
- `{"action":"run_maintenance","kinds":["revalidate_links"],"maxItems":100,"dryRun":true}` for bounded deterministic plans and signatures.
- `{"action":"resolve","candidateId":"mcand_...","decision":"dismiss","reason":"reviewed"}` for explicit decisions. Relinking requires `targetSymbolId`; episode compaction requires user-provided `replacementContent`.

Rename/move recovery is `relocated` only when an ordered exact locator strategy produces one candidate; name similarity never confirms a target. Duplicate and conflict findings are candidates only and are never auto-merged, auto-resolved, or auto-deleted. Every normal snapshot additively includes `memoryRevision`.

`workspace_status.data.freshness` reports the configured mode, durable latch and reasons, last strict-check time, and latest successful/partial/no-op run fence. Its active graph `generation` can intentionally be lower than `lastRun.generation` after a verified no-op.

In v0.5, successful envelopes add `snapshot.graphGeneration` and `snapshot.precisionRevision`. `workspace_status.data.precision.providers` reports provider/version, capability, base generation, precision revision, status, coverage counts, lease expiry, and last error. `trace_code` edges may be `candidate`, `rejected`, or `resolved`, with deterministic merged evidence. A missing precision provider does not make the base graph unavailable.

v0.6 additively exposes deterministic cross-language resource links. `contextmesh_http_boundary@http-resource-v2` stores `function → REQUESTS → resource:http:* → HANDLED_BY → handler`. `contextmesh_protocol_boundary@rpc-queue-db-resource-v2` uses the same request/handler shape for RPC, `PUBLISHES`/`CONSUMES` for queue topics, and `WRITES_TO`/`READS_FROM` for database tables. RPC requires one server; queue topics may fan out to multiple consumers. SQL is accepted only as the literal first argument of a bounded DB execution API and supports simple single-statement `INSERT`/`UPDATE`/`DELETE` writers and `SELECT ... FROM` readers. Missing targets remain `RPC_BOUNDARY_CALL`, `QUEUE_BOUNDARY_PUBLISH`, or `DATABASE_BOUNDARY_WRITE`. External URLs, composed strings, code examples embedded in strings, standalone SQL text, templates, parameterized resources, multi-statement SQL, comments, and name-only cross-file handler binding are not confirmed.

Boundary evidence contains `boundaryProtocol` plus HTTP method/path or generic operation/resource, source and target roles, languages, files, and source spans. Resource IDs are stable within a workspace and boundary links belong to the base graph generation, so a literal change atomically withdraws the old resource path from the visible generation.

`impact_analysis` is the canonical impact tool and `impact_code` is its compatibility alias. Both reuse one generation/precision snapshot from `trace_code` and return deterministic upstream (`direction="in"`) or downstream (`direction="out"`) affected nodes, minimum depth, relation status, confidence, cross-language classification, and normalized boundary evidence. A target is confirmed only when at least one complete path from the start consists entirely of resolved edges with confidence of at least 0.9. Candidate or unresolved paths remain visible with `IMPACT_VERIFICATION_REQUIRED`; a resolved final edge cannot upgrade an earlier uncertain path. Summary counts describe the bounded observed trace; `truncated=true` means either graph limits or the token budget omitted details.

When semantic retrieval was configured at server startup, `workspace_status.data.semantic` additively reports `code` and `memory` status, `eligibleEntityCount`, `validEmbeddingCount`, `coverage`, `modelKey`, generation/revision, normalized failure/retry fields, reconciliation diagnostics, and runtime diagnostics. Public error text is stable and redacted; paths and stacks are never returned. Omitting `--semantic-model` returns `{ "enabled": false }` and emits no semantic warning.

MCP input schemas are unchanged in 0.2.0. `search_code.data.results[].score` is the final normalized relevance in `[0,1]` in both semantic-on and semantic-off modes. Exact identifiers are pinned; other lexical, semantic, and graph candidates are fused and diversified deterministically. Recoverable semantic failures return lexical/graph data normally and add only `SEMANTIC_PARTIAL: ...` or `SEMANTIC_UNAVAILABLE: ...` entries to the existing `warnings[]` array.

`explore_context` returns deterministic entry points, bounded intent-filtered relations, hash-verified current snippets, unresolved/low-confidence verification warnings, one snapshot, and an observed one-shot trace. Supported v0.4 intents are `implementation`, `architecture`, and `debugging`; history is not implemented.

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
