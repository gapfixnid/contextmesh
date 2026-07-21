# Operations

## Local files

The default database is `.contextmesh/contextmesh.sqlite3`. SQLite is opened with 8 KiB pages, foreign keys, WAL, a 5-second busy timeout, and `synchronous=NORMAL`. The whole `.contextmesh/` directory is ignored by Git and the code scanner. Do not share it as a repository artifact.

Before applying a migration to an existing database, ContextMesh checkpoints WAL and writes `contextmesh.sqlite3.backup-<UTC timestamp>` beside the database. Migration 004 converts an older 4 KiB database to 8 KiB pages with `VACUUM` before adding semantic tables; migration 005 adds release-gate failure, retry, and claim state while preserving existing embeddings; migration 006 adds the semantic hydration lookup index without rewriting embedding BLOBs. The backup remains the recovery point if conversion cannot complete. A new empty database does not create a redundant backup.

## Diagnostics and recovery

Run:

```powershell
node dist/cli.js doctor
node dist/cli.js status
```

`doctor` reports SQLite integrity, applied migrations, foreign-key violations, FTS/base-table consistency, interrupted run recovery, and additive semantic status. `status` reports each semantic plane's live eligible/valid counts, coverage, state, model key, graph generation or memory revision, normalized/redacted error, retry state, and reconciliation counters. Absolute model paths and stacks stay in local debug output. Runtime diagnostics appear only after the model has actually loaded. On startup, any run left as `running` by a terminated process becomes `failed`; the last committed generation remains active and a later retry receives a fresh generation number.

If integrity is not `ok`, stop all ContextMesh processes and restore the newest known-good backup. ContextMesh does not overwrite a corrupt database automatically.

## Optional local semantic model

Semantic retrieval is disabled unless an absolute local model directory is supplied. ContextMesh does not bundle weights, provision a model, or provide a complete air-gap installation bundle. After package installation and model placement, runtime inference is offline.

