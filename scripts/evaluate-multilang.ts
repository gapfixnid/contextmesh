import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import ts from "typescript";

import { ContextMeshApp } from "../src/app.js";
import type { CodeEdgeRecord, CodeNodeRecord, Envelope, ExtractedGraph, MemoryFragmentRecord } from "../src/contracts.js";
import type { EvaluationScore, EvaluationStrategy, EvaluationTask, EvaluationTrace } from "../src/evaluation/contracts.js";
import { PYTHON_PROVIDER_VERSIONS } from "../src/code/languages/python.js";
import { sha256 } from "../src/utils.js";

interface Fixture { id: string; k: number; tokenBudget: number; files: Record<string, string>; tasks: EvaluationTask[] }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function percentile(values: number[], ratio: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  return Number((ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * ratio))] ?? 0).toFixed(3));
}

function recall(gold: string[], found: string[], k: number): number {
  return gold.length === 0 ? 1 : gold.filter((item) => found.slice(0, k).some((value) => value.includes(item))).length / gold.length;
}

function ndcg(gold: string[], found: string[], k: number): number {
  if (gold.length === 0) return 1;
  const remaining = new Set(gold);
  const dcg = found.slice(0, k).reduce((sum, item, index) => {
    const match = [...remaining].find((target) => item.includes(target));
    if (!match) return sum;
    remaining.delete(match);
    return sum + 1 / Math.log2(index + 2);
  }, 0);
  const ideal = Array.from({ length: Math.min(gold.length, k) }, (_, index) => 1 / Math.log2(index + 2)).reduce((a, b) => a + b, 0);
  return ideal === 0 ? 0 : dcg / ideal;
}

function score(tasks: EvaluationTask[], traces: EvaluationTrace[], k: number): EvaluationScore {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const average = (values: number[]): number => Number((values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)).toFixed(4));
  const trueEdges = traces.reduce((sum, trace) => sum + trace.edges.true, 0);
  const falseEdges = traces.reduce((sum, trace) => sum + trace.edges.false, 0);
  const goldEdges = traces.reduce((sum, trace) => sum + trace.edges.gold, 0);
  const ranks = traces.map((trace) => {
    const gold = taskById.get(trace.taskId)?.goldSymbols ?? [];
    const rank = trace.orderedSymbols.findIndex((item) => gold.some((target) => item.includes(target)));
    return gold.length === 0 ? 1 : rank < 0 ? 0 : 1 / (rank + 1);
  });
  const memoryTasks = traces.filter((trace) => taskById.get(trace.taskId)?.memoryExpected);
  return {
    fileRecallAtK: average(traces.map((trace) => recall(taskById.get(trace.taskId)?.goldFiles ?? [], trace.orderedFiles, k))),
    symbolRecallAtK: average(traces.map((trace) => recall(taskById.get(trace.taskId)?.goldSymbols ?? [], trace.orderedSymbols, k))),
    mrr: average(ranks),
    ndcg: average(traces.map((trace) => ndcg(taskById.get(trace.taskId)?.goldSymbols ?? [], trace.orderedSymbols, k))),
    edgePrecision: trueEdges + falseEdges === 0 ? 1 : Number((trueEdges / (trueEdges + falseEdges)).toFixed(4)),
    edgeRecall: goldEdges === 0 ? 1 : Number((trueEdges / goldEdges).toFixed(4)),
    falseEdges, unresolved: traces.reduce((sum, trace) => sum + trace.edges.unresolved, 0),
    toolCalls: traces.reduce((sum, trace) => sum + trace.toolCalls, 0), fileReads: traces.reduce((sum, trace) => sum + trace.fileReads, 0),
    estimatedTokens: traces.reduce((sum, trace) => sum + trace.estimatedTokens, 0), staleEvidence: traces.reduce((sum, trace) => sum + trace.staleEvidence, 0),
    memoryRecall: average(memoryTasks.map((trace) => recall(taskById.get(trace.taskId)?.goldMemories ?? [], trace.orderedMemories, k))),
    memoryLeak: traces.reduce((sum, trace) => sum + trace.memoryLeak, 0),
  };
}

