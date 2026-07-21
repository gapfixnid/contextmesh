# Multilanguage providers (v0.5)

ContextMesh 0.5 indexes TypeScript/JavaScript, Python, Go, Rust, Java, and C# into one base graph generation. Syntax extraction always completes independently of optional precision tooling. Precision results are committed later under a separate `precisionRevision`; a provider failure or missing executable never removes the last committed base graph.

| Language | Syntax provider | Precision provider | Capability |
| --- | --- | --- | --- |
| TypeScript/JavaScript | TypeScript Compiler AST | TypeScript TypeChecker | typed |
| Python | Rust graph-kernel / Tree-sitter | `contextmesh_python_resolver` | resolved |
| Go | Tree-sitter Go 0.25.0 WASM | standard-library `go/types` helper | typed when Go is installed |
| Rust | Tree-sitter Rust 0.24.0 WASM | optional `rust-analyzer` LSP | resolved when configured |
| Java | deterministic prototype adapter | not configured | syntax prototype |
| C# | deterministic prototype adapter | not configured | syntax prototype |

The Python resolver handles local-package and imported aliases for calls and inheritance. Go `go/types` receives only scanner-approved path/size/hash identities and is invoked only when the local `go` command is available; `CONTEXTMESH_GO_TYPES_DISABLE=1` forces the base-only policy. Rust can resolve project-internal definitions through `rust-analyzer`; `CONTEXTMESH_RUST_ANALYZER_COMMAND`, `CONTEXTMESH_RUST_ANALYZER_ARGS_JSON`, and `CONTEXTMESH_RUST_ANALYZER_DISABLE=1` control that optional provider. Java and C# continue to expose usable syntax graphs and explicit prototype state without claiming typed accuracy.

Every edge carries provider/version/source/confidence evidence. Syntax candidates remain `candidate`; a precision provider can publish `resolved` or `rejected` adjudications. Query-time merging is deterministic, preserves all evidence, and uses `resolved > rejected > candidate` for the effective view. Providers are protected by a database lease and base-generation fence. `workspace_status.precision` reports revision, provider version, status (`not_configured`, `running`, `ready`, `stale`, `failed`, or `partial`), coverage, and last error.

Provider updates do not advance `graphGeneration`. A base commit marks prior overlays stale, deletes generation-bound edge and node rows through foreign keys, and then allows each provider to refresh independently. Migration 011 keeps typed/resolved signatures, documentation, metadata, FTS terms, and semantic source hashes in the effective precision view without overwriting the syntax base. Cache keys include both graph generation and precision revision, and public reads retry once if either changes.

ContextMesh never confirms an edge across language families based on a name match. HTTP/RPC/queue/DB boundary linking remains v0.6 scope.

## Conformance and supply chain

All adapters share scanner ignore/secret/symlink/size policy, deterministic IDs and ordering, UTF-8 byte spans, partial-parse diagnostics, unresolved evidence, and language-specific gold fixtures. `npm run evaluate:v05` enforces Tier 1 resolved-edge precision/recall, exact base-only graph fingerprints, provider health/toolchain provenance, generation independence, Python binding semantics, Go receiver and test-file behavior, and twenty-run graph determinism. The Go helper forces local-toolchain and offline module policy (`GOTOOLCHAIN=local`, `GOPROXY=off`, `GOSUMDB=off`, `GOVCS=*:off`) and records the exact local Go version. CI installs Go 1.23, compiles/tests the standard-library helper, evaluates schema 4 evidence, and verifies the artifact against the exact source before the release gate can pass.

The v0.5.1 hardening gate adds an offline-replayable external-source holdout drawn from pinned releases of Nx, Flask, Kubernetes client-go, and Rustlings; it is evidence for the 0.5.0 package line, not an npm package-version declaration. Its 29 selected TypeScript, Python, Go, and Rust cases bind gold paths to exact declaration start lines and cover large-monorepo, complex-`src`-layout, generated-code, and multi-binary-workspace profiles. Twenty fresh Node processes must produce one normalized semantic signature covering full declaration spans, edge and unresolved evidence, exact case outcomes, provider states, and candidate order; workspace-scoped IDs, generation counters, public ordering, warnings, and snapshots are outside this holdout signature and remain covered by the existing v0.4/v0.5 gates. `npm run evaluate:v051-holdout` requires the real pinned-toolchain `rust-analyzer`, writes its version provenance into source-bound evidence, and `npm run verify:v051-holdout` rejects changed source bytes by recomputing the archive manifest, fixture bytes, provenance, thresholds, paths, classifications, process scope, or run counts. Precision and recall are resolved-edge metrics; exact path and classification gates separately enforce candidate and unresolved behavior. The resulting scores describe only the pinned cases; the artifact reports provider whole-corpus coverage separately and does not claim full-repository coverage.

Python's native/portable supply chain remains pinned in [graph-kernel.manifest.json](./graph-kernel.manifest.json), Rust `Cargo.lock`, and [python-parser.manifest.json](./python-parser.manifest.json). The Go helper has no third-party modules and is packaged from `native/go-provider`.
