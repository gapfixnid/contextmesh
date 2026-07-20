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

All adapters share scanner ignore/secret/symlink/size policy, deterministic IDs and ordering, UTF-8 byte spans, partial-parse diagnostics, unresolved evidence, and language-specific gold fixtures. `npm run evaluate:v05` enforces Tier 1 resolved-edge precision/recall, base-only operation, provider health, and generation independence. CI installs Go 1.23 and compiles/tests the standard-library helper before running that gate.

Python's native/portable supply chain remains pinned in [graph-kernel.manifest.json](./graph-kernel.manifest.json), Rust `Cargo.lock`, and [python-parser.manifest.json](./python-parser.manifest.json). The Go helper has no third-party modules and is packaged from `native/go-provider`.
