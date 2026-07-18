import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { sha256 } from "../src/utils.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

describe("mixed-language evaluation artifact", () => {
  it("records all strategies/categories and twenty identical ordered signatures", () => {
    const fixtureBytes = readFileSync(path.join(process.cwd(), "evaluation", "fixtures", "mixed-language-v1.json"));
    const fixture = JSON.parse(fixtureBytes.toString("utf8")) as { tasks: Array<{ category: string }> };
    const artifact = JSON.parse(readFileSync(path.join(process.cwd(), "evaluation", "artifacts", "mixed-language-v1.json"), "utf8")) as {
      fixtureDigest: string;
      tokenBudget: number;
      strategies: Array<{ id: string; score: { falseEdges: number; staleEvidence: number; edgeRecall: number; memoryRecall: number; memoryLeak: number } }>;
      traces: Array<{ taskId: string; strategyId: string; estimatedTokens: number; orderedMemories: string[]; searchStages: string[] }>;
      determinism: { runs: number; identical: boolean; signatures: string[] };
      performanceMs: { cold: { p50: number; p95: number }; warm: { p50: number; p95: number }; incremental: { p50: number; p95: number } };
      samples: { cold: number; warm: number; incremental: number };
      providers: { typescript: string };
      thresholds: Record<string, boolean>;
      git: { commit: string; baseline: string };
    };
    expect(artifact.fixtureDigest).toBe(sha256(canonical(fixture)));
    expect(new Set(fixture.tasks.map((task) => task.category))).toEqual(new Set(["ts-only", "python-only", "mixed", "memory-needed", "memory-not-needed"]));
    expect(artifact.strategies.map((strategy) => strategy.id)).toEqual(["A", "B", "C", "D"]);
    expect(artifact.strategies.every((strategy) => strategy.score.falseEdges === 0 && strategy.score.staleEvidence === 0)).toBe(true);
    expect(artifact.strategies.find((strategy) => strategy.id === "B")!.score.edgeRecall)
      .toBeLessThan(artifact.strategies.find((strategy) => strategy.id === "C")!.score.edgeRecall);
    expect(artifact.traces.find((trace) => trace.taskId === "ts" && trace.strategyId === "B")?.searchStages).toContain("syntax-snapshot-retrieval");
    expect(artifact.traces.find((trace) => trace.taskId === "ts" && trace.strategyId === "C")?.searchStages).toContain("typed-db-retrieval");
    expect(artifact.strategies.find((strategy) => strategy.id === "D")!.score).toMatchObject({ memoryRecall: 1, memoryLeak: 0 });
    expect(artifact.traces.find((trace) => trace.taskId === "memory" && trace.strategyId === "D")?.orderedMemories).toContain("retry decision");
    expect(artifact.traces.find((trace) => trace.taskId === "memory" && trace.strategyId === "D")?.orderedMemories).not.toContain("retry decision unlinked");
    expect(artifact.traces.find((trace) => trace.taskId === "memory" && trace.strategyId === "D")?.searchStages).toEqual(expect.arrayContaining(["memory-fts", "valid-code-links"]));
    expect(artifact.traces).toHaveLength(fixture.tasks.length * 4);
    expect(artifact.traces.every((trace) => trace.estimatedTokens <= artifact.tokenBudget)).toBe(true);
    expect(artifact.determinism).toMatchObject({ runs: 20, identical: true });
    expect(new Set(artifact.determinism.signatures).size).toBe(1);
    expect(artifact.samples).toEqual({ cold: 5, warm: 20, incremental: 5 });
    expect(artifact.providers.typescript).toMatch(/^\d+\.\d+/);
    expect(Object.values(artifact.thresholds).every(Boolean)).toBe(true);
    let gitWorktree = false;
    try {
      gitWorktree = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      }).trim() === "true";
    } catch {
      // Source ZIP verification intentionally runs without repository metadata.
    }
    if (gitWorktree) {
      expect(() => execFileSync("git", ["merge-base", "--is-ancestor", artifact.git.commit, "HEAD"], {
        cwd: process.cwd(), stdio: "pipe",
      })).not.toThrow();
    }
    for (const timing of Object.values(artifact.performanceMs)) expect(timing.p95).toBeGreaterThanOrEqual(timing.p50);
  });
});
