# Multilanguage providers (v0.5–v0.6)

ContextMesh indexes TypeScript/JavaScript, Python, Go, Rust, Java, and C# into one base graph generation. Syntax extraction always completes independently of optional precision tooling. Precision results are committed later under a separate `precisionRevision`; a provider failure or missing executable never removes the last committed base graph.

| Language | Syntax provider | Precision provider | Capability |
| --- | --- | --- | --- |
| TypeScript/JavaScript | TypeScript Compiler AST | TypeScript TypeChecker | typed |
| Python | Rust graph-kernel / Tree-sitter | `contextmesh_python_resolver` | resolved |
| Go | Tree-sitter Go 0.25.0 WASM | standard-library `go/types` helper | typed when Go is installed |
| Rust | Tree-sitter Rust 0.24.0 WASM | optional `rust-analyzer` LSP | resolved when configured |
| Java | deterministic prototype adapter | not configured | syntax prototype |
| C# | deterministic prototype adapter | not configured | syntax prototype |

The Python resolver handles local-package and imported aliases for calls and inheritance. Go `go/types` receives only scanner-approved path/size/hash identities and is invoked only when the local `go` command is available; `CONTEXTMESH_GO_TYPES_DISABLE=1` forces the base-only policy. Rust can resolve project-internal definitions through `rust-analyzer`; `CONTEXTMESH_RUST_ANALYZER_COMMAND`, `CONTEXTMESH_RUST_ANALYZER_ARGS_JSON`, `CONTEXTMESH_RUST_ANALYZER_POLICY=safe|trusted`, and `CONTEXTMESH_RUST_ANALYZER_DISABLE=1` control that optional provider. The default `safe` policy disables dependency fetching, build scripts, proc macros, and check-on-save, pins Cargo autoreload off, forces Cargo offline mode, and removes Rust/Cargo compiler override variables—including every `CARGO_BUILD_*` variable—from the child environment. `trusted` is an explicit opt-in that enables build scripts and proc macros while retaining deterministic autoreload and check-on-save settings. Java and C# continue to expose usable syntax graphs and explicit prototype state without claiming typed accuracy.

Rust `safe` is a restriction policy, not an operating-system sandbox. It blocks the known automatic Cargo execution paths listed above, but rust-analyzer otherwise treats a repository as trusted and other repository-controlled Cargo or toolchain configuration can execute code. Fully isolating an untrusted repository requires running ContextMesh and rust-analyzer inside a separate process sandbox. `CONTEXTMESH_RUST_ANALYZER_DISABLE=1` takes precedence over policy and command parsing and does not start or version-probe the configured analyzer.

Every edge carries provider/version/source/confidence evidence. Syntax candidates remain `candidate`; a precision provider can publish `resolved` or `rejected` adjudications. Query-time merging is deterministic, preserves all evidence, and uses `resolved > rejected > candidate` for the effective view. Providers are protected by a database lease, base-generation fence, and transition epoch; a policy or provider-version transition invalidates an older worker before it can commit. No-op indexing rechecks provider availability and effective versions, so disabling Python, Go, or Rust precision withdraws a previously visible overlay. The precision revision changes only when the user-visible effective graph changes, not when a worker merely acquires or takes over a lease. `workspace_status.precision` reports revision, provider version, status (`not_configured`, `running`, `ready`, `stale`, `failed`, or `partial`), coverage, and last error.

Provider updates do not advance `graphGeneration`. A base commit marks prior overlays stale, deletes generation-bound edge and node rows through foreign keys, and then allows each provider to refresh independently. Migration 011 keeps typed/resolved signatures, documentation, metadata, FTS terms, and semantic source hashes in the effective precision view without overwriting the syntax base. Cache keys include both graph generation and precision revision, and public reads retry once if either changes.

ContextMesh never confirms an edge across language families based on a name match.

## v0.6 deterministic boundary linking

Boundary links are generated during graph merging and commit atomically with the base generation. A source edit therefore adds, replaces, or withdraws boundary evidence in the same graph replacement. Boundary-provider versions participate in the global index configuration hash, so an unchanged v0.5 workspace performs one full reinterpretation after upgrading.

### HTTP

`contextmesh_http_boundary@http-literal-v1` recognizes a bounded set of TypeScript/JavaScript, Python, Go, and Rust client/server forms only when the HTTP method and relative path are static string literals. A unique server endpoint in a different language creates a resolved `CALLS` edge. Missing or duplicate endpoints remain `HTTP_BOUNDARY_CALL` unresolved references. External URLs, protocol-relative URLs, composed strings, templates, parameterized paths, comments, and cross-file name-only handler binding are not confirmed.

### RPC

