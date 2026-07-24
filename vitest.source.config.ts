import { configDefaults, defineConfig } from "vitest/config";

/**
 * Development source suite.
 *
 * This mirrors the normal Vitest execution contract and excludes only three
 * checked, commit-bound release-evidence files while the v0.6 source tree is
 * intentionally ahead of the last measured artifacts. Every other unit,
 * integration, evaluator, migration, packaging, and security test runs.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    exclude: [
      ...configDefaults.exclude,
      "tests/v04-artifact-contract.test.ts",
      "tests/v05-artifact-contract.test.ts",
      "tests/evaluation-multilang.test.ts",
    ],
  },
});
