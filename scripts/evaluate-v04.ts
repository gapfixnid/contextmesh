import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { ContextMeshApp } from "../src/app.js";
import { probeTypeScriptTreeSitter } from "../src/code/native-kernel.js";
import { sha256 } from "../src/utils.js";
import {
  expectedNativeRuntime,
  stableStringify,
  V04_ARTIFACT_CONTRACT,
  V04_FIXED_HARDWARE,
  validateFixedHardwareIdentity,
  v04CanonicalSourceEvidence,
} from "./v04-artifact-contract.js";

const sizes = { small: 6, medium: 30, large: 90 } as const;
const coldSamples = 5;
const warmSamples = 20;
const incrementalSamples = 10;
const watcherSamples = 20;
const determinismRuns = 20;
const temporaryRoots = new Set<string>();

type FixtureSize = keyof typeof sizes;

interface Fixture {
  root: string;
  digest: string;
  pythonPath: string;
  tsFiles: string[];
  manifest: Array<{ path: string; content: string }>;
}

function percentile(values: number[], fraction: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1))] ?? 0;
}

function summary(values: number[]) {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Performance samples must be finite, non-negative, and non-empty");
  }
  return {
    samples: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    minMs: Math.min(...values),
    maxMs: Math.max(...values),
  };
}

function write(root: string, relativePath: string, content: string, manifest?: Fixture["manifest"]): void {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
  manifest?.push({ path: relativePath.replaceAll("\\", "/"), content });
}

function typescriptSource(index: number): string {
  return `export function value${index}(input: number): number { return input + ${index}; }\nexport class Service${index} { run(): number { return value${index}(${index}); } }\n`;
}

function pythonSource(index: number, delta = index): string {
  return `def value_${index}(input):\n    return input + ${delta}\n\nclass Service_${index}:\n    def run(self):\n        return value_${index}(${index})\n`;
}

function fixture(label: FixtureSize): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), `contextmesh-v04-${label}-`));
  temporaryRoots.add(root);
  const manifest: Fixture["manifest"] = [];
  write(root, "tsconfig.json", JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true },
    include: ["src/**/*"],
  }), manifest);
  write(root, "pyproject.toml", "[tool.setuptools.packages.find]\nwhere=[\"src\"]\n", manifest);
  const tsFiles: string[] = [];
  for (let index = 0; index < sizes[label]; index += 1) {
    const tsPath = `src/ts/file-${index}.ts`;
    const pythonPath = `src/py/file_${index}.py`;
    write(root, tsPath, typescriptSource(index), manifest);
    write(root, pythonPath, pythonSource(index), manifest);
    tsFiles.push(path.join(root, tsPath));
  }
  manifest.sort((left, right) => left.path.localeCompare(right.path));
  return {
    root,
    digest: sha256(stableStringify({ label, countPerLanguage: sizes[label], files: manifest })),
    pythonPath: path.join(root, "src", "py", "file_0.py"),
    tsFiles,
    manifest,
  };
}

function removeTemporaryRoot(root: string): void {
  if (!temporaryRoots.has(root) || path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir())) {
    throw new Error(`Refusing to remove an unexpected performance fixture: ${root}`);
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  temporaryRoots.delete(root);
}

function normalizeGraph(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (key, item) => key === "generation" ? undefined : item);
}

async function graphDigestPair(root: string): Promise<{ nativeDigest: string; portableDigest: string }> {
  const previous = process.env.CONTEXTMESH_KERNEL_POLICY;
  delete process.env.CONTEXTMESH_KERNEL_POLICY;
  const app = new ContextMeshApp(root);
  try {
    await app.indexWorkspace({ mode: "full" });
    const nativeDigest = sha256(stableStringify(normalizeGraph(app.database.getStoredGraphPartition("python"))));
    process.env.CONTEXTMESH_KERNEL_POLICY = "portable";
    await app.indexWorkspace({ mode: "full" });
    const portableDigest = sha256(stableStringify(normalizeGraph(app.database.getStoredGraphPartition("python"))));
    return { nativeDigest, portableDigest };
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.CONTEXTMESH_KERNEL_POLICY;
    else process.env.CONTEXTMESH_KERNEL_POLICY = previous;
  }
}

