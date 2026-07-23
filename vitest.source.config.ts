import { configDefaults, defineConfig } from "vitest/config";

/**
 * Development source suite.
 *
 * These three files validate checked, commit-bound release evidence. They stay
 * in the normal `npm test`/release gate, but are excluded while the v0.6 source
 * tree is intentionally ahead of the last measured artifacts. Every other
 * unit, integration, evaluator, migration, packaging, and security test runs.
 */
export default defineConfig({
  test: {
    testTimeout: 15_000,
    exclude: [
      ...configDefaults.exclude,
      "tests/v04-artifact-contract.test.ts",
      "tests/v05-artifact-contract.test.ts",
      "tests/evaluation-multilang.test.ts",
    ],
  },
});
