# Operations

## Local files

The default database is `.contextmesh/contextmesh.sqlite3`. SQLite is opened with foreign keys, WAL, a 5-second busy timeout, and `synchronous=NORMAL`. The whole `.contextmesh/` directory is ignored by Git and the code scanner. Do not share it as a repository artifact.

Before applying a migration to an existing database, ContextMesh checkpoints WAL and writes `contextmesh.sqlite3.backup-<UTC timestamp>` beside the database. A new empty database does not create a redundant backup.

## Diagnostics and recovery

Run:

```powershell
node dist/cli.js doctor
node dist/cli.js status
```

`doctor` reports SQLite integrity, applied migrations, foreign-key violations, FTS/base-table consistency, and interrupted run recovery. On startup, any run left as `running` by a terminated process becomes `failed`; the last committed generation remains active and a later retry receives a fresh generation number.

If integrity is not `ok`, stop all ContextMesh processes and restore the newest known-good backup. ContextMesh does not overwrite a corrupt database automatically.

## Index and freshness policy

The stdio server performs a strict baseline verification at startup and normally follows it with incremental indexing. Use `--no-auto-index` for clients that explicitly schedule `index_workspace`; strict startup verification still runs. The default `--freshness-mode fast` uses metadata scans and hashes changed candidates. `--freshness-mode strict` hashes the complete configured scope for every graph request.

Only one index operation runs at a time within a server process. ContextMesh Phase 3 supports one index-writer process per workspace: concurrent reader processes detect generation changes, but concurrent `index_workspace` calls from different processes are outside the supported contract. Operational messages use stderr; stdout is reserved for MCP frames.

Project-specific exclusions belong in `.contextmeshignore`. Secret-like filenames, `.env*`, credentials/secrets paths, certificates/keys, external symlinks, dependency folders, and common build outputs are excluded before parsing.

## Performance check

`npm run benchmark` creates and deletes a temporary 1,000-file project and runs 50 samples per p95 measurement. It fails if cold indexing exceeds 30 seconds, verified no-op indexing exceeds 2 seconds, fast public search-plus-trace p95 exceeds 100 ms, or fast public `get_context` p95 exceeds 150 ms. Raw database latency, strict startup verification, and strict public request p95 are reported separately as information. These are local guardrails, not cross-machine service-level guarantees.
