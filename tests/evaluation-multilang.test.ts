import { readFileSync } from "node:fs";
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
      strategies: Array<{ id: string; score: { falseEdges: number; staleEvidence: number } }>;
      traces: Array<{ taskId: string; strategyId: string; estimatedTokens: number }>;
      determinism: { runs: number; identical: boolean; signatures: string[] };
      performanceMs: { cold: { p50: number; p95: number }; warm: { p50: number; p95: number }; incremental: { p50: number; p95: number } };
    };
    expect(artifact.fixtureDigest).toBe(sha256(canonical(fixture)));
    expect(new Set(fixture.tasks.map((task) => task.category))).toEqual(new Set(["ts-only", "python-only", "mixed", "memory-needed", "memory-not-needed"]));
    expect(artifact.strategies.map((strategy) => strategy.id)).toEqual(["A", "B", "C", "D"]);
    expect(artifact.strategies.every((strategy) => strategy.score.falseEdges === 0 && strategy.score.staleEvidence === 0)).toBe(true);
    expect(artifact.traces).toHaveLength(fixture.tasks.length * 4);
    expect(artifact.traces.every((trace) => trace.estimatedTokens <= artifact.tokenBudget)).toBe(true);
    expect(artifact.determinism).toMatchObject({ runs: 20, identical: true });
    expect(new Set(artifact.determinism.signatures).size).toBe(1);
    for (const timing of Object.values(artifact.performanceMs)) expect(timing.p95).toBeGreaterThanOrEqual(timing.p50);
  });
});
