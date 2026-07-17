import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextMeshApp } from "../src/app.js";
import type { Envelope, MemoryFragmentRecord } from "../src/contracts.js";
import { ContextMeshError } from "../src/errors.js";
import type { CodeSearchResult, MemoryCodeProvenance, TraceResult } from "../src/storage/database.js";
import { detectPathCaseSensitivity, estimateTokens } from "../src/utils.js";
import { createFixtureWorkspace, removeFixtureWorkspace, writeWorkspaceFile } from "./helpers.js";

interface IndexData {
  generation: number;
  noOp: boolean;
  files: number;
}

interface MemoryView extends MemoryFragmentRecord {
  untrusted: true;
  provenance: {
    sessionId: string | null;
    codeLinks: MemoryCodeProvenance[];
    codeLinksOmitted: number;
  };
}

const cleanupPaths: string[] = [];

function temporaryWorkspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), "contextmesh-hardening-"));
  cleanupPaths.push(root);
  return root;
}

function writeSimpleSources(root: string): void {
  writeWorkspaceFile(root, "src/a.ts", "export const a = 1;\n");
  writeWorkspaceFile(root, "src/b.ts", "export const b = 2;\n");
  writeWorkspaceFile(root, "src/c.ts", "export const c = 3;\n");
  writeWorkspaceFile(root, "src/excluded.ts", "export const excluded = true;\n");
}

function expectBudget(envelope: Envelope<unknown>, tokenBudget: number): void {
  expect(estimateTokens(envelope)).toBeLessThanOrEqual(envelope.estimatedTokens);
  expect(envelope.estimatedTokens).toBeLessThanOrEqual(tokenBudget);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const target of cleanupPaths.splice(0)) removeFixtureWorkspace(target);
});

