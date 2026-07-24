import { describe, expect, it } from "vitest";

import { computeMemoryUtility } from "../src/memory/utility.js";

const clock = new Date("2026-01-01T00:00:00.000Z");
const base = {
  importance: 3,
  assertionStatus: "observed" as const,
  isAnchor: false,
  type: "fact" as const,
  accessCount: 0,
  validationState: "valid" as const,
  observedAt: null,
  validFrom: "2025-01-01T00:00:00.000Z",
  createdAt: "2025-01-01T00:00:00.000Z",
};

describe("v0.7 memory utility", () => {
  it("is deterministic, integral, bounded, and reinforces access up to 100 points", () => {
    const score = computeMemoryUtility(base, clock);
    expect(computeMemoryUtility(base, clock)).toBe(score);
    expect(Number.isInteger(score)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1000);
    expect(computeMemoryUtility({ ...base, accessCount: 100 }, clock) - score).toBe(100);
  });

  it("applies slower anchor/decision decay and hard-zero unsafe assertions", () => {
    const episode = computeMemoryUtility({ ...base, type: "episode" }, clock);
    const decision = computeMemoryUtility({ ...base, type: "decision" }, clock);
    const anchor = computeMemoryUtility({ ...base, isAnchor: true }, clock);
    expect(decision).toBeGreaterThan(episode);
    expect(anchor).toBeGreaterThan(decision);
    expect(computeMemoryUtility({ ...base, assertionStatus: "rejected" }, clock)).toBe(0);
    expect(computeMemoryUtility({ ...base, validationState: "contradicted" }, clock)).toBe(0);
    expect(computeMemoryUtility({ ...base, validationState: "stale" }, clock))
      .toBeLessThan(computeMemoryUtility({ ...base, validationState: "valid" }, clock));
  });
});