async function runDeterminismChild(root: string): Promise<void> {
  process.stdout.write(`${JSON.stringify(await graphDigestPair(root))}\n`);
}

function adapterStats(result: unknown): Array<Record<string, unknown>> {
  return ((result as { data?: { adapterStats?: Array<Record<string, unknown>> } }).data?.adapterStats ?? []);
}

function pythonAdapter(result: unknown): Record<string, unknown> | undefined {
  return adapterStats(result).find((item) => item.language === "python");
}

function typescriptAdapter(result: unknown): Record<string, unknown> | undefined {
  return adapterStats(result).find((item) => item.language === "typescript/javascript");
}

function pythonRuntimeVersion(result: unknown): string | null {
  const versions = pythonAdapter(result)?.providerVersions;
  if (!versions || typeof versions !== "object") return null;
  const runtime = (versions as Record<string, unknown>).runtime;
  return typeof runtime === "string" ? runtime : null;
}

function activePowerSchemeGuid(): string {
  if (process.platform !== "win32") throw new Error("Canonical v0.4 evidence must be measured on Windows");
  const output = execFileSync("powercfg", ["/getactivescheme"], { encoding: "utf8" });
  const guid = output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  if (!guid) throw new Error("Cannot identify the active Windows power scheme");
  return guid.toLocaleLowerCase("en-US");
}