describe("token envelope and memory selection hardening", () => {
  it("packs final envelopes after provenance and truncates queries and code links within budget", async () => {
    const root = createFixtureWorkspace();
    cleanupPaths.push(root);
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const sourceSymbolIds = app.database
        .searchCode("", undefined, 20)
        .filter((node) => node.fileId !== null)
        .map((node) => node.id)
        .slice(0, 20);
      const remembered = await app.remember({
        content: "Token hardening memory with many provenance links.",
        topic: "token-hardening",
        type: "fact",
        keywords: ["token-hardening"],
        importance: 5,
        sourceSymbolIds,
      }) as Envelope<{ fragment: MemoryFragmentRecord }>;

      const linkedRecall = await app.recall({
        query: "Token hardening memory",
        tokenBudget: 900,
      }) as Envelope<{ query: string; fragments: MemoryView[]; nextOffset: number | null }>;
      expectBudget(linkedRecall, 900);
      const linkedMemory = linkedRecall.data.fragments.find((memory) => memory.id === remembered.data.fragment.id);
      expect(linkedMemory).toBeDefined();
      expect(linkedMemory?.untrusted).toBe(true);
      expect(
        (linkedMemory?.provenance.codeLinks.length ?? 0) + (linkedMemory?.provenance.codeLinksOmitted ?? 0),
      ).toBe(sourceSymbolIds.length);
      expect(linkedMemory?.provenance.codeLinksOmitted).toBeGreaterThan(0);

      const longQuery = "long-query ".repeat(90).trim().slice(0, 1000);
      const minimumRecall = await app.recall({ query: longQuery, tokenBudget: 128 }) as Envelope<{
        query: string;
        fragments: MemoryView[];
      }>;
      expectBudget(minimumRecall, 128);
      expect(minimumRecall.truncated).toBe(true);
      expect(minimumRecall.data.query.length).toBeLessThan(longQuery.length);
      expect(minimumRecall.warnings).toContainEqual(expect.stringContaining("QUERY_TRUNCATED"));

      const minimumContext = await app.getContext({
        query: longQuery,
        tokenBudget: 256,
        include: ["code", "memory"],
      }) as Envelope<{ query: string }>;
      expectBudget(minimumContext, 256);
      expect(minimumContext.truncated).toBe(true);
      expect(minimumContext.data.query.length).toBeLessThan(longQuery.length);
      expect(minimumContext.warnings).toContainEqual(expect.stringContaining("QUERY_TRUNCATED"));

      const compact = await app.remember({
        content: "q",
        topic: "q",
        type: "fact",
        keywords: [],
        importance: 1,
        anchor: true,
        sourceSymbolIds: [],
      }) as Envelope<{ fragment: MemoryFragmentRecord }>;
      const relatedLongQuery = `q${"-".repeat(999)}`;
      const compactRecall = await app.recall({
        query: relatedLongQuery,
        includeAnchors: true,
        tokenBudget: 256,
      }) as Envelope<{ query: string; fragments: MemoryView[] }>;
      expectBudget(compactRecall, 256);
      expect(compactRecall.data.fragments.map((memory) => memory.id)).toContain(compact.data.fragment.id);
      expect(compactRecall.data.query.length).toBeLessThan(relatedLongQuery.length);
      expect(compactRecall.warnings).toContain("QUERY_TRUNCATED");

      const compactContext = await app.getContext({
        query: relatedLongQuery,
        tokenBudget: 256,
        include: ["memory"],
      }) as Envelope<{ query: string; memories: MemoryView[] }>;
      expectBudget(compactContext, 256);
      expect(compactContext.data.memories.map((memory) => memory.id)).toContain(compact.data.fragment.id);
      expect(compactContext.data.query.length).toBeLessThan(relatedLongQuery.length);
      expect(compactContext.warnings).toContain("QUERY_TRUNCATED");

      await expect(app.recall({ query: "invalid budget", tokenBudget: 127 })).rejects.toThrow(ContextMeshError);
      await expect(app.getContext({ query: "invalid budget", tokenBudget: 255 })).rejects.toThrow(
        ContextMeshError,
      );
    } finally {
      app.close();
    }
  });

  it("does not return predicted access metadata when the access transaction fails", async () => {
    const root = createFixtureWorkspace();
    cleanupPaths.push(root);
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const remembered = await app.remember({
        content: "Access transaction failure regression memory.",
        topic: "access-transaction",
        type: "fact",
        keywords: ["access-transaction"],
        importance: 3,
        sourceSymbolIds: [],
      }) as Envelope<{ fragment: MemoryFragmentRecord }>;

      vi.spyOn(app.database, "recordMemoryAccess").mockImplementation(() => {
        throw new Error("SQLITE_BUSY simulated access failure");
      });
      let recallError: unknown;
      try {
        await app.recall({ query: "Access transaction failure", tokenBudget: 1000 });
      } catch (error) {
        recallError = error;
      }
      expect(recallError).toBeInstanceOf(ContextMeshError);
      expect((recallError as ContextMeshError).code).toBe("DB_BUSY");

      let contextError: unknown;
      try {
        await app.getContext({ query: "Access transaction failure", include: ["memory"], tokenBudget: 1000 });
      } catch (error) {
        contextError = error;
      }
      expect(contextError).toBeInstanceOf(ContextMeshError);
      expect((contextError as ContextMeshError).code).toBe("DB_BUSY");

      vi.restoreAllMocks();
      const raw = app.database.recall({
        query: "Access transaction failure",
        tokenBudget: 1000,
        includeAnchors: false,
        limit: 20,
        offset: 0,
      });
      expect(raw.fragments.find((fragment) => fragment.id === remembered.data.fragment.id)?.accessCount).toBe(0);
    } finally {
      app.close();
    }
  });

  it("keeps an unrelated anchor ahead of pagination when more than the limit match FTS", async () => {
    const root = temporaryWorkspace();
    const app = new ContextMeshApp(root);
    try {
      for (let index = 0; index < 60; index += 1) {
        await app.remember({
          content: `Ordinary searchable memory ${index}`,
          topic: "anchor-pagination",
          type: "fact",
          keywords: ["ordinary-searchable"],
          importance: 3,
          sourceSymbolIds: [],
        });
      }
      const anchor = await app.remember({
        content: "Guaranteed unrelated anchor.",
        topic: "anchor-pagination",
        type: "decision",
        keywords: ["unrelated-anchor"],
        importance: 5,
        anchor: true,
        sourceSymbolIds: [],
      }) as Envelope<{ fragment: MemoryFragmentRecord }>;

      const recalled = await app.recall({
        query: "Ordinary searchable memory",
        includeAnchors: true,
        limit: 20,
        tokenBudget: 8000,
      }) as Envelope<{ fragments: MemoryView[]; nextOffset: number | null }>;
      expect(recalled.data.fragments.some((memory) => memory.id === anchor.data.fragment.id)).toBe(true);
      expect(recalled.data.nextOffset).toBe(20);
      expect(recalled.data.fragments.filter((memory) => !memory.isAnchor)).toHaveLength(20);
      expectBudget(recalled, 8000);

      const withoutAnchors = await app.recall({
        query: "Guaranteed unrelated anchor",
        includeAnchors: false,
        tokenBudget: 1000,
      }) as Envelope<{ fragments: MemoryView[] }>;
      expect(withoutAnchors.data.fragments.some((memory) => memory.id === anchor.data.fragment.id)).toBe(false);
    } finally {
      app.close();
    }
  });

  it("advances recall offsets by only the contiguous general-memory prefix", async () => {
    const root = temporaryWorkspace();
    const app = new ContextMeshApp(root);
    try {
      const expectedIds = new Set<string>();
      for (let index = 0; index < 10; index += 1) {
        const remembered = await app.remember({
          content: `page-sequence ${index}`,
          topic: "page-sequence",
          type: "fact",
          keywords: ["page-sequence"],
          importance: 3,
          sourceSymbolIds: [],
        }) as Envelope<{ fragment: MemoryFragmentRecord }>;
        expectedIds.add(remembered.data.fragment.id);
      }
      const anchor = await app.remember({
        content: "a",
        topic: "a",
        type: "decision",
        keywords: [],
        importance: 5,
        anchor: true,
        sourceSymbolIds: [],
      }) as Envelope<{ fragment: MemoryFragmentRecord }>;

      const returnedIds: string[] = [];
      let offset = 0;
      for (let page = 0; page < 20; page += 1) {
        const recalled = await app.recall({
          query: "page-sequence",
          includeAnchors: true,
          limit: 20,
          offset,
          tokenBudget: 700,
        }) as Envelope<{ fragments: MemoryView[]; nextOffset: number | null }>;
        expectBudget(recalled, 700);
        expect(recalled.data.fragments.some((memory) => memory.id === anchor.data.fragment.id)).toBe(true);
        const general = recalled.data.fragments.filter((memory) => !memory.isAnchor);
        expect(general.length).toBeGreaterThan(0);
        returnedIds.push(...general.map((memory) => memory.id));
        if (recalled.data.nextOffset === null) break;
        expect(recalled.data.nextOffset).toBe(offset + general.length);
        offset = recalled.data.nextOffset;
      }

      expect(returnedIds).toHaveLength(expectedIds.size);
      expect(new Set(returnedIds).size).toBe(returnedIds.length);
      expect(new Set(returnedIds)).toEqual(expectedIds);
    } finally {
      app.close();
    }
  });

  it("returns PAGINATION_STALLED without skipping an oversized first general memory", async () => {
    const root = temporaryWorkspace();
    const app = new ContextMeshApp(root);
    try {
      await app.remember({
        content: `oversized-stall ${"x".repeat(3980)}`,
        topic: "oversized-stall",
        type: "fact",
        keywords: ["oversized-stall"],
        importance: 3,
        sourceSymbolIds: [],
      });
      const recalled = await app.recall({
        query: "oversized-stall",
        limit: 20,
        offset: 0,
        tokenBudget: 128,
      }) as Envelope<{ fragments: MemoryView[]; nextOffset: number | null }>;
      expectBudget(recalled, 128);
      expect(recalled.data.fragments).toHaveLength(0);
      expect(recalled.data.nextOffset).toBe(0);
      expect(recalled.warnings).toContain("PAGINATION_STALLED");
      expect(recalled.truncated).toBe(true);
    } finally {
      app.close();
    }
  });
});