const fixturePath = path.join(process.cwd(), "evaluation", "fixtures", "mixed-language-v1.json");
const fixtureBytes = readFileSync(fixturePath);
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as Fixture;
const outputPath = process.argv[2] ?? path.join(process.cwd(), "evaluation", "artifacts", "mixed-language-v1.json");
const roots: string[] = [];

function materialize(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-eval-"));
  roots.push(root);
  for (const [relative, content] of Object.entries(fixture.files)) {
    const target = path.join(root, relative); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, content);
  }
  writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }));
  return root;
}

function edgeKey(edge: CodeEdgeRecord, nodes: Map<string, CodeNodeRecord>): string {
  return `${edge.kind}:${nodes.get(edge.sourceId)?.name ?? edge.sourceId}:${nodes.get(edge.targetId)?.name ?? edge.targetId}`;
}

function observeGraph(task: EvaluationTask, graph: ExtractedGraph, resultIds: string[], generation: number): Pick<EvaluationTrace, "edges" | "staleEvidence"> {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const gold = new Set(task.goldEdges ?? []);
  const relevant = new Set(resultIds);
  const resultLanguages = new Set(resultIds.map((id) => nodes.get(id)?.language).filter(Boolean));
  for (const item of gold) {
    const [, source, target] = item.split(":");
    for (const node of graph.nodes) if ((node.name === source || node.name === target) &&
      (resultLanguages.size === 0 || resultLanguages.has(node.language))) relevant.add(node.id);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of graph.edges) if (edge.kind === "CONTAINS" && relevant.has(edge.sourceId) && !relevant.has(edge.targetId)) {
      relevant.add(edge.targetId); changed = true;
    }
  }
  const goldKinds = new Set([...gold].map((item) => item.split(":")[0]));
  const predicted = graph.edges.filter((edge) => goldKinds.has(edge.kind) && (relevant.has(edge.sourceId) || relevant.has(edge.targetId)));
  const predictedKeys = predicted.map((edge) => edgeKey(edge, nodes));
  const trueEdges = [...gold].filter((item) => predictedKeys.includes(item)).length;
  const falseEdges = predictedKeys.filter((item) => !gold.has(item)).length + graph.edges.filter((edge) => {
    const source = nodes.get(edge.sourceId); const target = nodes.get(edge.targetId);
    return edge.status === "resolved" && source && target && source.language !== target.language;
  }).length;
  const unresolved = graph.unresolvedReferences.filter((item) => relevant.has(item.sourceNodeId ?? "") || (task.goldUnresolved ?? []).includes(item.rawName)).length;
  const staleEvidence = [...predicted, ...graph.unresolvedReferences.filter((item) => relevant.has(item.sourceNodeId ?? ""))]
    .filter((item) => item.generation !== generation).length;
  return { edges: { true: trueEdges, false: falseEdges, gold: gold.size, unresolved }, staleEvidence };
}

