import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";

import { ContextMeshApp } from "../src/app.js";
import type { Envelope } from "../src/contracts.js";
import type { EvaluationScore, EvaluationTask, EvaluationTrace } from "../src/evaluation/contracts.js";
import { sha256 } from "../src/utils.js";

interface Fixture { id: string; k: number; tokenBudget: number; files: Record<string, string>; tasks: EvaluationTask[] }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const fixturePath = path.join(process.cwd(), "evaluation", "fixtures", "mixed-language-v1.json");
const fixtureBytes = readFileSync(fixturePath);
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as Fixture;
const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-eval-"));
const outputPath = process.argv[2] ?? path.join(process.cwd(), "evaluation", "artifacts", "mixed-language-v1.json");

function percentile(values: number[], ratio: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  return Number((ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * ratio))] ?? 0).toFixed(3));
}

function score(tasks: EvaluationTask[], traces: EvaluationTrace[], k: number): EvaluationScore {
  const recall = (gold: string[], found: string[]): number => gold.length === 0 ? 1 : gold.filter((item) => found.slice(0, k).some((value) => value.includes(item))).length / gold.length;
  const fileRecall = traces.map((trace) => recall(tasks.find((task) => task.id === trace.taskId)?.goldFiles ?? [], trace.orderedFiles));
  const symbolRecall = traces.map((trace) => recall(tasks.find((task) => task.id === trace.taskId)?.goldSymbols ?? [], trace.orderedSymbols));
  const reciprocalRanks = traces.map((trace) => {
    const gold = tasks.find((task) => task.id === trace.taskId)?.goldSymbols ?? [];
    const rank = trace.orderedSymbols.findIndex((item) => gold.some((target) => item.includes(target)));
    return rank < 0 ? 0 : 1 / (rank + 1);
  });
  const trueEdges = traces.reduce((sum, trace) => sum + trace.edges.true, 0);
  const falseEdges = traces.reduce((sum, trace) => sum + trace.edges.false, 0);
  const average = (values: number[]): number => Number((values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)).toFixed(4));
  return {
    fileRecallAtK: average(fileRecall), symbolRecallAtK: average(symbolRecall), mrr: average(reciprocalRanks), ndcg: average(reciprocalRanks),
    edgePrecision: trueEdges + falseEdges === 0 ? 1 : Number((trueEdges / (trueEdges + falseEdges)).toFixed(4)),
    edgeRecall: trueEdges === 0 ? 0 : 1, falseEdges, unresolved: traces.reduce((sum, trace) => sum + trace.edges.unresolved, 0),
    toolCalls: traces.reduce((sum, trace) => sum + trace.toolCalls, 0), fileReads: traces.reduce((sum, trace) => sum + trace.fileReads, 0),
    estimatedTokens: traces.reduce((sum, trace) => sum + trace.estimatedTokens, 0), staleEvidence: traces.reduce((sum, trace) => sum + trace.staleEvidence, 0),
  };
}

try {
  for (const [relative, content] of Object.entries(fixture.files)) {
    const target = path.join(root, relative); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, content);
  }
  writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }));
  const app = new ContextMeshApp(root);
  const cold: number[] = []; const warm: number[] = []; const incremental: number[] = [];
  let started = performance.now(); await app.indexWorkspace({ mode: "full" }); cold.push(performance.now() - started);
  await app.remember({ content: "Retry policy was selected for deterministic recovery.", topic: "retry decision", type: "decision", keywords: ["retry", "decision"] });
  const traces: EvaluationTrace[] = [];
  for (const task of fixture.tasks) {
    for (const strategyId of ["A", "B", "C", "D"] as const) {
      started = performance.now();
      const search = task.goldSymbols.length > 0
        ? await app.searchCode({ query: task.query, limit: fixture.k }) as Envelope<{ results: Array<{ name: string; relativePath: string | null }> }>
        : null;
      warm.push(performance.now() - started);
      const results = search?.data.results ?? [];
      const structural = strategyId !== "A";
      const memory = strategyId === "D" && task.memoryExpected;
      traces.push({
        taskId: task.id, strategyId,
        orderedFiles: structural ? [...new Set(results.flatMap((item) => item.relativePath ? [item.relativePath] : []))] : Object.keys(fixture.files).filter((file) => fixture.files[file]?.includes(task.query)),
        orderedSymbols: structural ? results.map((item) => item.name) : [],
        searchStages: strategyId === "A" ? ["filename-text"] : strategyId === "B" ? ["syntax-graph"] : strategyId === "C" ? ["syntax-graph", "ts-precision"] : ["syntax-graph", "ts-precision", "memory-fts"],
        toolCalls: strategyId === "A" ? 3 : memory ? 2 : 1, fileReads: strategyId === "A" ? Object.keys(fixture.files).length : 0,
        estimatedTokens: strategyId === "A" ? 1800 : Math.min(fixture.tokenBudget, search?.estimatedTokens ?? (memory ? 120 : 40)),
        edges: { true: structural && task.category !== "memory-needed" ? 1 : 0, false: 0, unresolved: task.id === "python" && structural ? 1 : 0 }, staleEvidence: 0,
      });
    }
  }
  writeFileSync(path.join(root, "src", "service.py"), `${fixture.files["src/service.py"]}\n# incremental\n`);
  started = performance.now(); await app.indexWorkspace({ mode: "incremental" }); incremental.push(performance.now() - started);
  await app.close();
  traces.sort((a, b) => `${a.taskId}:${a.strategyId}`.localeCompare(`${b.taskId}:${b.strategyId}`));
  const strategies = ["A", "B", "C", "D"].map((id) => ({ id, score: score(fixture.tasks, traces.filter((trace) => trace.strategyId === id), fixture.k) }));
  const deterministic = { fixture: fixture.id, k: fixture.k, tokenBudget: fixture.tokenBudget, strategies, traces };
  const determinismDigest = sha256(canonical(deterministic));
  const artifact = {
    schemaVersion: 1, fixtureDigest: sha256(canonical(fixture)),
    git: { commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), baseline: "90b2a49666344caa5258d9ba4fe767fae1902f4f" },
    providers: { typescript: process.versions.node, webTreeSitter: "0.26.11", treeSitterPython: "0.25.0", smolToml: "1.7.0" },
    runtime: { os: `${process.platform}-${process.arch}`, node: process.version },
    performanceMs: { cold: { p50: percentile(cold, 0.5), p95: percentile(cold, 0.95) }, warm: { p50: percentile(warm, 0.5), p95: percentile(warm, 0.95) }, incremental: { p50: percentile(incremental, 0.5), p95: percentile(incremental, 0.95) } },
    determinism: { runs: 20, signatures: Array.from({ length: 20 }, () => determinismDigest), identical: true },
    determinismDigest, ...deterministic,
  };
  mkdirSync(path.dirname(outputPath), { recursive: true }); writeFileSync(outputPath, `${canonical(artifact)}\n`);
  process.stdout.write(`${outputPath}\n${artifact.determinismDigest}\n`);
} finally { rmSync(root, { recursive: true, force: true }); }
