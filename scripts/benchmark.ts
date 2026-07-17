import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { ContextMeshApp } from "../src/app.js";
import type { Envelope } from "../src/contracts.js";
import type { CodeSearchResult } from "../src/storage/database.js";

const FILE_COUNT = 1_000;
const limits = {
  coldIndexMs: 30_000,
  noOpIndexMs: 2_000,
  fastPublicSearchTraceP95Ms: 100,
  fastPublicGetContextP95Ms: 150,
};

function percentile95(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
}

const root = mkdtempSync(path.join(tmpdir(), "contextmesh-benchmark-"));
const sourceDirectory = path.join(root, "src");
mkdirSync(sourceDirectory, { recursive: true });
writeFileSync(
  path.join(root, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
    },
    include: ["src/**/*.ts"],
  }),
  "utf8",
);
for (let index = 0; index < FILE_COUNT; index += 1) {
  const content =
    index === 0
      ? `export function symbol0(value: number): number { return value; }\n`
      : `import { symbol${index - 1} } from "./file${index - 1}.js";\n` +
        `export function symbol${index}(value: number): number { return symbol${index - 1}(value) + 1; }\n`;
  writeFileSync(path.join(sourceDirectory, `file${index}.ts`), content, "utf8");
}

let app = new ContextMeshApp(root);
try {
  const coldStarted = performance.now();
  await app.indexWorkspace({ mode: "full" });
  const coldIndexMs = performance.now() - coldStarted;

  const noOpStarted = performance.now();
  await app.indexWorkspace({ mode: "incremental" });
  const noOpIndexMs = performance.now() - noOpStarted;

  app.close();
  app = new ContextMeshApp(root, undefined, { freshnessMode: "fast" });
  const strictStartupStarted = performance.now();
  await app.initialize(false);
  const strictStartupVerificationMs = performance.now() - strictStartupStarted;

  const seed = app.database.searchCode(`symbol${FILE_COUNT - 1}`, ["function"], 1)[0];
  const symbolId = seed?.id;
  if (!symbolId) throw new Error("Benchmark search failed to find the terminal symbol");

  const databaseSearchTraceDurations: number[] = [];
  for (let index = 0; index < 50; index += 1) {
    const started = performance.now();
    app.database.searchCode(`symbol${FILE_COUNT - 1}`, ["function"], 5);
    app.database.traceCode(symbolId, "out", ["CALLS"], 1, 10);
    databaseSearchTraceDurations.push(performance.now() - started);
  }

  const fastPublicSearchTraceDurations: number[] = [];
  for (let index = 0; index < 50; index += 1) {
    const started = performance.now();
    const search = await app.searchCode({ query: `symbol${FILE_COUNT - 1}`, kinds: ["function"], limit: 5 }) as Envelope<{
      results: CodeSearchResult[];
    }>;
    const endToEndSymbolId = search.data.results[0]?.id;
    if (!endToEndSymbolId) throw new Error("Benchmark public search failed to find the terminal symbol");
    await app.traceCode({ symbolId: endToEndSymbolId, direction: "out", edgeKinds: ["CALLS"], depth: 1, limit: 10 });
    fastPublicSearchTraceDurations.push(performance.now() - started);
  }

  const fastPublicGetContextDurations: number[] = [];
  for (let index = 0; index < 50; index += 1) {
    const started = performance.now();
    await app.getContext({
      query: `symbol${FILE_COUNT - 1}`,
      symbolId,
      tokenBudget: 2000,
      include: ["code", "memory"],
    });
    fastPublicGetContextDurations.push(performance.now() - started);
  }

  const strictApp = new ContextMeshApp(root, undefined, { freshnessMode: "strict" });
  await strictApp.initialize(false);
  const strictPublicSearchTraceDurations: number[] = [];
  const strictPublicGetContextDurations: number[] = [];
  try {
    for (let index = 0; index < 50; index += 1) {
      const started = performance.now();
      const search = await strictApp.searchCode({
        query: `symbol${FILE_COUNT - 1}`,
        kinds: ["function"],
        limit: 5,
      }) as Envelope<{ results: CodeSearchResult[] }>;
      const strictSymbolId = search.data.results[0]?.id;
      if (!strictSymbolId) throw new Error("Strict benchmark search failed");
      await strictApp.traceCode({
        symbolId: strictSymbolId,
        direction: "out",
        edgeKinds: ["CALLS"],
        depth: 1,
        limit: 10,
      });
      strictPublicSearchTraceDurations.push(performance.now() - started);
    }
    for (let index = 0; index < 50; index += 1) {
      const started = performance.now();
      await strictApp.getContext({
        query: `symbol${FILE_COUNT - 1}`,
        symbolId,
        tokenBudget: 2000,
        include: ["code", "memory"],
      });
      strictPublicGetContextDurations.push(performance.now() - started);
    }
  } finally {
    strictApp.close();
  }
  const databaseSearchTraceP95Ms = percentile95(databaseSearchTraceDurations);
  const fastPublicSearchTraceP95Ms = percentile95(fastPublicSearchTraceDurations);
  const fastPublicGetContextP95Ms = percentile95(fastPublicGetContextDurations);
  const strictPublicSearchTraceP95Ms = percentile95(strictPublicSearchTraceDurations);
  const strictPublicGetContextP95Ms = percentile95(strictPublicGetContextDurations);
  const result = {
    files: FILE_COUNT,
    coldIndexMs: Math.round(coldIndexMs * 100) / 100,
    noOpIndexMs: Math.round(noOpIndexMs * 100) / 100,
    databaseSearchTraceP95Ms: Math.round(databaseSearchTraceP95Ms * 100) / 100,
    fastPublicSearchTraceP95Ms: Math.round(fastPublicSearchTraceP95Ms * 100) / 100,
    fastPublicGetContextP95Ms: Math.round(fastPublicGetContextP95Ms * 100) / 100,
    strictStartupVerificationMs: Math.round(strictStartupVerificationMs * 100) / 100,
    strictPublicSearchTraceP95Ms: Math.round(strictPublicSearchTraceP95Ms * 100) / 100,
    strictPublicGetContextP95Ms: Math.round(strictPublicGetContextP95Ms * 100) / 100,
    limits,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (
    coldIndexMs > limits.coldIndexMs ||
    noOpIndexMs > limits.noOpIndexMs ||
    fastPublicSearchTraceP95Ms > limits.fastPublicSearchTraceP95Ms ||
    fastPublicGetContextP95Ms > limits.fastPublicGetContextP95Ms
  ) {
    throw new Error("ContextMesh benchmark exceeded one or more MVP performance limits");
  }
} finally {
  app.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}
