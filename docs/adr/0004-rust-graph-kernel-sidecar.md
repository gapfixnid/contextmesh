# ADR-0004: Rust graph-kernel sidecar for v0.4

Status: accepted for v0.4.

ContextMesh uses a versioned JSON-lines sidecar instead of an N-API addon. The sidecar performs real, parallel Tree-sitter Python extraction and owns the native OS watcher. Node remains the canonical-ID, freshness, and atomic SQLite commit control plane.

This boundary avoids Node ABI coupling, isolates parser/watcher crashes, is observable through a strict protocol handshake, and permits an explicit portable provider when a supported binary is unavailable. A failed, crashed, or mismatched sidecar never returns a committable batch; the active SQLite generation and generation-keyed query cache remain unchanged.

The cost is one child process and JSON serialization. v0.4 measurements record that overhead. N-API and a production TypeScript Tree-sitter provider remain out of scope.
