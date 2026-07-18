import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

import { ContextMeshApp } from "../src/app.js";
import { extractPythonKernelFacts, probeTypeScriptTreeSitter } from "../src/code/native-kernel.js";
import { sha256 } from "../src/utils.js";

const sizes = { small: 6, medium: 30, large: 90 } as const;
const samples = 5;
const determinismRuns = 20;

function stableStringify(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, normalize(nested)]));
    return item;
  };
  return JSON.stringify(normalize(value));
}

function percentile(values: number[], fraction: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1))] ?? 0;
}
function summary(values: number[]) { return { samples: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), minMs: Math.min(...values), maxMs: Math.max(...values) }; }
function write(root: string, relative: string, content: string): void { const target = path.join(root, relative); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, content, "utf8"); }

function fixture(label: keyof typeof sizes): { root: string; digest: string; pythonPath: string; tsSource: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), `contextmesh-v04-${label}-`));
  write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true }, include: ["src/**/*"] }));
  write(root, "pyproject.toml", '[tool.setuptools.packages.find]\nwhere=["src"]\n');
  const chunks: string[] = [];
  for (let index = 0; index < sizes[label]; index += 1) {
    const tsSource = `export function value${index}(input: number): number { return input + ${index}; }\nexport class Service${index} { run(): number { return value${index}(${index}); } }\n`;
    const pySource = `def value_${index}(input):\n    return input + ${index}\n\nclass Service_${index}:\n    def run(self):\n        return value_${index}(${index})\n`;
    write(root, `src/ts/file-${index}.ts`, tsSource); write(root, `src/py/file_${index}.py`, pySource); chunks.push(tsSource, pySource);
  }
  return { root, digest: sha256(chunks.join("\0")), pythonPath: path.join(root, "src", "py", "file_0.py"), tsSource: chunks[0] ?? "" };
}

