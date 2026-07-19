import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ContextMeshApp } from "../src/app.js";
import type { Envelope } from "../src/contracts.js";

function outputPath(): string | null {
  const index = process.argv.indexOf("--output");
  return index >= 0 && process.argv[index + 1] ? path.resolve(process.argv[index + 1]!) : null;
}

function write(root: string, relative: string, content: string): void {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
}

const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-v05-quality-"));
const app = new ContextMeshApp(root);
try {
  write(root, "tsconfig.json", JSON.stringify({ include: ["src/**/*.ts"] }));
  write(root, "src/typescript.ts", "export function tsTarget(){ return 1 }\nexport function tsCaller(){ return tsTarget() }\n");
  write(root, "pyproject.toml", "[tool.setuptools.packages.find]\nwhere=['python']\n");
  write(root, "python/pkg/target.py", "def py_target():\n    return 1\n");
  write(root, "python/pkg/caller.py", "from pkg.target import py_target as selected\n\ndef py_caller():\n    return selected()\n");
  write(root, "go.mod", "module example.local/quality\n\ngo 1.23\n");
  write(root, "go/worker.go", "package worker\nfunc GoTarget() int { return 1 }\nfunc GoCaller() int { return GoTarget() }\n");

  const indexed = await app.indexWorkspace({ mode: "full" });
  const cases = [
    { language: "typescript", caller: "tsCaller", target: "tsTarget" },
    { language: "python", caller: "py_caller", target: "py_target" },
    { language: "go", caller: "GoCaller", target: "GoTarget" },
  ] as const;
  const languageResults: Array<{ language: string; predicted: number; truePositive: number; precision: number; recall: number }> = [];
  for (const item of cases) {
    const caller = await app.searchCode({ query: item.caller }) as Envelope<{ results: Array<{ id: string; language: string }> }>;
    const target = await app.searchCode({ query: item.target }) as Envelope<{ results: Array<{ id: string; language: string }> }>;
    const callerNode = caller.data.results.find((node) => node.language === item.language);
    const targetNode = target.data.results.find((node) => node.language === item.language);
    if (!callerNode || !targetNode) throw new Error(`v0.5 quality fixture did not index ${item.language}`);
    const trace = await app.traceCode({ symbolId: callerNode.id, direction: "out", edgeKinds: ["CALLS"], depth: 1, limit: 50 }) as Envelope<{ edges: Array<{ targetId: string; status: string }> }>;
    const resolved = trace.data.edges.filter((edge) => edge.status === "resolved");
    const truePositive = resolved.filter((edge) => edge.targetId === targetNode.id).length;
    const precision = resolved.length === 0 ? 0 : truePositive / resolved.length;
    const recall = truePositive > 0 ? 1 : 0;
    languageResults.push({ language: item.language, predicted: resolved.length, truePositive, precision, recall });
  }
  const syntax = await app.code.indexer.evaluationGraph("syntax");
  const baseLanguages = [...new Set(syntax.nodes.map((node) => node.language).filter(Boolean))].sort();
  const generationBeforeProviderUpdate = app.database.getWorkspace().currentGeneration;
  const claim = app.database.claimPrecisionProvider({ provider: "quality_update_probe", providerVersion: "2", language: "python", capability: "resolved", owner: "quality-gate" });
  if (!claim.claim || !app.database.commitPrecisionOverlay(claim.claim, { edges: [], eligibleEdges: 0, diagnostics: [] })) {
    throw new Error("v0.5 provider revision probe could not commit");
  }
  const generationAfterProviderUpdate = app.database.getWorkspace().currentGeneration;
  const providerStates = app.database.getPrecisionProviderStates();
  const checks = {
    tier1Quality: languageResults.every((item) => item.precision >= 0.9 && item.recall >= 0.9),
    baseGraphWithoutPrecision: (["typescript", "python", "go"] as const).every((language) => baseLanguages.includes(language)),
    providerUpdatePreservesGeneration: generationBeforeProviderUpdate === generationAfterProviderUpdate,
    providerStatesHealthy: ["typescript_type_checker", "contextmesh_python_resolver", "go_types"].every((provider) =>
      providerStates.some((state) => state.provider === provider && (state.status === "ready" || state.status === "partial"))),
  };
  const artifact = {
    schemaVersion: 1,
    release: "v0.5",
    generation: indexed.generation,
    precisionRevision: app.database.getPrecisionRevision(),
    languageResults,
    baseLanguages,
    providerStates,
    checks,
    passed: Object.values(checks).every(Boolean),
  };
  const target = outputPath();
  if (target) { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, `${JSON.stringify(artifact, null, 2)}\n`, "utf8"); }
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  if (!artifact.passed) throw new Error(`v0.5 quality gate failed: ${Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name).join(", ")}`);
} finally {
  await app.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