`contextmesh_protocol_boundary@rpc-queue-db-literal-v1` recognizes explicitly RPC-named `call`/`request`/`invoke` clients and `register`/`handle`/`method` servers. The literal RPC method name must match exactly and one cross-language server owner must be bound locally. Missing or duplicate handlers remain `RPC_BOUNDARY_CALL` unresolved references.

### Queue

The same provider recognizes explicitly queue/broker/producer `publish`/`send`/`emit` operations and queue/broker/consumer `subscribe`/`consume` handlers. A static topic can intentionally fan out to multiple exact cross-language consumers, producing one resolved `CALLS` edge per consumer. A topic without a consumer remains `QUEUE_BOUNDARY_PUBLISH` unresolved.

### Database

Simple single-statement SQL literals are recognized for `INSERT INTO`, `UPDATE`, `DELETE FROM`, and `SELECT ... FROM`. Writers connect to every exact cross-language reader of the same normalized table through resolved `REFERENCES` edges. Multi-statement, dynamic, composed, query-builder, join-derived, or identifier-interpolated SQL is not claimed. A writer with no reader remains `DATABASE_BOUNDARY_WRITE` unresolved.

All boundary evidence records the protocol, operation/resource, source and target roles, languages, files, and source spans. The generation graph cache restores cross-language edges that do not fit one language partition without changing the underlying partition or precision-overlay contracts.

## v0.6 impact analysis

`impact_code` reuses one `trace_code` generation/precision snapshot. It reports bounded upstream or downstream affected symbols, minimum depth, relation status, confidence, cross-language classification, normalized boundary evidence, unresolved paths, and strict token-budget truncation. Rejected edges are never affected targets. Every response states that static graph reachability does not prove runtime reachability; candidate or unresolved paths carry an explicit verification warning.

The immutable `contextmesh-v06-boundary-impact-v1` fixture covers resolved HTTP/RPC/database links, queue fan-out, ambiguous HTTP/RPC endpoints, missing queue/database targets, impact confirmation, exact-path precision/recall, and repeated normalized signatures. `npm run evaluate:v06` generates source-bound evidence and `npm run verify:v06-artifact` rejects changed fixture bytes, source bytes, run counts, signatures, outcomes, or metrics. The checked artifact is generated only after the v0.6 source scope is frozen.

## Conformance and supply chain

All adapters share scanner ignore/secret/symlink/size policy, deterministic IDs and ordering, UTF-8 byte spans, partial-parse diagnostics, unresolved evidence, and language-specific gold fixtures. `npm run evaluate:v05` enforces Tier 1 resolved-edge precision/recall, exact base-only graph fingerprints, provider health/toolchain provenance, generation independence, Python binding semantics, Go receiver and test-file behavior, and twenty-run graph determinism. The Go helper forces local-toolchain and offline module policy (`GOTOOLCHAIN=local`, `GOPROXY=off`, `GOSUMDB=off`, `GOVCS=*:off`) and records the exact local Go version. CI installs Go 1.23, compiles/tests the standard-library helper, evaluates schema 4 evidence, and verifies the artifact against the exact source before the release gate can pass.

The v0.5.1 hardening gate adds an offline-replayable external-source holdout drawn from pinned releases of Nx, Flask, Kubernetes client-go, and Rustlings; it is evidence for the 0.5.0 package line, not an npm package-version declaration. Its 29 selected TypeScript, Python, Go, and Rust cases bind gold paths to exact declaration start lines and cover large-monorepo, complex-`src`-layout, generated-code, and multi-binary-workspace profiles. Twenty fresh Node processes must produce one normalized semantic signature covering full declaration spans, edge and unresolved evidence, exact case outcomes, provider states, and candidate order; workspace-scoped IDs, generation counters, public ordering, warnings, and snapshots are outside this holdout signature and remain covered by the existing v0.4/v0.5 gates. `npm run evaluate:v051-holdout` requires the real pinned-toolchain `rust-analyzer`, writes its version provenance into source-bound evidence, and `npm run verify:v051-holdout` rejects changed source bytes by recomputing the archive manifest, fixture bytes, provenance, thresholds, paths, classifications, process scope, or run counts. Precision and recall are resolved-edge metrics; exact path and classification gates separately enforce candidate and unresolved behavior. The resulting scores describe only the pinned cases; the artifact reports provider whole-corpus coverage separately and does not claim full-repository coverage.

Python's native/portable supply chain remains pinned in [graph-kernel.manifest.json](./graph-kernel.manifest.json), Rust `Cargo.lock`, and [python-parser.manifest.json](./python-parser.manifest.json). The Go helper has no third-party modules and is packaged from `native/go-provider`.