async function waitForGeneration(app: ContextMeshApp, generation: number, timeoutMs = 5000): Promise<number> {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (app.database.getWorkspace().currentGeneration > generation) return performance.now() - started;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Watcher did not commit after generation ${generation}`);
}

function normalizeGraph(value: unknown): unknown { return JSON.parse(JSON.stringify(value), (key, item) => key === "generation" ? undefined : item); }

const fixtureDigests: Record<string, string> = {}; const cold: Record<string, ReturnType<typeof summary>> = {}; let peakRss = process.memoryUsage().rss;
for (const label of Object.keys(sizes) as Array<keyof typeof sizes>) {
  const timings: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const item = fixture(label); fixtureDigests[label] = item.digest;
    const app = new ContextMeshApp(item.root);
    try { const started = performance.now(); await app.indexWorkspace({ mode: "full" }); timings.push(performance.now() - started); peakRss = Math.max(peakRss, process.memoryUsage().rss); }
    finally { await app.close(); rmSync(item.root, { recursive: true, force: true, maxRetries: 5 }); }
  }
  cold[label] = summary(timings);
}

const working = fixture("medium"); const app = new ContextMeshApp(working.root); await app.indexWorkspace({ mode: "full" });
const searchSamples: number[] = []; const traceSamples: number[] = []; const exploreSamples: number[] = [];
const search = await app.searchCode({ query: "Service0", limit: 10 });
const symbol = ((search.data as { results: Array<{ id: string }> }).results[0]?.id) ?? "";
for (let index = 0; index < determinismRuns; index += 1) {
  let started = performance.now(); await app.searchCode({ query: "Service0", limit: 10 }); searchSamples.push(performance.now() - started);
  started = performance.now(); await app.traceCode({ symbolId: symbol, direction: "both", depth: 2, limit: 50 }); traceSamples.push(performance.now() - started);
  started = performance.now(); await app.exploreContext({ query: "Service0", symbolId: symbol, intent: "implementation", tokenBudget: 2000, limit: 10 }); exploreSamples.push(performance.now() - started);
}
const incrementalSamples: number[] = []; const providerInvocations: unknown[] = []; const filesReparsed: number[] = [];
for (let index = 0; index < 10; index += 1) {
  writeFileSync(working.pythonPath, `def value_0(input):\n    return input + ${index + 1}\n`, "utf8");
  const started = performance.now(); const result = await app.indexWorkspace({ mode: "incremental" }); incrementalSamples.push(performance.now() - started);
  const data = result.data as { changedFiles: number; adapterStats: unknown[] }; filesReparsed.push(data.changedFiles); providerInvocations.push(data.adapterStats);
}
const commit = app.database.bulkCommitMetrics();
await app.close();

const parityFixture = fixture("small"); const parityApp = new ContextMeshApp(parityFixture.root);
await parityApp.indexWorkspace({ mode: "full" }); const nativeGraph = parityApp.database.getStoredGraphPartition("python");
process.env.CONTEXTMESH_KERNEL_POLICY = "portable"; await parityApp.indexWorkspace({ mode: "full" }); delete process.env.CONTEXTMESH_KERNEL_POLICY;
const portableGraph = parityApp.database.getStoredGraphPartition("python"); await parityApp.close();
const parity = stableStringify(normalizeGraph(nativeGraph)) === stableStringify(normalizeGraph(portableGraph));
const scanContent = readFileSync(parityFixture.pythonPath, "utf8");
const scan = { absolutePath: parityFixture.pythonPath, relativePath: "src/py/file_0.py", pathKey: "src/py/file_0.py", language: "python" as const,
  content: scanContent, contentHash: sha256(scanContent), sizeBytes: Buffer.byteLength(scanContent), mtimeMs: 1 };
const signatures: string[] = [];
for (let index = 0; index < determinismRuns; index += 1) signatures.push(sha256(stableStringify((await extractPythonKernelFacts([scan], "native-required", true)).files)));
const portableSignature = sha256(stableStringify((await extractPythonKernelFacts([scan], "portable")).files));

const watchFixture = fixture("small"); const watchApp = new ContextMeshApp(watchFixture.root, undefined, { watcher: { debounceMs: 25 } }); await watchApp.initialize(false);
const watcherSamples: number[] = [];
for (let index = 0; index < 10; index += 1) {
  const generation = watchApp.database.getWorkspace().currentGeneration;
  writeFileSync(watchFixture.pythonPath, `def value_0(input):\n    return input + ${index + 100}\n`, "utf8");
  watcherSamples.push(await waitForGeneration(watchApp, generation));
}
await watchApp.close();

const compilerSamples: number[] = []; const treeSitterSamples: number[] = []; let compilerRss = 0; let treeSitterRss = 0; let compilerCounts = { declarations: 0, imports: 0, calls: 0 };
for (let index = 0; index < determinismRuns; index += 1) {
  let started = performance.now(); const source = ts.createSourceFile("probe.ts", parityFixture.tsSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  compilerSamples.push(performance.now() - started); compilerRss = Math.max(compilerRss, process.memoryUsage().rss);
  const counts = { declarations: 0, imports: 0, calls: 0 };
  const visit = (node: ts.Node): void => { if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node)) counts.declarations += 1; if (ts.isImportDeclaration(node)) counts.imports += 1; if (ts.isCallExpression(node) || ts.isNewExpression(node)) counts.calls += 1; ts.forEachChild(node, visit); }; visit(source); compilerCounts = counts;
  started = performance.now(); const probe = await probeTypeScriptTreeSitter(parityFixture.tsSource); treeSitterSamples.push(performance.now() - started); treeSitterRss = Math.max(treeSitterRss, probe.rssBytes);
}
const finalProbe = await probeTypeScriptTreeSitter(parityFixture.tsSource);

const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const artifact = {
  schemaVersion: 1, git: { commit: gitCommit, baseline: "e37977199e231fc95b581e6254003941b8f447b2" }, fixtureDigest: sha256(stableStringify(fixtureDigests)),
  runner: { contract: "contextmesh-v04-fixed-fixtures-v1", os: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model ?? "unknown", logicalCpus: os.cpus().length, ramBytes: os.totalmem(), node: process.version,
    rust: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(), native: "contextmesh-graph-kernel@0.4.0", mode: "sidecar", runtimeNetwork: 0 },
  fixtures: fixtureDigests, measurements: { coldFull: cold, warm: { search: summary(searchSamples), trace: summary(traceSamples), explore: summary(exploreSamples) },
    singleFileIncremental: summary(incrementalSamples), watcherEventToGeneration: summary(watcherSamples), peakRssBytes: peakRss, filesReparsed, providerInvocations, dbCommit: commit },
  parity: { nativePortableExactOrdered: parity, nativeSignatures: signatures, portableSignature, deterministic20: new Set(signatures).size === 1 && signatures[0] === portableSignature },
  typeScriptProbe: { productionDefault: "typescript-compiler-ast", compiler: { timing: summary(compilerSamples), rssBytes: compilerRss, edgeCounts: compilerCounts },
    treeSitterBenchmarkOnly: { timing: summary(treeSitterSamples), rssBytes: treeSitterRss, edgeCounts: { declarations: finalProbe.declarations, imports: finalProbe.imports, calls: finalProbe.calls }, hasError: finalProbe.hasError },
    decision: "retain TypeScript Compiler AST and shared Program TypeChecker; sidecar startup dominates this small probe and precision parity is not established" },
  thresholds: { watcherP95Ms: 2000, watcherPassed: percentile(watcherSamples, 0.95) <= 2000, parityPassed: parity, determinismPassed: new Set(signatures).size === 1 && signatures[0] === portableSignature },
};
const outputIndex = process.argv.indexOf("--output"); const output = path.resolve(outputIndex >= 0 && process.argv[outputIndex + 1] ? process.argv[outputIndex + 1]! : "artifacts/v04-performance.json");
mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, `${stableStringify(artifact)}\n`, "utf8");
for (const root of [working.root, parityFixture.root, watchFixture.root]) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
process.stdout.write(`${JSON.stringify({ output, watcher: summary(watcherSamples), parity, deterministic20: artifact.parity.deterministic20, tsDecision: artifact.typeScriptProbe.decision }, null, 2)}\n`);
if (!artifact.thresholds.watcherPassed || !artifact.thresholds.parityPassed || !artifact.thresholds.determinismPassed) process.exitCode = 1;
