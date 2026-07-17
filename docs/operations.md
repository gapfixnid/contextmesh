# Operations

## Local files

The default database is `.contextmesh/contextmesh.sqlite3`. SQLite is opened with 8 KiB pages, foreign keys, WAL, a 5-second busy timeout, and `synchronous=NORMAL`. The whole `.contextmesh/` directory is ignored by Git and the code scanner. Do not share it as a repository artifact.

Before applying a migration to an existing database, ContextMesh checkpoints WAL and writes `contextmesh.sqlite3.backup-<UTC timestamp>` beside the database. Migration 004 then converts an older 4 KiB database to 8 KiB pages with `VACUUM` before adding semantic tables; the backup remains the recovery point if conversion cannot complete. A new empty database does not create a redundant backup.

## Diagnostics and recovery

Run:

```powershell
node dist/cli.js doctor
node dist/cli.js status
```

`doctor` reports SQLite integrity, applied migrations, foreign-key violations, FTS/base-table consistency, interrupted run recovery, and additive semantic status. `status` reports each semantic plane's live eligible/valid counts, coverage, state, model key, graph generation or memory revision, last error, and runtime diagnostics when the model has actually loaded. On startup, any run left as `running` by a terminated process becomes `failed`; the last committed generation remains active and a later retry receives a fresh generation number.

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

`SEMANTIC_PARTIAL` means some eligible entities lack a current valid vector; reconciliation will retry while lexical/graph results continue. `SEMANTIC_UNAVAILABLE` means the approved manifest/model/backend cannot produce candidates, or the plane exceeds the 50,000-vector exact-scan cap. No warning is emitted when semantic retrieval was not configured.

## Index and freshness policy

The stdio server performs a strict baseline verification at startup and normally follows it with incremental indexing. Use `--no-auto-index` for clients that explicitly schedule `index_workspace`; strict startup verification still runs. The default `--freshness-mode fast` uses metadata scans and hashes changed candidates. `--freshness-mode strict` hashes the complete configured scope for every graph request.

Only one index operation runs at a time within a server process. ContextMesh Phase 3 supports one index-writer process per workspace: concurrent reader processes detect generation changes, but concurrent `index_workspace` calls from different processes are outside the supported contract. Operational messages use stderr; stdout is reserved for MCP frames.

Project-specific exclusions belong in `.contextmeshignore`. Secret-like filenames, `.env*`, credentials/secrets paths, certificates/keys, external symlinks, dependency folders, and common build outputs are excluded before parsing.

## Performance check

`npm run benchmark` creates and deletes a temporary 1,000-file project and runs 50 samples per p95 measurement. It fails if cold indexing exceeds 30 seconds, verified no-op indexing exceeds 2 seconds, fast public search-plus-trace p95 exceeds 100 ms, or fast public `get_context` p95 exceeds 150 ms. Raw database latency, strict startup verification, and strict public request p95 are reported separately as information.

`npm run benchmark:semantic` measures the production exact-scan kernel at 50,000×384 after five warmups and fails above 150 ms p95, 2 seconds hydration, or 100 MiB cache RSS. Add `-- --model-path <path>` to also gate cold model load at 10 seconds and model RSS at 500 MiB while recording the requested/effective backend diagnostics. `npm run evaluate:quality -- --fixture acceptance-v1 --semantic-model <path>` evaluates the immutable fixture against the Phase 3 baseline and exits nonzero on any quality, determinism, inactive-memory, duplicate, or warm latency failure. These are local guardrails, not cross-machine service-level guarantees.
