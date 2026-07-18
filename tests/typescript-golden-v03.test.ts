import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ContextMeshApp } from "../src/app.js";
import type { Envelope } from "../src/contracts.js";
import { sha256 } from "../src/utils.js";
import { crossesAdapterFamily } from "../src/code/languages/family.js";

describe("v0.2 TypeScript golden compatibility", () => {
  it("allows confirmed TS/JS and npm-external edges while rejecting adapter-family crossings", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-ts-js-family-"));
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ include: ["src/**/*"], compilerOptions: { allowJs: true } }));
    writeFileSync(path.join(root, "src", "legacy.js"), "export function jsEntry() { return 1; }\n");
    writeFileSync(path.join(root, "src", "consumer.ts"), [
      'import { jsEntry } from "./legacy.js";',
      'import externalValue from "external-package";',
      "export function tsUsesJs(): number { void externalValue; return jsEntry(); }",
      "",
    ].join("\n"));
    writeFileSync(path.join(root, "src", "same_name.py"), "def jsEntry():\n    return 2\n");
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const graph = await app.code.indexer.evaluationGraph("typed");
      const byId = new Map(graph.nodes.map((node) => [node.id, node]));
      const caller = graph.nodes.find((node) => node.name === "tsUsesJs")!;
      const jsTarget = graph.nodes.find((node) => node.name === "jsEntry" && node.language === "javascript")!;
      expect(graph.edges).toContainEqual(expect.objectContaining({
        sourceId: caller.id, targetId: jsTarget.id, kind: "CALLS", confidence: 1,
      }));
      expect(crossesAdapterFamily(caller, jsTarget)).toBe(false);
      expect(graph.edges.filter((edge) => {
        const source = byId.get(edge.sourceId); const target = byId.get(edge.targetId);
        return edge.status === "resolved" && source && target && crossesAdapterFamily(source, target);
      })).toHaveLength(0);
      const external = graph.nodes.find((node) => node.localKey === "external:npm:external-package")!;
      expect(crossesAdapterFamily(graph.nodes.find((node) => node.qualifiedName === "src/consumer.ts")!, external)).toBe(false);
      expect(crossesAdapterFamily(jsTarget, graph.nodes.find((node) => node.name === "jsEntry" && node.language === "python")!)).toBe(true);
    } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("reports the exact TS/JS dialect for declarations in syntax and typed views", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-ts-dialects-"));
    mkdirSync(path.join(root, "src"));
    const fixtures = [
      ["ts", "typescript"], ["tsx", "tsx"], ["js", "javascript"],
      ["jsx", "jsx"], ["mjs", "mjs"], ["cjs", "cjs"],
    ] as const;
    writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ include: ["src/**/*"], compilerOptions: { allowJs: true, jsx: "preserve" } }));
    for (const [extension] of fixtures) {
      writeFileSync(path.join(root, "src", `dialect_${extension}.${extension}`), `export function entry_${extension}() { return ${JSON.stringify(extension)}; }\n`);
    }
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const syntax = await app.code.indexer.evaluationGraph("syntax");
      const typed = await app.code.indexer.evaluationGraph("typed");
      for (const [extension, language] of fixtures) {
        const localKey = `src/dialect_${extension}.${extension}:function:entry_${extension}`;
        expect(syntax.nodes.find((node) => node.localKey === localKey)).toMatchObject({ language, analysisLevel: "syntax" });
        expect(typed.nodes.find((node) => node.localKey === localKey)).toMatchObject({ language, analysisLevel: "typed" });
        const searched = await app.searchCode({ query: `entry_${extension}`, kinds: ["function"] }) as Envelope<{
          results: Array<{ language: string; localKey: string }>;
        }>;
        expect(searched.data.results[0]).toMatchObject({ language, localKey });
        expect(searched.data.results[0]!.localKey).toBe(localKey);
      }
    } finally {
      await app.close(); rmSync(root, { recursive: true, force: true });
    }
  });

  it("performs real syntax and precision work over exactly one shared Program", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-ts-provider-"));
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }));
    writeFileSync(path.join(root, "src", "work.ts"), "export const target = () => 1; export const caller = () => target();\n");
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const instrumentation = app.code.indexer.typeScriptInstrumentation();
      expect(instrumentation.programCreations).toBe(1);
      expect(instrumentation.syntaxWorkItems).toBeGreaterThan(0);
      expect(instrumentation.precisionWorkItems).toBeGreaterThan(0);
      const syntax = await app.code.indexer.evaluationGraph("syntax");
      const typed = await app.code.indexer.evaluationGraph("typed");
      const syntaxTsNodes = syntax.nodes.filter((node) => node.language === "typescript");
      const typedTsNodes = typed.nodes.filter((node) => node.language === "typescript");
      expect(new Set(syntaxTsNodes.map((node) => node.analysisLevel))).toEqual(new Set(["syntax"]));
      expect(new Set(typedTsNodes.map((node) => node.analysisLevel))).toEqual(new Set(["typed"]));
      expect(syntax.edges.some((edge) => edge.kind === "CALLS")).toBe(false);
      expect(typed.edges.some((edge) => edge.kind === "CALLS")).toBe(true);
      expect(syntax.edges.flatMap((edge) => edge.evidence ?? []).some((item) => item.source === "type_checker")).toBe(false);
      expect(syntax.unresolvedReferences.flatMap((item) => item.evidence ?? []).some((entry) => entry.source === "type_checker")).toBe(false);
      expect(syntaxTsNodes.find((node) => node.name === "caller")?.signature)
        .not.toBe(typedTsNodes.find((node) => node.name === "caller")?.signature);
      const status = app.database.getStatus() as { lastRun: { adapterStats: Array<{ syntaxInvocations: number; precisionInvocations: number }> } };
      expect(status.lastRun.adapterStats[0]).toMatchObject({ syntaxInvocations: 1, precisionInvocations: 1 });
    } finally {
      await app.close(); rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves localKey, ID derivation, typed calls, and unresolved output", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "contextmesh-ts-golden-"));
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }));
    writeFileSync(path.join(root, "src", "gold.ts"), [
      "export function target(): number { return 1; }",
      "export function caller(callback: () => void): number { callback(); return target(); }",
      "",
    ].join("\n"));
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const result = await app.searchCode({ query: "caller" }) as Envelope<{ results: Array<{ id: string; localKey: string; analysisLevel: string }> }>;
      const caller = result.data.results[0];
      expect(caller?.localKey).toBe("src/gold.ts:function:caller");
      expect(caller?.id).toBe(sha256(`${app.database.workspace.id}\0src/gold.ts:function:caller`));
      expect(caller?.analysisLevel).toBe("typed");
      const trace = await app.traceCode({ symbolId: caller!.id, direction: "out", depth: 1 }) as Envelope<{
        edges: Array<{ confidence: number; status: string; evidence: Array<{ source: string }> }>;
        unresolved: Array<{ rawName: string }>;
      }>;
      expect(trace.data.edges).toContainEqual(expect.objectContaining({ confidence: 1, status: "resolved", evidence: [expect.objectContaining({ source: "type_checker" })] }));
      expect(trace.data.unresolved).toContainEqual(expect.objectContaining({ rawName: "callback" }));
    } finally {
      await app.close(); rmSync(root, { recursive: true, force: true });
    }
  });
});
