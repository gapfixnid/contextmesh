import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("CI release tooling contract", () => {
  it("requires checked v0.6 evidence in hosted and clean-source release gates", () => {
    const workflow = readFileSync(path.join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8")
      .replaceAll("\r\n", "\n");
    const sourceZip = readFileSync(path.join(process.cwd(), "scripts", "verify-source-zip.ts"), "utf8");

    expect(workflow).toContain("npm run evaluate:v06 -- --output artifacts/v06-boundary-impact.json");
    expect(workflow).toContain("npm run verify:v06-artifact");
    expect(workflow).toContain("artifacts/v06-boundary-impact.json");
    expect(sourceZip).toContain('"artifacts/v06-boundary-impact.json"');
    expect(sourceZip).toContain('"run", "verify:v06-artifact"');
  });

  it("provisions pinned Go and rust-analyzer in every job that executes verify:source-zip", () => {
    const workflow = readFileSync(path.join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
    const marker = "  clean-source-zip-release-gate:\n";
    const start = workflow.replaceAll("\r\n", "\n").indexOf(marker);
    const job = start >= 0 ? workflow.replaceAll("\r\n", "\n").slice(start) : undefined;

    expect(job).toBeDefined();
    expect(job).toContain("uses: actions/setup-go@v5");
    expect(job).toContain("go-version: 1.23.x");
    expect(job).toContain("uses: actions-rust-lang/setup-rust-toolchain@v1");
    expect(job).toContain("toolchain: 1.85.0");
    expect(job).toContain("components: rust-analyzer");
    expect(job).toContain("RUSTUP_TOOLCHAIN: 1.85.0");
    expect(job!.indexOf("actions/setup-go@v5")).toBeLessThan(job!.indexOf("npm ci"));
    expect(job!.indexOf("actions-rust-lang/setup-rust-toolchain@v1")).toBeLessThan(job!.indexOf("npm ci"));
  });
});
