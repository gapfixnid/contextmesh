# Multilanguage providers (v0.4)

ContextMesh 0.4 indexes TypeScript/JavaScript and Python into one atomic graph generation. The TypeScript Compiler AST remains the production syntax source and its TypeChecker is the typed precision provider; both reuse one `Program`. Python parsing and extraction use the Rust graph-kernel sidecar with `tree-sitter-python@0.25.0`. The explicit portable policy retains the v0.3 `web-tree-sitter@0.26.11` provider and must produce the exact same ordered canonical graph.

Python capability is deliberately `syntax`: modules, functions, async functions, classes, methods, imports (including relative imports), inheritance, and unambiguous simple-call candidates. Candidate calls have confidence 0.80 and remain candidates; dynamic/attribute calls and ambiguous targets are unresolved. ContextMesh never confirms an edge across languages based on a name match. HTTP/RPC/queue/DB boundary linking is not available until v0.6.

Source roots include the workspace root, conventional `src`, `__init__.py` packages, PEP 420 namespace packages, and static setuptools `tool.setuptools.package-dir` / `tool.setuptools.packages.find.where` entries, including multiple roots. Unsupported Poetry/PDM/Hatch dynamic layout or invalid TOML produces `PYTHON_LAYOUT_FALLBACK` and continues with root plus `src`.

## Supply chain and operating systems

`tree-sitter-python@0.25.0`, the Rust runtime crates, `web-tree-sitter@0.26.11`, and `smol-toml@1.7.0` are exactly pinned. [graph-kernel.manifest.json](./graph-kernel.manifest.json), Rust `Cargo.lock`, and [python-parser.manifest.json](./python-parser.manifest.json) record the supply-chain contract. Runtime network use is zero. A release is supported only after Windows, Ubuntu, and macOS native build/contract jobs pass.

Runtime parsing performs no external network calls. Package acquisition is an install-time operation governed by `package-lock.json`; source files continue through the common ignore, secret, symlink, and size policy.