describe("project scope, freshness, and persistent stale state", () => {
  it.each([
    ["files", { files: ["src/a.ts"] }, 1],
    ["include", { include: ["src/a.ts", "src/b.ts"] }, 2],
    ["exclude", { include: ["src/**/*.ts"], exclude: ["src/excluded.ts"] }, 3],
  ])("uses tsconfig %s as the project file scope", async (_label, selection, expectedFiles) => {
    const root = temporaryWorkspace();
    writeSimpleSources(root);
    writeWorkspaceFile(
      root,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", noEmit: true },
        ...selection,
      }),
    );
    const app = new ContextMeshApp(root);
    try {
      const indexed = (await app.indexWorkspace({ mode: "full" })) as Envelope<IndexData>;
      expect(indexed.data.files).toBe(expectedFiles);
    } finally {
      app.close();
    }
  });

  it("uses every supported scanner file only for a synthetic project", async () => {
    const root = temporaryWorkspace();
    writeSimpleSources(root);
    const app = new ContextMeshApp(root);
    try {
      const indexed = (await app.indexWorkspace({ mode: "full" })) as Envelope<IndexData>;
      expect(indexed.data.files).toBe(4);
    } finally {
      app.close();
    }
  });

  it("hashes effective compiler options and the resolved extends chain", async () => {
    const root = temporaryWorkspace();
    writeSimpleSources(root);
    writeWorkspaceFile(
      root,
      "base.json",
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          baseUrl: ".",
          paths: { "@scope/*": ["src/*"] },
        },
      }),
    );
    writeWorkspaceFile(root, "tsconfig.json", JSON.stringify({ extends: "./base.json", include: ["src/**/*.ts"] }));
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      writeWorkspaceFile(
        root,
        "base.json",
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            baseUrl: ".",
            paths: { "@scope/*": ["src/a.ts"] },
          },
        }),
      );
      const status = await app.workspaceStatus() as Envelope<{ stale: boolean }>;
      expect(status.data.stale).toBe(true);
    } finally {
      app.close();
    }
  });

  it("detects same-size content changes with restored mtime in strict mode", async () => {
    const root = temporaryWorkspace();
    const filePath = path.join(root, "src/value.ts");
    writeWorkspaceFile(root, "tsconfig.json", JSON.stringify({ files: ["src/value.ts"] }));
    writeWorkspaceFile(root, "src/value.ts", "export const alpha = 1;\n");
    const app = new ContextMeshApp(root, undefined, { freshnessMode: "strict" });
    try {
      await app.indexWorkspace({ mode: "full" });
      const originalStatus = statSync(filePath);
      writeWorkspaceFile(root, "src/value.ts", "export const omega = 2;\n");
      utimesSync(filePath, originalStatus.atime, originalStatus.mtime);

      const search = await app.searchCode({ query: "alpha" }) as Envelope<{ results: CodeSearchResult[] }>;
      expect(search.warnings).toContainEqual(expect.stringContaining("INDEX_STALE"));
      const context = await app.getContext({ query: "alpha", tokenBudget: 256 }) as Envelope<unknown>;
      expect(context.warnings).toContainEqual(expect.stringContaining("INDEX_STALE"));
      expectBudget(context, 256);
    } finally {
      app.close();
    }
  });

  it("persists a failed automatic index and warns on every graph response after restart", async () => {
    const root = createFixtureWorkspace();
    cleanupPaths.push(root);
    const mathPath = path.join(root, "src/math.ts");
    const originalMath = readFileSync(mathPath, "utf8");
    let app: ContextMeshApp | null = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const before = await app.searchCode({ query: "double", kinds: ["function"] }) as Envelope<{
        results: CodeSearchResult[];
      }>;
      const symbolId = before.data.results[0]?.id;
      expect(symbolId).toBeTruthy();

      writeWorkspaceFile(root, "src/math.ts", "export function failedChange(value: number) { return value; }\n");
      vi.spyOn(app.database, "commitGraph").mockImplementation(() => {
        throw new Error("simulated automatic index commit failure");
      });
      await app.initialize(true);
      vi.restoreAllMocks();
      writeWorkspaceFile(root, "src/math.ts", originalMath);
      app.close();
      app = new ContextMeshApp(root);

      const search = await app.searchCode({ query: "double", kinds: ["function"] }) as Envelope<{
        results: CodeSearchResult[];
      }>;
      const trace = await app.traceCode({ symbolId, depth: 1 }) as Envelope<TraceResult>;
      const context = await app.getContext({ query: "double", tokenBudget: 2000 }) as Envelope<unknown>;
      for (const response of [search, trace, context]) {
        expect(response.generation).toBe(1);
        expect(response.warnings).toContainEqual(expect.stringContaining("INDEX_STALE"));
      }

      const retry = (await app.indexWorkspace({ mode: "incremental" })) as Envelope<IndexData>;
      expect(retry.generation).toBe(1);
      expect(retry.data.noOp).toBe(true);
      const refreshed = await app.searchCode({ query: "double", kinds: ["function"] });
      expect(refreshed.warnings.some((warning) => warning.includes("INDEX_STALE"))).toBe(false);
    } finally {
      app?.close();
    }
  });
});

