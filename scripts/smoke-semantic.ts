import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { ContextMeshApp } from "../src/app.js";
import type { Envelope } from "../src/contracts.js";
import { APPROVED_MODEL_KEY } from "../src/semantic/manifest.js";
import { createTransformersEmbeddingBackend } from "../src/semantic/transformers-backend.js";
import { installNetworkDenyGuard } from "./network-deny.js";

function modelPathArgument(): string {
  const index = process.argv.indexOf("--model-path");
  const configured = index >= 0 ? process.argv[index + 1] : process.env.CONTEXTMESH_SEMANTIC_MODEL;
  if (!configured) throw new Error("Pass --model-path or set CONTEXTMESH_SEMANTIC_MODEL");
  return path.resolve(configured);
}

function dot(left: Float32Array, right: Float32Array): number {
  let value = 0;
  for (let index = 0; index < left.length; index += 1) value += (left[index] ?? 0) * (right[index] ?? 0);
  return value;
}

const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-semantic-smoke-"));
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
const longDocumentation = Array.from(
  { length: 512 },
  (_, index) => `token${index} retry transient gateway recovery`,
).join(" ");
writeFileSync(
  path.join(sourceDirectory, "smoke.ts"),
  Array.from({ length: 16 }, (_, index) =>
    `/** ${longDocumentation} */\nexport function retryGateway${index}(value: number): number { return value + ${index}; }\n`,
  ).join("\n"),
  "utf8",
);

const restoreNetwork = installNetworkDenyGuard("NETWORK_DENIED_BY_SEMANTIC_SMOKE");
const started = performance.now();
const backendStarted = performance.now();
const backend = await createTransformersEmbeddingBackend(modelPathArgument());
const backendInitializationMs = performance.now() - backendStarted;
let heartbeatAt = performance.now();
let maximumEventLoopDelayMs = 0;
const heartbeat = setInterval(() => {
  const now = performance.now();
  maximumEventLoopDelayMs = Math.max(maximumEventLoopDelayMs, now - heartbeatAt - 50);
  heartbeatAt = now;
}, 50);
heartbeat.unref();

const app = new ContextMeshApp(root, ":memory:", {
  semantic: { modelPath: modelPathArgument(), backendFactory: async () => backend },
});
let report: Record<string, unknown> | null = null;
try {
  const indexed = await app.indexWorkspace({ mode: "full" });

  const worstCasePassage = Array.from({ length: 512 }, (_, index) => `worst${index}`).join(" ");
  const worstCaseBatch = Array.from({ length: 16 }, (_, index) => `${worstCasePassage} batch${index}`);
  const batchStarted = performance.now();
  const passages = await backend.embedPassages(worstCaseBatch);
  const boundedBatchInferenceMs = performance.now() - batchStarted;
  if (boundedBatchInferenceMs >= 10_000) {
    throw new Error(`A 16x512-token passage batch exceeded the 10 second gate: ${boundedBatchInferenceMs}`);
  }

  const query = await backend.embedQuery("find code that retries a temporary upstream failure");
  const comparison = await backend.embedPassages([
    "Retries a transient gateway operation three times with exponential delay.",
    "Formats a customer display name.",
  ]);
  const relevantScore = comparison[0] ? dot(query, comparison[0]) : Number.NaN;
  const unrelatedScore = comparison[1] ? dot(query, comparison[1]) : Number.NaN;
  if (!Number.isFinite(relevantScore) || !Number.isFinite(unrelatedScore) || relevantScore <= unrelatedScore) {
    throw new Error(`Semantic smoke ranking failed: relevant=${relevantScore}, unrelated=${unrelatedScore}`);
  }

  const search = await app.searchCode({ query: "temporary gateway retry", limit: 5 }) as Envelope<{
    results: Array<{ id: string }>;
  }>;
  const symbol = search.data.results[0];
  if (!symbol) throw new Error("Application smoke search returned no code symbol");
  await app.traceCode({ symbolId: symbol.id, direction: "both", depth: 1, limit: 20 });
  await app.remember({
    content: "Transient gateway operations use bounded retries.",
    topic: "gateway resilience",
    type: "decision",
    keywords: ["gateway", "retry"],
    sourceSymbolIds: [symbol.id],
  });
  await app.reflect({
    sessionId: "semantic-smoke",
    summary: "Verified the offline semantic application lifecycle.",
    learnings: [{
      content: "Gateway recovery remains local and offline.",
      topic: "offline recovery",
      type: "fact",
      keywords: ["offline", "gateway"],
      importance: 3,
      anchor: false,
      assertionStatus: "verified",
      sourceSymbolIds: [symbol.id],
    }],
  });
  const recalled = await app.recall({ query: "gateway recovery", tokenBudget: 2_000, limit: 10 }) as Envelope<{
    fragments: unknown[];
  }>;
  const context = await app.getContext({
    query: "how does gateway recovery work",
    symbolId: symbol.id,
    include: ["code", "memory"],
    tokenBudget: 4_000,
  }) as Envelope<{ code: unknown[]; memories: unknown[] }>;
  const status = await app.workspaceStatus() as Envelope<{
    semantic: { code: { status: string }; memory: { status: string } };
  }>;
  if (recalled.data.fragments.length === 0 || context.data.code.length === 0 || context.data.memories.length === 0) {
    throw new Error("Application smoke did not preserve code and memory results through the full lifecycle");
  }
  if (status.data.semantic.code.status !== "ready" || status.data.semantic.memory.status !== "ready") {
    throw new Error(
      `Application smoke semantic planes were not ready: code=${status.data.semantic.code.status}, ` +
      `memory=${status.data.semantic.memory.status}`,
    );
  }
  const semanticWarnings = [...search.warnings, ...recalled.warnings, ...context.warnings]
    .filter((warning) => warning.startsWith("SEMANTIC_"));
  if (semanticWarnings.length > 0) {
    throw new Error(`Application smoke emitted semantic warnings: ${semanticWarnings.join(", ")}`);
  }

  backend.diagnostics.verificationMethod.push("network_denied", "application_lifecycle");
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (maximumEventLoopDelayMs >= 5_000) {
    throw new Error(`Semantic runtime event-loop delay exceeded 5 seconds: ${maximumEventLoopDelayMs}`);
  }
  report = {
    modelKey: APPROVED_MODEL_KEY,
    dimensions: backend.dimensions,
    backendInitializationMs: Math.round(backendInitializationMs * 100) / 100,
    loadAndApplicationLifecycleMs: Math.round((performance.now() - started) * 100) / 100,
    relevantScore,
    unrelatedScore,
    boundedBatchSize: passages.length,
    boundedBatchTokensPerPassage: 512,
    boundedBatchInferenceMs: Math.round(boundedBatchInferenceMs * 100) / 100,
    maximumRuntimeEventLoopDelayMs: Math.round(maximumEventLoopDelayMs * 100) / 100,
    application: {
      generation: indexed.generation,
      searchResults: search.data.results.length,
      recalledMemories: recalled.data.fragments.length,
      contextCode: context.data.code.length,
      contextMemories: context.data.memories.length,
      codeStatus: status.data.semantic.code.status,
      memoryStatus: status.data.semantic.memory.status,
    },
    diagnostics: backend.diagnostics,
  };
} finally {
  clearInterval(heartbeat);
  await app.close();
  restoreNetwork();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}
if (!report) throw new Error("Semantic smoke did not produce a report");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
