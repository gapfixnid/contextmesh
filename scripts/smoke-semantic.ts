import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { APPROVED_MODEL_KEY } from "../src/semantic/manifest.js";
import { createTransformersEmbeddingBackend } from "../src/semantic/transformers-backend.js";

const require = createRequire(import.meta.url);

function modelPathArgument(): string {
  const index = process.argv.indexOf("--model-path");
  const configured = index >= 0 ? process.argv[index + 1] : process.env.CONTEXTMESH_SEMANTIC_MODEL;
  if (!configured) throw new Error("Pass --model-path or set CONTEXTMESH_SEMANTIC_MODEL");
  return path.resolve(configured);
}

function installNetworkDenyGuard(): () => void {
  const restores: Array<() => void> = [];
  const deny = (): never => {
    throw new Error("NETWORK_DENIED_BY_SEMANTIC_SMOKE");
  };
  const replace = (target: Record<string, unknown>, key: string): void => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor || descriptor.configurable === false) return;
    Object.defineProperty(target, key, { ...descriptor, value: deny });
    restores.push(() => Object.defineProperty(target, key, descriptor));
  };
  const globalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  if (globalDescriptor?.configurable) {
    Object.defineProperty(globalThis, "fetch", { ...globalDescriptor, value: deny });
    restores.push(() => Object.defineProperty(globalThis, "fetch", globalDescriptor));
  }
  for (const [moduleName, keys] of [
    ["node:http", ["request", "get"]],
    ["node:https", ["request", "get"]],
    ["node:net", ["connect", "createConnection"]],
    ["node:tls", ["connect"]],
    ["node:dns", ["lookup", "resolve"]],
  ] as const) {
    const module = require(moduleName) as Record<string, unknown>;
    for (const key of keys) replace(module, key);
  }
  return () => {
    for (const restore of restores.reverse()) restore();
  };
}

const restoreNetwork = installNetworkDenyGuard();
const started = performance.now();
const backend = await createTransformersEmbeddingBackend(modelPathArgument());
let report: Record<string, unknown> | null = null;
try {
  const query = await backend.embedQuery("find code that retries a temporary upstream failure");
  const passageBatch = [
    "Retries a transient gateway operation three times with exponential delay.",
    "Formats a customer display name.",
    ...Array.from({ length: 14 }, (_, index) => `Unrelated local formatting utility ${index}.`),
  ];
  const batchStarted = performance.now();
  const passages = await backend.embedPassages(passageBatch);
  const boundedBatchInferenceMs = performance.now() - batchStarted;
  if (boundedBatchInferenceMs >= 25_000) {
    throw new Error(`A 16-passage heartbeat batch exceeded the 25 second safety gate: ${boundedBatchInferenceMs}`);
  }
  const dot = (left: Float32Array, right: Float32Array): number => {
    let value = 0;
    for (let index = 0; index < left.length; index += 1) value += (left[index] ?? 0) * (right[index] ?? 0);
    return value;
  };
  const relevantScore = passages[0] ? dot(query, passages[0]) : Number.NaN;
  const unrelatedScore = passages[1] ? dot(query, passages[1]) : Number.NaN;
  if (!Number.isFinite(relevantScore) || !Number.isFinite(unrelatedScore) || relevantScore <= unrelatedScore) {
    throw new Error(`Semantic smoke ranking failed: relevant=${relevantScore}, unrelated=${unrelatedScore}`);
  }
  backend.diagnostics.verificationMethod.push("network_denied");
  report = {
    modelKey: APPROVED_MODEL_KEY,
    dimensions: backend.dimensions,
    loadAndInferenceMs: Math.round((performance.now() - started) * 100) / 100,
    relevantScore,
    unrelatedScore,
    boundedBatchSize: passageBatch.length,
    boundedBatchInferenceMs,
    diagnostics: backend.diagnostics,
  };
} finally {
  await backend.dispose();
  restoreNetwork();
}
if (!report) throw new Error("Semantic smoke did not produce a report");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