describe("filesystem boundary and case policy hardening", () => {
  it("rejects a source file replaced by an external symlink", async () => {
    const root = createFixtureWorkspace();
    const external = temporaryWorkspace();
    cleanupPaths.push(root);
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const node = app.database.searchCode("double", ["function"], 1)[0];
      expect(node).toBeDefined();
      const sourcePath = path.join(root, "src/math.ts");
      const externalPath = path.join(external, "math.ts");
      writeWorkspaceFile(external, "math.ts", readFileSync(sourcePath, "utf8"));
      rmSync(sourcePath);
      try {
        symlinkSync(externalPath, sourcePath, "file");
      } catch (error) {
        if (
          process.platform === "win32" &&
          error instanceof Error &&
          "code" in error &&
          (error.code === "EPERM" || error.code === "EACCES")
        ) {
          return;
        }
        throw error;
      }

      const snippet = await app.code.indexer.readSnippet(node as CodeSearchResult);
      expect(snippet.snippet).toBeNull();
      expect(snippet.warning).toContain("symbolic link");
    } finally {
      app.close();
    }
  });

  it("rejects a regular source reached through an external parent junction", async () => {
    const root = createFixtureWorkspace();
    const external = temporaryWorkspace();
    cleanupPaths.push(root);
    const app = new ContextMeshApp(root);
    try {
      await app.indexWorkspace({ mode: "full" });
      const node = app.database.searchCode("double", ["function"], 1)[0];
      expect(node).toBeDefined();
      const sourceDirectory = path.join(root, "src");
      const externalDirectory = path.join(external, "external-src");
      cpSync(sourceDirectory, externalDirectory, { recursive: true });
      rmSync(sourceDirectory, { recursive: true, force: true });
      symlinkSync(externalDirectory, sourceDirectory, process.platform === "win32" ? "junction" : "dir");

      const snippet = await app.code.indexer.readSnippet(node as CodeSearchResult);
      expect(snippet.snippet).toBeNull();
      expect(snippet.warning).toContain("outside the workspace");
    } finally {
      app.close();
    }
  });

  it("probes the real workspace root and applies the detected path-key policy", async () => {
    const root = temporaryWorkspace();
    writeWorkspaceFile(root, "tsconfig.json", JSON.stringify({ include: ["src/**/*.ts"] }));
    const detected = detectPathCaseSensitivity(root);
    expect(detected.warning).toBeNull();
    writeWorkspaceFile(root, "src/Foo.ts", "export const upperCaseFile = true;\n");
    writeWorkspaceFile(root, "src/foo.ts", "export const lowerCaseFile = true;\n");
    const app = new ContextMeshApp(root);
    try {
      expect(app.database.caseSensitivePaths).toBe(detected.caseSensitive);
      expect(readdirSync(root).some((name) => name.includes("ContextMesh-CaseProbe"))).toBe(false);
      const indexed = (await app.indexWorkspace({ mode: "full" })) as Envelope<IndexData>;
      expect(indexed.data.files).toBe(detected.caseSensitive ? 2 : 1);
      const keys = [...app.database.getFileHashes().keys()];
      if (detected.caseSensitive) {
        expect(keys).toContain("src/Foo.ts");
        expect(keys).toContain("src/foo.ts");
      } else {
        expect(keys).toEqual(["src/foo.ts"]);
      }
    } finally {
      app.close();
    }
  });

  it("falls back to case-sensitive keys when the probe cannot be created", () => {
    const root = temporaryWorkspace();
    const result = detectPathCaseSensitivity(path.join(root, "missing-root"));
    expect(result.caseSensitive).toBe(true);
    expect(result.warning).toContain("using case-sensitive keys");
  });
});