try {
  const root = materialize();
  const app = new ContextMeshApp(root);
  const cold: number[] = [];
  let started = performance.now(); await app.indexWorkspace({ mode: "full" }); cold.push(performance.now() - started);
  for (let sample = 1; sample < 5; sample += 1) {
    const sampleRoot = materialize(); const sampleApp = new ContextMeshApp(sampleRoot);
    started = performance.now(); await sampleApp.indexWorkspace({ mode: "full" }); cold.push(performance.now() - started);
    await sampleApp.close();
  }
  const linkTarget = await app.searchCode({ query: "tsHelper", limit: 1 }) as Envelope<{ results: Array<{ id: string }> }>;
  await app.remember({ content: "Retry policy was selected for deterministic recovery.", topic: "retry decision", type: "decision", keywords: ["retry", "decision"], sourceSymbolIds: [linkTarget.data.results[0]!.id] });
  await app.remember({ content: "Retry decision draft without code provenance.", topic: "retry decision unlinked", type: "decision", keywords: ["retry", "decision"], sourceSymbolIds: [] });

  const searchGraph = (graph: ExtractedGraph, query: string): Array<{ id: string; name: string; relativePath: string | null }> => {
    const normalized = query.toLocaleLowerCase("en-US");
    const pathByFile = new Map(graph.files.map((file) => [file.id, file.relativePath]));
    return graph.nodes.map((node) => {
      const haystack = `${node.name} ${node.qualifiedName} ${node.signature} ${node.doc}`.toLocaleLowerCase("en-US");
      const score = node.name.toLocaleLowerCase("en-US") === normalized ? 3
        : node.qualifiedName.toLocaleLowerCase("en-US") === normalized ? 2
        : haystack.includes(normalized) ? 1 : 0;
      return { id: node.id, name: node.name, relativePath: node.fileId ? (pathByFile.get(node.fileId) ?? null) : null, score };
    }).filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
      .slice(0, fixture.k).map(({ score: _score, ...item }) => item);
  };

  const graphStrategy = (id: "B" | "C", level: "syntax" | "typed"): EvaluationStrategy => ({
    id,
    async run(task) {
      const graph = await app.code.indexer.evaluationGraph(level);
      const generation = app.database.getWorkspace().currentGeneration;
      const results = level === "syntax"
        ? searchGraph(graph, task.query)
        : (await app.searchCode({ query: task.query, limit: fixture.k }) as Envelope<{ results: Array<{ id: string; name: string; relativePath: string | null }> }>).data.results;
      const observed = observeGraph(task, graph, results.map((item) => item.id), generation);
      const payload = { results: results.map((item) => ({ id: item.id, name: item.name, path: item.relativePath })), observed };
      return {
        taskId: task.id, strategyId: id,
        orderedFiles: [...new Set(results.flatMap((item) => item.relativePath ? [item.relativePath] : []))],
        orderedSymbols: results.map((item) => item.name), orderedMemories: [],
        searchStages: level === "syntax" ? ["syntax-snapshot-retrieval", "syntax-graph"] : ["typed-db-retrieval", "syntax-graph", "ts-precision"],
        toolCalls: 1, fileReads: 0, estimatedTokens: Math.ceil(canonical(payload).length / 4),
        ...observed, memoryLeak: 0,
      };
    },
  });

  const strategies: EvaluationStrategy[] = [{
    id: "A",
    async run(task) {
      const query = task.query.toLocaleLowerCase("en-US");
      const ranked = Object.keys(fixture.files).map((relative) => {
        const text = readFileSync(path.join(root, relative), "utf8");
        const lower = text.toLocaleLowerCase("en-US");
        const matches = lower.split(query).length - 1;
        return { relative, text, score: matches * 2 + (path.basename(relative).toLocaleLowerCase("en-US").includes(query) ? 1 : 0) };
      }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.relative.localeCompare(b.relative)).slice(0, fixture.k);
      const symbols = ranked.some((item) => new RegExp(`\\b${task.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(item.text)) ? [task.query] : [];
      const payload = ranked.map(({ relative, score }) => ({ relative, score }));
      return { taskId: task.id, strategyId: "A", orderedFiles: ranked.map((item) => item.relative), orderedSymbols: symbols,
        orderedMemories: [], searchStages: ["filename-text"], toolCalls: 0, fileReads: Object.keys(fixture.files).length,
        estimatedTokens: Math.ceil(canonical(payload).length / 4), edges: { true: 0, false: 0, gold: task.goldEdges?.length ?? 0, unresolved: 0 }, staleEvidence: 0, memoryLeak: 0 };
    },
  }, graphStrategy("B", "syntax"), graphStrategy("C", "typed"), {
    id: "D",
    async run(task) {
      const base = await graphStrategy("C", "typed").run(task);
      const recalled = await app.recall({ query: task.query, limit: fixture.k }) as Envelope<{ fragments: Array<MemoryFragmentRecord & { provenance?: { codeLinks?: Array<{ codeNodeId: string | null }> } }> }>;
      const valid = recalled.data.fragments.filter((memory) => {
        const links = memory.provenance?.codeLinks ?? [];
        return links.length > 0 && links.every((link) => link.codeNodeId !== null);
      });
      const orderedMemories = valid.map((memory) => memory.topic);
      const memoryLeak = task.memoryExpected ? 0 : orderedMemories.length;
      const payload = { code: base.orderedSymbols, memories: orderedMemories };
      return { ...base, strategyId: "D", orderedMemories, searchStages: [...base.searchStages, "memory-fts", "valid-code-links"],
        toolCalls: base.toolCalls + 1, estimatedTokens: Math.ceil(canonical(payload).length / 4), memoryLeak };
    },
  }];

  const signatures: string[] = []; let orderedTraces: EvaluationTrace[] = []; const warm: number[] = [];
  for (let run = 0; run < 20; run += 1) {
    started = performance.now();
    const traces: EvaluationTrace[] = [];
    for (const task of fixture.tasks) for (const strategy of strategies) traces.push(await strategy.run(task));
    traces.sort((a, b) => `${a.taskId}:${a.strategyId}`.localeCompare(`${b.taskId}:${b.strategyId}`));
    warm.push(performance.now() - started);
    const deterministicTrace = traces.map(({ taskId, strategyId, orderedFiles, orderedSymbols, orderedMemories, searchStages, toolCalls, fileReads, estimatedTokens, edges, staleEvidence, memoryLeak }) => ({ taskId, strategyId, orderedFiles, orderedSymbols, orderedMemories, searchStages, toolCalls, fileReads, estimatedTokens, edges, staleEvidence, memoryLeak }));
    signatures.push(sha256(canonical(deterministicTrace)));
    if (run === 0) orderedTraces = traces;
  }

  const incremental: number[] = [];
  for (let sample = 0; sample < 5; sample += 1) {
    writeFileSync(path.join(root, "src", "service.py"), `${fixture.files["src/service.py"]}\n# incremental ${sample}\n`);
    started = performance.now(); await app.indexWorkspace({ mode: "incremental" }); incremental.push(performance.now() - started);
  }
  const strategyScores = (["A", "B", "C", "D"] as const).map((id) => ({ id, score: score(fixture.tasks, orderedTraces.filter((trace) => trace.strategyId === id), fixture.k) }));
  const byId = new Map(strategyScores.map((item) => [item.id, item.score]));
  const memoryDTrace = orderedTraces.find((trace) => trace.strategyId === "D" && trace.taskId === "memory");
  const thresholds = {
    determinism20Runs: signatures.length === 20 && new Set(signatures).size === 1,
    syntaxRecall: (byId.get("B")?.symbolRecallAtK ?? 0) >= 0.8,
    precisionRecall: (byId.get("C")?.edgeRecall ?? 0) >= (byId.get("B")?.edgeRecall ?? 0),
    memoryNeededD: memoryDTrace?.orderedMemories.includes("retry decision") === true,
    memoryNotNeededLeak: (byId.get("D")?.memoryLeak ?? 1) === 0,
    falseConfirmedCrossLanguage: await (async () => {
      const graph = await app.code.indexer.evaluationGraph("typed");
      const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
      return graph.edges.filter((edge) => edge.status === "resolved" && nodes.get(edge.sourceId)?.language !== nodes.get(edge.targetId)?.language).length === 0;
    })(),
    staleEvidence: strategyScores.every((item) => item.score.staleEvidence === 0),
    tokenBudget: orderedTraces.every((trace) => trace.estimatedTokens <= fixture.tokenBudget),
  };
  const testedCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const deterministic = { fixture: fixture.id, k: fixture.k, tokenBudget: fixture.tokenBudget, strategies: strategyScores, traces: orderedTraces };
  const artifact = {
    schemaVersion: 1, fixtureDigest: sha256(canonical(fixture)),
    git: { commit: testedCommit, baseline: "90b2a49666344caa5258d9ba4fe767fae1902f4f" },
    providers: { typescript: ts.version, ...PYTHON_PROVIDER_VERSIONS },
    runtime: { os: `${process.platform}-${process.arch}`, node: process.version },
    samples: { cold: cold.length, warm: warm.length, incremental: incremental.length },
    performanceMs: { cold: { p50: percentile(cold, 0.5), p95: percentile(cold, 0.95) }, warm: { p50: percentile(warm, 0.5), p95: percentile(warm, 0.95) }, incremental: { p50: percentile(incremental, 0.5), p95: percentile(incremental, 0.95) } },
    determinism: { runs: signatures.length, signatures, identical: new Set(signatures).size === 1 },
    determinismDigest: signatures[0], thresholds, ...deterministic,
  };
  mkdirSync(path.dirname(outputPath), { recursive: true }); writeFileSync(outputPath, `${canonical(artifact)}\n`);
  process.stdout.write(`${outputPath}\n${artifact.determinismDigest}\n`);
  await app.close();
  if (!Object.values(thresholds).every(Boolean)) throw new Error(`Multilanguage evaluation gate failed: ${canonical(thresholds)}`);
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}