async function waitForGeneration(app: ContextMeshApp, generation: number, timeoutMs = 5_000): Promise<number> {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (app.database.getWorkspace().currentGeneration > generation) return performance.now() - started;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Watcher did not commit after generation ${generation}`);
}

function setQuality(actualValues: string[], expectedValues: string[]): { precision: number; recall: number; actual: string[]; expected: string[] } {
  const actual = [...new Set(actualValues)].sort();
  const expected = [...new Set(expectedValues)].sort();
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const matches = actual.filter((value) => expectedSet.has(value)).length;
  return {
    precision: actual.length === 0 ? (expected.length === 0 ? 1 : 0) : matches / actual.length,
    recall: expected.length === 0 ? 1 : expected.filter((value) => actualSet.has(value)).length / expected.length,
    actual,
    expected,
  };
}

function typescriptDecisionFixture(): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-v04-ts-decision-"));
  temporaryRoots.add(root);
  const manifest: Fixture["manifest"] = [];
  write(root, "tsconfig.json", JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true },
    include: ["src/**/*"],
  }), manifest);
  write(root, "src/external.ts", "export function external(input: number): number { return input + 1; }\n", manifest);
  write(root, "src/main.ts", "import { external } from './external.js';\nexport function local(input: number): number { return external(input); }\nexport class Runner { run(): number { return local(1); } }\n", manifest);
  manifest.sort((left, right) => left.path.localeCompare(right.path));
  return {
    root,
    digest: sha256(stableStringify({ purpose: "typescript-provider-decision-v1", files: manifest })),
    pythonPath: "",
    tsFiles: [path.join(root, "src", "external.ts"), path.join(root, "src", "main.ts")],
    manifest,
  };
}

async function evaluateTypeScriptDecision(item: Fixture) {
  const productionTimings: number[] = [];
  let productionGraph: ReturnType<ContextMeshApp["database"]["getStoredGraphPartition"]> | null = null;
  for (let sample = 0; sample < coldSamples; sample += 1) {
    const app = new ContextMeshApp(item.root, ":memory:");
    try {
      const started = performance.now();
      await app.indexWorkspace({ mode: "full" });
      productionTimings.push(performance.now() - started);
      productionGraph ??= app.database.getStoredGraphPartition("non-python");
    } finally {
      await app.close();
    }
  }
  if (!productionGraph) throw new Error("TypeScript production graph was not produced");
  const names = new Map(productionGraph.nodes.map((node) => [node.id, node.name]));
  const relevantEdges = productionGraph.edges
    .filter((edge) => edge.kind === "CALLS" || (edge.kind === "CONTAINS" && names.get(edge.sourceId) === "Runner" && names.get(edge.targetId) === "run"))
    .map((edge) => `${edge.kind}:${names.get(edge.sourceId)}->${names.get(edge.targetId)}`);
  const productionEdgeQuality = setQuality(relevantEdges, ["CALLS:local->external", "CALLS:run->local", "CONTAINS:Runner->run"]);

  const compilerTimings: number[] = [];
  const compilerRssDelta: number[] = [];
  let compilerCounts = { declarations: 0, imports: 0, calls: 0, resolvedCalls: 0 };
  for (let sample = 0; sample < warmSamples; sample += 1) {
    const before = process.memoryUsage().rss;
    const started = performance.now();
    const program = ts.createProgram({
      rootNames: item.tsFiles,
      options: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true },
    });
    const checker = program.getTypeChecker();
    const counts = { declarations: 0, imports: 0, calls: 0, resolvedCalls: 0 };
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node)
        || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
        counts.declarations += 1;
        const name = "name" in node ? (node as ts.NamedDeclaration).name : undefined;
        if (name) checker.getSymbolAtLocation(name);
      }
      if (ts.isImportDeclaration(node)) counts.imports += 1;
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        counts.calls += 1;
        if (checker.getResolvedSignature(node)) counts.resolvedCalls += 1;
      }
      ts.forEachChild(node, visit);
    };
    for (const sourceFile of program.getSourceFiles()) {
      if (item.tsFiles.includes(path.resolve(sourceFile.fileName))) visit(sourceFile);
    }
    compilerTimings.push(performance.now() - started);
    compilerRssDelta.push(Math.max(0, process.memoryUsage().rss - before));
    compilerCounts = counts;
  }

  const combinedSource = item.manifest.filter((entry) => entry.path.endsWith(".ts")).map((entry) => entry.content).join("\n");
  const treeSitterTimings: number[] = [];
  const treeSitterRss: number[] = [];
  let finalProbe: Awaited<ReturnType<typeof probeTypeScriptTreeSitter>> | null = null;
  for (let sample = 0; sample < warmSamples; sample += 1) {
    const started = performance.now();
    finalProbe = await probeTypeScriptTreeSitter(combinedSource);
    treeSitterTimings.push(performance.now() - started);
    treeSitterRss.push(finalProbe.rssBytes);
  }
  if (!finalProbe) throw new Error("TypeScript Tree-sitter probe did not run");
  const syntaxQuality = {
    declarations: setQuality(finalProbe.declarationNames, ["Runner", "external", "local", "run"]),
    imports: setQuality(finalProbe.importSpecifiers, ["./external.js"]),
    calls: setQuality(finalProbe.callNames, ["external", "local"]),
  };
  return {
    fixtureDigest: item.digest,
    productionDefault: "typescript-compiler-ast-plus-shared-program-typechecker",
    productionEndToEnd: { timing: summary(productionTimings), resolvedEdgeQuality: productionEdgeQuality },
    compilerProgramTypeChecker: {
      timing: summary(compilerTimings),
      peakRssDeltaBytes: Math.max(...compilerRssDelta),
      counts: compilerCounts,
      scope: "fresh createProgram + getTypeChecker + symbol/signature resolution over the fixed two-file project",
    },
    treeSitterBenchmarkOnly: {
      timing: summary(treeSitterTimings),
      peakSidecarRssBytes: Math.max(...treeSitterRss),
      counts: { declarations: finalProbe.declarations, imports: finalProbe.imports, calls: finalProbe.calls, nodes: finalProbe.nodes },
      syntaxQuality,
      resolvedEdgeQuality: null,
      precisionReady: false,
      hasError: finalProbe.hasError,
      scope: "fresh JSONL sidecar + Tree-sitter syntax facts; no TypeChecker or production edge resolver",
    },
    decision: "retain TypeScript Compiler AST and shared Program TypeChecker: the production path recovers every fixed gold resolved edge, while the benchmark-only Tree-sitter probe has syntax coverage but no resolved-edge precision path",
  };
}

async function runEvaluation(): Promise<void> {
  try {
    const fixtureDigests: Record<string, string> = {};
    const cold: Record<string, unknown> = {};
    let parentPeakRss = process.memoryUsage().rss;
    let kernelPeakRss = 0;
    let nativeRuntimeVersion: string | null = null;
    for (const label of Object.keys(sizes) as FixtureSize[]) {
      const timings: number[] = [];
      const parentRss: number[] = [];
      const kernelRss: number[] = [];
      for (let sample = 0; sample < coldSamples; sample += 1) {
        const item = fixture(label);
        fixtureDigests[label] = item.digest;
        const app = new ContextMeshApp(item.root);
        try {
          const started = performance.now();
          const result = await app.indexWorkspace({ mode: "full" });
          const observedRuntime = pythonRuntimeVersion(result);
          if (!observedRuntime) throw new Error("Native graph-kernel handshake version was not recorded");
          if (nativeRuntimeVersion && nativeRuntimeVersion !== observedRuntime) {
            throw new Error(`Native graph-kernel version changed during evaluation: ${nativeRuntimeVersion} -> ${observedRuntime}`);
          }
          nativeRuntimeVersion = observedRuntime;
          timings.push(performance.now() - started);
          const currentParent = process.memoryUsage().rss;
          const currentKernel = Number(pythonAdapter(result)?.kernelRssBytes ?? 0);
          parentRss.push(currentParent); kernelRss.push(currentKernel);
          parentPeakRss = Math.max(parentPeakRss, currentParent); kernelPeakRss = Math.max(kernelPeakRss, currentKernel);
        } finally {
          await app.close(); removeTemporaryRoot(item.root);
        }
      }
      cold[label] = { timing: summary(timings), peakParentRssBytes: Math.max(...parentRss), peakKernelRssBytes: Math.max(...kernelRss) };
    }

    const workloads: Record<string, unknown> = {};
    for (const label of Object.keys(sizes) as FixtureSize[]) {
      const item = fixture(label); fixtureDigests[label] = item.digest;
      const app = new ContextMeshApp(item.root); await app.indexWorkspace({ mode: "full" });
      try {
        const searchTimings: number[] = []; const traceTimings: number[] = []; const exploreTimings: number[] = [];
        const first = await app.searchCode({ query: "Service0", limit: 10 });
        const symbolId = ((first.data as { results: Array<{ id: string }> }).results[0]?.id) ?? "";
        for (let sample = 0; sample < warmSamples; sample += 1) {
          let started = performance.now(); await app.searchCode({ query: "Service0", limit: 10 }); searchTimings.push(performance.now() - started);
          started = performance.now(); await app.traceCode({ symbolId, direction: "both", depth: 2, limit: 50 }); traceTimings.push(performance.now() - started);
          started = performance.now(); await app.exploreContext({ query: "Service0", symbolId, intent: "implementation", tokenBudget: 2_000, limit: 10 }); exploreTimings.push(performance.now() - started);
        }
        const incrementTimings: number[] = []; const reparsed: number[] = []; const tsSyntax: number[] = []; const tsPrecision: number[] = [];
        const dbCommitMs: number[] = []; const kernelRss: number[] = [];
        for (let sample = 0; sample < incrementalSamples; sample += 1) {
          writeFileSync(item.pythonPath, pythonSource(0, sample + 100), "utf8");
          const started = performance.now(); const result = await app.indexWorkspace({ mode: "incremental" }); incrementTimings.push(performance.now() - started);
          const python = pythonAdapter(result); const typescript = typescriptAdapter(result);
          reparsed.push(Number(python?.filesReparsed ?? -1));
          kernelRss.push(Number(python?.kernelRssBytes ?? 0));
          tsSyntax.push(Number(typescript?.syntaxInvocations ?? -1));
          tsPrecision.push(Number(typescript?.precisionInvocations ?? -1));
          dbCommitMs.push(app.database.bulkCommitMetrics().lastCommitMs);
        }
        workloads[label] = {
          warm: { search: summary(searchTimings), trace: summary(traceTimings), explore: summary(exploreTimings) },
          singleFileIncremental: summary(incrementTimings),
          filesReparsed: reparsed,
          providerInvocations: { typescriptSyntax: tsSyntax, typescriptPrecision: tsPrecision },
          dbCommit: summary(dbCommitMs),
          peakKernelRssBytes: Math.max(...kernelRss),
        };
      } finally {
        await app.close(); removeTemporaryRoot(item.root);
      }
    }

    const parityFixture = fixture("small"); fixtureDigests.parity = parityFixture.digest;
    const { nativeDigest, portableDigest } = await graphDigestPair(parityFixture.root);
    const scriptPath = fileURLToPath(import.meta.url);
    const crossProcess: Array<{ nativeDigest: string; portableDigest: string }> = [];
    for (let run = 0; run < determinismRuns; run += 1) {
      const output = execFileSync(process.execPath, ["--import", "tsx", scriptPath, "--determinism-child", parityFixture.root], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        env: { ...process.env, CONTEXTMESH_KERNEL_POLICY: "" },
      }).trim();
      crossProcess.push(JSON.parse(output) as { nativeDigest: string; portableDigest: string });
    }
    const crossProcessPassed = crossProcess.length === determinismRuns
      && crossProcess.every((item) => item.nativeDigest === item.portableDigest && item.nativeDigest === nativeDigest)
      && nativeDigest === portableDigest;

    const watchFixture = fixture("small"); fixtureDigests.watcher = watchFixture.digest;
    const watchApp = new ContextMeshApp(watchFixture.root, undefined, { watcher: { debounceMs: 25 } });
    await watchApp.initialize(false);
    const watcherTimings: number[] = [];
    try {
      for (let sample = 0; sample < watcherSamples; sample += 1) {
        const generation = watchApp.database.getWorkspace().currentGeneration;
        writeFileSync(watchFixture.pythonPath, pythonSource(0, sample + 1_000), "utf8");
        watcherTimings.push(await waitForGeneration(watchApp, generation));
      }
    } finally {
      await watchApp.close();
    }

    const tsFixture = typescriptDecisionFixture(); fixtureDigests.typescriptDecision = tsFixture.digest;
    const typeScriptDecision = await evaluateTypeScriptDecision(tsFixture);

    const workloadValues = Object.values(workloads) as Array<{
      filesReparsed: number[];
      providerInvocations: { typescriptSyntax: number[]; typescriptPrecision: number[] };
    }>;
    const incrementalAccountingPassed = workloadValues.every((item) => item.filesReparsed.every((value) => value === 1)
      && item.providerInvocations.typescriptSyntax.every((value) => value === 0)
      && item.providerInvocations.typescriptPrecision.every((value) => value === 0));
    const tsQuality = typeScriptDecision.productionEndToEnd.resolvedEdgeQuality;
    const thresholds = {
      watcherP95Ms: 2_000,
      watcherPassed: percentile(watcherTimings, 0.95) <= 2_000 && watcherTimings.length === watcherSamples,
      parityPassed: nativeDigest === portableDigest,
      crossProcessDeterminismPassed: crossProcessPassed,
      incrementalAccountingPassed,
      typeScriptDecisionDataPassed: tsQuality.precision === 1 && tsQuality.recall === 1
        && typeScriptDecision.treeSitterBenchmarkOnly.precisionReady === false
        && !typeScriptDecision.treeSitterBenchmarkOnly.hasError,
    };
    const sourceOverrideIndex = process.argv.indexOf("--source-commit");
    const source = v04CanonicalSourceEvidence();
    const sourceCommit = sourceOverrideIndex >= 0 && process.argv[sourceOverrideIndex + 1]
      ? process.argv[sourceOverrideIndex + 1]!
      : source.headCommit;
    if (sourceCommit !== source.headCommit) {
      throw new Error(`Source commit override must equal measured HEAD ${source.headCommit}`);
    }
    if (source.dirty) {
      throw new Error("Canonical v0.4 performance evidence requires a clean non-artifact source snapshot");
    }
    const powerSchemeGuid = activePowerSchemeGuid();
    const hardwareIdentity = {
      hardwareProfile: V04_FIXED_HARDWARE.profile,
      os: `${os.platform()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model.trim() ?? "unknown",
      logicalCpus: os.cpus().length,
      ramBytes: os.totalmem(),
      powerSchemeGuid,
    };
    validateFixedHardwareIdentity(hardwareIdentity);
    if (nativeRuntimeVersion !== expectedNativeRuntime()) {
      throw new Error(`Native handshake version mismatch: ${nativeRuntimeVersion ?? "missing"}`);
    }
    const artifact = {
      schemaVersion: 4,
      git: { commit: sourceCommit, baseline: "e37977199e231fc95b581e6254003941b8f447b2" },
      source,
      fixtureDigest: sha256(stableStringify(fixtureDigests)),
      fixtures: fixtureDigests,
      runner: {
        contract: V04_ARTIFACT_CONTRACT,
        ...hardwareIdentity,
        node: process.version,
        rust: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(),
        native: nativeRuntimeVersion,
        mode: "sidecar",
        runtimeNetwork: 0,
      },
      measurements: {
        coldFull: cold,
        workloads,
        watcherEventToGeneration: summary(watcherTimings),
        rss: {
          peakParentRssBytes: parentPeakRss,
          peakKernelRssBytes: kernelPeakRss,
          estimatedConcurrentPeakBytes: parentPeakRss + kernelPeakRss,
          scope: "parent RSS sampled after commit plus sidecar RSS sampled while canonical facts remain resident",
        },
      },
      parity: {
        nativePortableExactOrdered: nativeDigest === portableDigest,
        nativeDigest,
        portableDigest,
        crossProcessRuns: determinismRuns,
        crossProcess,
        crossProcessDeterministic: crossProcessPassed,
      },
      typeScriptDecision,
      thresholds,
    };
    const outputIndex = process.argv.indexOf("--output");
    const output = path.resolve(outputIndex >= 0 && process.argv[outputIndex + 1]
      ? process.argv[outputIndex + 1]!
      : "artifacts/v04-performance.json");
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, `${stableStringify(artifact)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({
      output,
      watcher: summary(watcherTimings),
      parity: thresholds.parityPassed,
      crossProcessDeterministic: thresholds.crossProcessDeterminismPassed,
      incrementalAccounting: thresholds.incrementalAccountingPassed,
      tsDecision: typeScriptDecision.decision,
    }, null, 2)}\n`);
    if (Object.entries(thresholds).some(([key, value]) => key.endsWith("Passed") && value !== true)) process.exitCode = 1;
  } finally {
    for (const root of [...temporaryRoots]) removeTemporaryRoot(root);
  }
}

const childIndex = process.argv.indexOf("--determinism-child");
if (childIndex >= 0) {
  const root = process.argv[childIndex + 1];
  if (!root) throw new Error("--determinism-child requires a fixture root");
  await runDeterminismChild(path.resolve(root));
} else {
  await runEvaluation();
}
