# Multilanguage providers (v0.3)

ContextMesh 0.3 indexes TypeScript/JavaScript and Python into one atomic graph generation. The TypeScript Compiler AST remains the syntax source and its TypeChecker is the typed precision provider; both reuse one `Program`. Python uses the WASM grammar through `web-tree-sitter`, so no native parser binary is loaded at runtime.

Python capability is deliberately `syntax`: modules, functions, async functions, classes, methods, imports (including relative imports), inheritance, and unambiguous simple-call candidates. Candidate calls have confidence 0.80 and remain candidates; dynamic/attribute calls and ambiguous targets are unresolved. ContextMesh never confirms an edge across languages based on a name match. HTTP/RPC/queue/DB boundary linking is not available until v0.6.

Source roots include the workspace root, conventional `src`, `__init__.py` packages, PEP 420 namespace packages, and static setuptools `tool.setuptools.package-dir` / `tool.setuptools.packages.find.where` entries, including multiple roots. Unsupported Poetry/PDM/Hatch dynamic layout or invalid TOML produces `PYTHON_LAYOUT_FALLBACK` and continues with root plus `src`.

## Supply chain and operating systems

`web-tree-sitter@0.26.11`, `tree-sitter-python@0.25.0`, and `smol-toml@1.7.0` are exact dependencies. [python-parser.manifest.json](./python-parser.manifest.json) records npm integrity values and the shipped grammar WASM SHA-256. The unit suite checks all pins and the WASM digest automatically. CI runs typecheck, lint, tests, package verification, and consumer smoke on Windows, Ubuntu, and macOS; the v0.3 implementation was locally verified on Windows x64. The WASM parser avoids an OS-specific native ABI, but a release is supported only after all three hosted OS jobs pass.

Runtime parsing performs no external network calls. Package acquisition is an install-time operation governed by `package-lock.json`; source files continue through the common ignore, secret, symlink, and size policy.