The only approved model is `Xenova/multilingual-e5-small` revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78`. The directory must contain:

```text
<model>/contextmesh-model-manifest.json
<model>/config.json
<model>/quant_config.json
<model>/tokenizer.json
<model>/sentencepiece.bpe.model
<model>/special_tokens_map.json
<model>/tokenizer_config.json
<model>/onnx/model_quantized.onnx
```

Copy [the approved manifest](models/multilingual-e5-small.manifest.json) to the model root as `contextmesh-model-manifest.json`. Do not rename or substitute another q8/int8/uint8 ONNX file. Startup use is then explicit:

```powershell
node dist/cli.js serve --workspace C:\project --semantic-model C:\models\multilingual-e5-small
```

The `fetch:semantic-smoke-model` script is CI test infrastructure and uses the network; it is not runtime model provisioning. The real-model smoke command installs a network-deny guard before session creation and inference:

```powershell
npm run smoke:semantic -- --model-path C:\models\multilingual-e5-small
```

`SEMANTIC_PARTIAL` means some eligible entities lack a current valid vector or contain repairable index data; reconciliation repairs only affected entities while lexical/graph results continue. `SEMANTIC_UNAVAILABLE` means the approved manifest/model/backend cannot produce candidates, or the plane exceeds the 50,000-vector exact-scan cap. Failure priority is material, scale, runtime, then data repair. No warning is emitted when semantic retrieval was not configured.

## Index and freshness policy

The stdio server performs a strict baseline verification at startup and normally follows it with incremental indexing. Use `--no-auto-index` for clients that explicitly schedule `index_workspace`; strict startup verification still runs. The default `--freshness-mode fast` uses metadata scans and hashes changed candidates. `--freshness-mode strict` hashes the complete configured scope for every graph request.

Only one index operation runs at a time within a server process. ContextMesh enforces one index-writer process per workspace as an operational invariant: concurrent reader processes detect generation changes, but two processes must never call `index_workspace` for the same workspace. Index-time code embedding also acquires a dedicated DB lease for the pending target generation. Embedding runs outside a SQLite write transaction with five-second heartbeats; graph, FTS, vectors, and claim completion commit atomically. If the lease is unavailable or lost, graph/FTS still commit, vectors are discarded, and the code plane becomes `needs_backfill`. Background and request-time semantic reconciliation uses the same claim row with current-generation tokens. Operational messages use stderr; stdout is reserved for MCP frames.

Project-specific exclusions belong in `.contextmeshignore`. Secret-like filenames, `.env*`, credentials/secrets paths, certificates/keys, external symlinks, dependency folders, and common build outputs are excluded before parsing.

### Opt-in watcher runbook

Manual indexing remains the default. Enable native watching only for the single writer process:

```powershell
node dist/cli.js serve --workspace C:\project --watch
```

The watcher reconciles the durable baseline on startup, coalesces add/change/delete/rename events, and invalidates `tsconfig.json`, `jsconfig.json`, `pyproject.toml`, source-root changes, and declaration/public API changes through the normal indexer. `workspace_status.data.watcher`, `graphKernel`, freshness fences, and `lastRun` show current mode and migration-008 durable component health. Watch-source startup failure does not terminate the server: bounded retry proceeds while reads use the last committed generation. On `WATCH_QUEUE_OVERFLOW`, `WATCH_SOURCE_FAILED`, `KERNEL_*`, or repeated `WATCH_INDEX_FAILED`, correct the OS handle/path/binary issue, run `index --full`, then restart the one watcher writer. Shutdown closes and awaits watcher work before disposing the indexer and SQLite.

The packaged host binary lives under `dist/native`. Source builds require Rust 1.85 or newer and `cargo build --locked`. Runtime network use is zero. [graph-kernel.manifest.json](graph-kernel.manifest.json), `Cargo.lock`, and `npm run verify:native-supply-chain` define exact crate/grammar pins and checksums. Windows, Linux, and macOS build/contract/package-consumer tests are required; only host-target binaries are packaged. Kernel requests default to a 30-second bound and 64 MiB response bound; controlled deployments may lower them with `CONTEXTMESH_GRAPH_KERNEL_TIMEOUT_MS` and `CONTEXTMESH_GRAPH_KERNEL_MAX_RESPONSE_BYTES`.

## Performance check

`npm run evaluate:v04` measures five cold samples plus twenty warm search/trace/explore and ten single-file increments for each fixed small/medium/large mixed fixture. It records actual adapter `filesReparsed`, TS provider isolation, ten DB commit samples per size, parent and live-sidecar RSS, and twenty real native watcher event-to-generation samples. Twenty separate Node processes each rebuild the full native and portable Python graph and must produce one exact ordered canonical digest. The TypeScript decision fixture measures the production graph against resolved-edge gold, runs twenty fresh `createProgram + getTypeChecker` resolutions, and separately reports benchmark-only Tree-sitter syntax quality/RSS without presenting it as resolved-edge precision. Artifact schema 4 / contract `contextmesh-v04-fixed-fixtures-v4` records an LF-normalized digest of every Git-visible non-artifact source file, the exact measured HEAD and tree digest, a clean non-artifact working state, the native version observed through the kernel handshake, and the canonical Windows hardware/power profile. `npm run verify:v04-artifact` rejects ancestor-only or dirty-source evidence and recomputes those identities in addition to canonical JSON, sample counts, finite metrics, every digest, and watcher p95 at 2,000 ms.

`npm run benchmark` creates and deletes a temporary 1,000-file project and runs 50 samples per p95 measurement. It fails if cold indexing exceeds 30 seconds, verified no-op indexing exceeds 2 seconds, fast public search-plus-trace p95 exceeds 100 ms, or fast public `get_context` p95 exceeds 150 ms. Raw database latency, strict startup verification, and strict public request p95 are reported separately as information.

`npm run benchmark:semantic` measures the production 50,000×384 exact scan and the full 1,000-file cross-plane workload. Its workload evidence comes from observed DB provenance counts and production ranking/packing diagnostics: plane-specific MMR inputs, near-duplicate pairs, semantic-only paraphrase hits, and soft-reservation fits or budget rejections are not fixture constants. `npm run benchmark:hydration` performs 50 application-cold SQLite cache misses and separately measures one fresh-process cache RSS increment; the gates are 2 seconds p95 and 100 MiB per plane. `npm run benchmark:unavailable -- --model-path <approved-model>` copies the approved material, corrupts one file without changing its size, and verifies semantic-off-equivalent search/context fallback over the 1,000-file corpus. Revisions, embeddings, full validation calls, metadata probes, claims, takeovers, and supersedes are invariant across the 20-request control window.

`npm run evaluate:v05` preserves immutable fixture `contextmesh-v05-tier1-resolved-edge-v5` for exact TypeScript, Python, Go, and Rust call paths, including syntax-distinct Python imports, a mixed resolved/candidate call-site case, and Rust positive, negative, and ambiguous development/holdout cases. The immutable semantic fixture `contextmesh-v05-semantic-conformance-v3` covers Python binding and inheritance behavior, Go receiver dispatch and exact toolchain provenance, scanner-approved test files, and build-constraint diagnostics. Every Tier 1 language includes development and holdout positive, negative, and ambiguous cases; candidate, rejected, and resolved paths are scored explicitly rather than counting only resolved edges. Artifact schema 4 records both fixture digests, TP/FP/FN, exact path mismatches, provider/toolchain conformance, independent precision revision behavior, twenty full graph determinism signatures, and four provider-disabled runs whose complete language base-graph fingerprints must equal the enabled run's syntax graph. `npm run verify:v05-artifact` rejects stale, dirty, non-canonical, source-mismatched, weakened, or fabricated evidence and is mandatory in hosted CI and the clean source-ZIP gate. `npm run evaluate:quality -- --fixture acceptance-v2 --semantic-model <path>` evaluates the immutable semantic retrieval fixture against the Phase 3 v2 baseline and exits nonzero on quality, determinism, inactive-memory, duplicate, or warm-latency failure. `npm run verify:package` checks the dry-run file list, installs the produced tarball into a fresh consumer, and imports it. `npm run verify:source-zip -- --model-path <external-approved-cache>` requires a clean tree, restores the model only outside the archive, reruns package/check/smoke/evaluation under the network guard, and rejects model, cache, DB, or environment files in the ZIP.

`npm run evaluate:v051-holdout -- --output artifacts/v051-external-holdout.json` evaluates 23 exact declaration-line cases over byte-pinned source slices from public Nx, Flask, and Kubernetes client-go releases. `npm run verify:v051-holdout` binds the canonical artifact to one exact clean non-artifact source commit, fixture digest, repository metadata, file bytes, case outcomes, thresholds, and 20 fresh-process normalized semantic fingerprints. A committed artifact may be followed only by generated-artifact commits whose non-artifact tree is identical; source ZIP metadata records the artifact's exact source commit separately from the archive commit, includes a canonical per-file source manifest, and every archive verifier rehashes the extracted files and requires the artifact commit to match. Hosted CI canonicalizes artifact-only descendants back to the first commit with the identical non-artifact tree. Precision and recall count resolved edges; exact-path and classification gates cover candidate and unresolved behavior. This gate is named v0.5.1 as hardening evidence for the 0.5.0 package line, not as an npm package-version declaration. Provider whole-corpus coverage is recorded separately and is not presented as recall. Hosted quality and clean source-ZIP verification both enforce this artifact.

Release quality evidence must identify an immutable source commit and timestamp. Do not record the symbolic name `HEAD`. Resolve it before starting the evaluation and retain the same values with the artifact:

```powershell
$sourceCommit = git rev-parse HEAD
$env:SOURCE_DATE_EPOCH = "1784246400"
npm run evaluate:quality -- --fixture acceptance-v2 --semantic-model C:\models\multilingual-e5-small --source-commit $sourceCommit --output evaluation\artifacts\acceptance-v2.json
```

`--source-commit` rejects anything except a full 40-character lowercase Git SHA, and acceptance-v2 rejects a missing or invalid `SOURCE_DATE_EPOCH`.

Production dependency audit is blocking on Ubuntu through `npm run audit:production`. The exact `adm-zip` advisory inherited through the pinned `onnxruntime-node` install-only archive path has a time-bounded threat-model waiver in [security-waivers.md](security-waivers.md); any different production advisory or waiver expiry fails CI. Fresh-consumer package verification audits the installed dependency topology because npm overrides in a published dependency would not be enforced by the consumer root.

Hosted Windows timing is informational because GitHub-hosted hardware is not a stable performance profile. The blocking v0.4 performance gate verifies the committed canonical fixed-hardware artifact, including an exact current-source digest, fixed CPU/logical-CPU/RAM/power identity, native handshake version, fixture identity, real sample counts, one-file incremental accounting, native/portable and 20-process graph parity, and watcher event-to-generation p95 at or below two seconds. The aggregate Phase 4 release job requires that evidence gate, 3-OS application smoke, hosted quality, Ubuntu/Windows acceptance quality parity, and clean-source-ZIP verification. Clean-source verification is blocking on push, pull-request, nightly, and manual runs rather than being an optional dispatch input. The complete workflow also runs nightly at 18:00 UTC.

Before any pending migration on an existing file database, ContextMesh requires a complete non-busy WAL checkpoint, copies the database, opens that backup read-only, and requires `integrity_check`, the exact pre-migration schema-version set, and an empty foreign-key check. Each migration remains one transaction. The migration suite fault-injects rollback for 007, 009, 010, and 011 and also restores a generated backup over the original database, resumes migration, and rechecks graph generation and code-memory links.

Semantic determinism is exact across 20 runs within each fixed runtime profile. Windows/Ubuntu comparison requires identical source, fixture, gold, model, baseline, evaluator, Node, Transformers.js, and ONNX Runtime provenance; both platform acceptance gates and within-profile determinism must pass; query contracts must match; and aggregate code, memory, and context quality may differ by at most 0.05. Context evidence coverage retains a 0.80 target with a declared 0.025 absolute boundary tolerance for approved ONNX CPU-profile variation. Raw embedding scores and irrelevant-candidate ordering are diagnostics because ONNX CPU kernels are platform-specific and are not bit-identical across operating systems. Failed acceptance jobs always upload their artifact and print the failed checks.
