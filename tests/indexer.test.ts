import { readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ContextMeshApp } from "../src/app.js";
import type { Envelope } from "../src/contracts.js";
import { ContextMeshError } from "../src/errors.js";
import type { CodeSearchResult, TraceResult } from "../src/storage/database.js";
import { createFixtureWorkspace, removeFixtureWorkspace, writeWorkspaceFile } from "./helpers.js";

interface IndexData {
  generation: number;
  noOp: boolean;
  files: number;
  nodes: number;
  edges: number;
  reinterpretedFiles: number;
  changedFiles: number;
  deletedFiles: number;
}

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) removeFixtureWorkspace(workspace);
});

describe("TypeScript/JavaScript indexing", () => {
  it("indexes symbols and graph relationships, then performs a no-op incremental run", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    const app = new ContextMeshApp(root);
    try {
      const first = (await app.indexWorkspace({ mode: "full" })) as Envelope<IndexData>;
      expect(first.generation).toBe(1);
      expect(first.data.files).toBe(6);
      expect(first.data.nodes).toBeGreaterThan(10);
      expect(first.data.edges).toBeGreaterThan(10);
      expect(first.data.reinterpretedFiles).toBe(first.data.files);

      const doubleSearch = await app.searchCode({ query: "double", kinds: ["function"], limit: 10 }) as Envelope<{
        results: CodeSearchResult[];
      }>;
      expect(doubleSearch.data.results[0]?.name).toBe("double");
      expect(doubleSearch.data.results[0]?.doc).toContain("Doubles");

      const runSearch = await app.searchCode({ query: "run", kinds: ["method"], limit: 10 }) as Envelope<{
        results: CodeSearchResult[];
      }>;
      const run = runSearch.data.results.find((result) => result.qualifiedName.endsWith("Calculator.run"));
      expect(run).toBeDefined();
      const trace = await app.traceCode({
        symbolId: run?.id,
        direction: "out",
        edgeKinds: ["CALLS"],
        depth: 1,
        limit: 20,
      }) as Envelope<TraceResult>;
      expect(trace.data.nodes.some((node) => node.name === "double")).toBe(true);
      expect(trace.data.edges.some((edge) => edge.kind === "CALLS")).toBe(true);

      const invokeSearch = await app.searchCode({ query: "invoke", kinds: ["function"], limit: 10 }) as Envelope<{
        results: CodeSearchResult[];
      }>;
      const invokeId = invokeSearch.data.results[0]?.id;
      const dynamicTrace = await app.traceCode({
        symbolId: invokeId,
        direction: "out",
        edgeKinds: ["CALLS"],
        depth: 1,
      }) as Envelope<TraceResult>;
      expect(dynamicTrace.data.edges.some((edge) => edge.sourceId === edge.targetId)).toBe(false);
      expect(dynamicTrace.data.unresolved).toContainEqual(expect.objectContaining({ rawName: "callback" }));

      const secretSearch = await app.searchCode({ query: "API_SECRET", limit: 10 }) as Envelope<{
        results: CodeSearchResult[];
      }>;
      expect(secretSearch.data.results).toHaveLength(0);

      const firstPage = await app.searchCode({ query: "value", limit: 1, offset: 0 }) as Envelope<{
        results: CodeSearchResult[];
        nextOffset: number | null;
      }>;
      expect(firstPage.truncated).toBe(true);
      expect(firstPage.data.nextOffset).toBe(1);
      const secondPage = await app.searchCode({ query: "value", limit: 1, offset: 1 }) as Envelope<{
        results: CodeSearchResult[];
        nextOffset: number | null;
      }>;
      expect(secondPage.data.results[0]?.id).not.toBe(firstPage.data.results[0]?.id);

      const second = (await app.indexWorkspace({ mode: "incremental" })) as Envelope<IndexData>;
      expect(second.generation).toBe(1);
      expect(second.data.noOp).toBe(true);
      expect(second.data.nodes).toBe(first.data.nodes);
      expect(second.data.edges).toBe(first.data.edges);
    } finally {
      app.close();
    }
  });

  it("advances generation after changes and removes deleted files atomically", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      writeWorkspaceFile(
        root,
        "src/math.ts",
        `export function triple(value: number): number { return value * 3; }\n`,
      );
      rmSync(path.join(root, "legacy.cjs"));
      const changed = (await app.indexWorkspace({ mode: "incremental" })) as Envelope<IndexData>;
      expect(changed.generation).toBe(2);
      expect(changed.data.changedFiles).toBe(1);
      expect(changed.data.deletedFiles).toBe(1);
      expect(changed.data.reinterpretedFiles).toBe(changed.data.files);

      const triple = await app.searchCode({ query: "triple", kinds: ["function"] }) as Envelope<{
        results: CodeSearchResult[];
      }>;
      expect(triple.data.results[0]?.name).toBe("triple");
      const double = await app.searchCode({ query: "double", kinds: ["function"] }) as Envelope<{
        results: CodeSearchResult[];
      }>;
      expect(double.data.results).toHaveLength(0);
      const calculator = await app.searchCode({ query: "Calculator", kinds: ["class"] }) as Envelope<{
        results: CodeSearchResult[];
      }>;
      expect(calculator.data.results[0]?.name).toBe("Calculator");
      const doctor = app.doctor();
      expect((doctor.data as { integrity: string }).integrity).toBe("ok");
      expect((doctor.data as { foreignKeyViolations: number }).foreignKeyViolations).toBe(0);
      expect((doctor.data as { ftsConsistent: boolean }).ftsConsistent).toBe(true);
    } finally {
      app.close();
    }
  });

  it("keeps the active generation intact after a failed run and permits a retry", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const failedRun = app.database.startIndexRun("incremental");
      expect(failedRun.generation).toBe(2);
      app.database.failIndexRun(failedRun, ["simulated extraction failure"]);
      expect(app.database.getWorkspace().currentGeneration).toBe(1);

      writeWorkspaceFile(
        root,
        "src/math.ts",
        `export function quadruple(value: number): number { return value * 4; }\n`,
      );
      const retried = (await app.indexWorkspace({ mode: "incremental" })) as Envelope<IndexData>;
      expect(retried.generation).toBe(3);
      expect(app.database.getWorkspace().currentGeneration).toBe(3);
      const result = await app.searchCode({ query: "quadruple", kinds: ["function"] }) as Envelope<{
        results: CodeSearchResult[];
      }>;
      expect(result.data.results[0]?.name).toBe("quadruple");
    } finally {
      app.close();
    }
  });

  it.each([
    ["invalid JSON", "{ invalid json"],
    [
      "a missing extends target",
      JSON.stringify({ extends: "./missing-tsconfig.json", include: ["src/**/*", "legacy.cjs"] }),
    ],
  ])("preserves generation 1 across %s and allocates generation 3 to the repair", async (_label, invalidConfig) => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    const originalConfig = readFileSync(path.join(root, "tsconfig.json"), "utf8");
    const app = new ContextMeshApp(root);
    try {
      const initial = (await app.indexWorkspace({ mode: "full" })) as Envelope<IndexData>;
      expect(initial.generation).toBe(1);

      writeWorkspaceFile(root, "tsconfig.json", invalidConfig);
      let failure: unknown;
      try {
        await app.indexWorkspace({ mode: "incremental" });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ContextMeshError);
      expect((failure as ContextMeshError).code).toBe("PARSE_PARTIAL");
      expect(app.database.getWorkspace().currentGeneration).toBe(1);

      const failedStatus = await app.workspaceStatus() as Envelope<{
        stale: boolean;
        lastRun: { generation: number; status: string; diagnostics: string[] };
      }>;
      expect(failedStatus.data.stale).toBe(true);
      expect(failedStatus.data.lastRun).toMatchObject({ generation: 2, status: "failed" });
      expect(failedStatus.data.lastRun.diagnostics.length).toBeGreaterThan(0);
      expect(app.database.getFreshnessState()).toMatchObject({
        currentGeneration: 1,
        successFenceGeneration: 1,
        failureFenceGeneration: 2,
        stale: true,
      });
      const preserved = await app.searchCode({ query: "double", kinds: ["function"] }) as Envelope<{
        results: CodeSearchResult[];
      }>;
      expect(preserved.generation).toBe(1);
      expect(preserved.data.results[0]?.name).toBe("double");
      expect(preserved.warnings).toContainEqual(expect.stringContaining("INDEX_STALE"));

      writeWorkspaceFile(root, "tsconfig.json", originalConfig);
      const repaired = (await app.indexWorkspace({ mode: "incremental" })) as Envelope<IndexData>;
      expect(repaired.generation).toBe(1);
      expect(repaired.data.noOp).toBe(true);
      expect(app.database.getWorkspace().currentGeneration).toBe(1);
      const repairedStatus = await app.workspaceStatus() as Envelope<{
        stale: boolean;
        lastRun: { generation: number; status: string };
      }>;
      expect(repairedStatus.data.stale).toBe(false);
      expect(repairedStatus.data.lastRun).toMatchObject({ generation: 3, status: "succeeded" });
    } finally {
      app.close();
    }
  });

  it.each([
    ["files: []", { files: [] }],
    ["an entirely excluded include", { include: ["src/**/*.ts"], exclude: ["src/**/*"] }],
  ])("commits %s as a successful empty configured generation", async (_label, emptySelection) => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      writeWorkspaceFile(
        root,
        "tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
          },
          ...emptySelection,
        }),
      );

      const empty = (await app.indexWorkspace({ mode: "incremental" })) as Envelope<IndexData>;
      expect(empty.generation).toBe(2);
      expect(empty.data.files).toBe(0);
      expect(empty.warnings.length).toBeGreaterThan(0);
      const status = await app.workspaceStatus() as Envelope<{
        stale: boolean;
        lastRun: { generation: number; status: string; diagnostics: string[] };
      }>;
      expect(status.data.stale).toBe(false);
      expect(status.data.lastRun).toMatchObject({ generation: 2, status: "succeeded" });
      expect(status.data.lastRun.diagnostics.length).toBeGreaterThan(0);
      const removed = await app.searchCode({ query: "double", kinds: ["function"] }) as Envelope<{
        results: CodeSearchResult[];
      }>;
      expect(removed.data.results).toHaveLength(0);
      expect(removed.warnings).not.toContainEqual(expect.stringContaining("INDEX_STALE"));
    } finally {
      app.close();
    }
  });

  it("treats effective project configuration changes as stale", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      writeWorkspaceFile(
        root,
        "tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            allowJs: true,
            strict: true,
            noEmit: true,
            noUnusedLocals: true,
          },
          include: ["src/**/*", "legacy.cjs"],
        }),
      );
      const status = await app.workspaceStatus() as Envelope<{ stale: boolean }>;
      expect(status.data.stale).toBe(true);
      const refreshed = (await app.indexWorkspace({ mode: "incremental" })) as Envelope<IndexData>;
      expect(refreshed.generation).toBe(2);
      expect(refreshed.data.noOp).toBe(false);
      expect(refreshed.data.changedFiles).toBe(0);
    } finally {
      app.close();
    }
  });

  it("commits recoverable syntax errors as a partial generation with diagnostics", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    writeWorkspaceFile(root, "src/broken.ts", "export function recovered( { return 1; }\n");
    const app = new ContextMeshApp(root);
    try {
      const result = (await app.indexWorkspace({ mode: "full" })) as Envelope<IndexData>;
      expect(result.generation).toBe(1);
      expect(result.warnings.length).toBeGreaterThan(0);
      const status = await app.workspaceStatus() as Envelope<{
        lastRun: { status: string; diagnostics: string[] };
      }>;
      expect(status.data.lastRun.status).toBe("partial");
      expect(status.data.lastRun.diagnostics.length).toBeGreaterThan(0);
    } finally {
      app.close();
    }
  });

  it("resolves tsconfig path aliases through re-exports", async () => {
    const root = createFixtureWorkspace();
    workspaces.push(root);
    writeWorkspaceFile(
      root,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          allowJs: true,
          strict: true,
          noEmit: true,
          baseUrl: ".",
          paths: { "@core/*": ["src/*"] },
        },
        include: ["src/**/*", "legacy.cjs"],
      }),
    );
    writeWorkspaceFile(
      root,
      "src/barrel.ts",
      `export { double, type NumericOperation } from "@core/math.js";\n`,
    );
    writeWorkspaceFile(
      root,
      "src/service.ts",
      `import { double, type NumericOperation } from "@core/barrel.js";

export class Calculator implements NumericOperation {
  run(value: number): number {
    return double(value);
  }
}
`,
    );
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const runSearch = await app.searchCode({ query: "run", kinds: ["method"], limit: 10 }) as Envelope<{
        results: CodeSearchResult[];
      }>;
      const run = runSearch.data.results.find((result) => result.qualifiedName.endsWith("Calculator.run"));
      const trace = await app.traceCode({
        symbolId: run?.id,
        direction: "out",
        edgeKinds: ["CALLS"],
        depth: 1,
      }) as Envelope<TraceResult>;
      expect(trace.data.nodes.some((node) => node.name === "double")).toBe(true);
    } finally {
      app.close();
    }
  });
});
