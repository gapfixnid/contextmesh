import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function createFixtureWorkspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), "contextmesh-test-"));
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
      },
      include: ["src/**/*", "legacy.cjs"],
    }),
  );
  writeWorkspaceFile(
    root,
    "src/math.ts",
    `/** Doubles a numeric value. */
export function double(value: number): number {
  return value * 2;
}

export interface NumericOperation {
  run(value: number): number;
}
`,
  );
  writeWorkspaceFile(
    root,
    "src/service.ts",
    `import { double, type NumericOperation } from "./math.js";

export class Calculator implements NumericOperation {
  run(value: number): number {
    return double(value);
  }
}
`,
  );
  writeWorkspaceFile(
    root,
    "src/index.ts",
    `import { Calculator } from "./service.js";

export const compute = (value: number): number => new Calculator().run(value);
`,
  );
  writeWorkspaceFile(
    root,
    "src/view.tsx",
    `export function ValueView(props: { value: number }) {
  return <span>{props.value}</span>;
}
`,
  );
  writeWorkspaceFile(
    root,
    "src/dynamic.ts",
    `export function invoke(callback: () => void): void {
  callback();
}
`,
  );
  writeWorkspaceFile(
    root,
    "legacy.cjs",
    `const { double } = require("./src/math.js");
module.exports = (value) => double(value);
`,
  );
  writeWorkspaceFile(root, ".env.js", "export const API_SECRET = 'must-not-be-indexed';\n");
  return root;
}

export function writeWorkspaceFile(root: string, relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

export function removeFixtureWorkspace(root: string): void {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
