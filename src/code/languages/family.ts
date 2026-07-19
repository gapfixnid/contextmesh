import type { CodeNodeRecord } from "../../contracts.js";

export type AdapterFamily = "typescript/javascript" | "python" | "go" | "rust" | "java" | "csharp";

const TYPESCRIPT_DIALECTS = new Set<CodeNodeRecord["language"]>([
  "typescript", "tsx", "javascript", "jsx", "mjs", "cjs",
]);

export function adapterFamily(node: Pick<CodeNodeRecord, "language" | "ecosystem">): AdapterFamily | null {
  if (node.ecosystem === "npm" || TYPESCRIPT_DIALECTS.has(node.language)) return "typescript/javascript";
  if (node.ecosystem === "pypi" || node.language === "python") return "python";
  if (node.ecosystem === "go" || node.language === "go") return "go";
  if (node.ecosystem === "cargo" || node.language === "rust") return "rust";
  if (node.ecosystem === "maven" || node.language === "java") return "java";
  if (node.ecosystem === "nuget" || node.language === "csharp") return "csharp";
  return null;
}

export function crossesAdapterFamily(
  source: Pick<CodeNodeRecord, "language" | "ecosystem">,
  target: Pick<CodeNodeRecord, "language" | "ecosystem">,
): boolean {
  const sourceFamily = adapterFamily(source);
  const targetFamily = adapterFamily(target);
  return sourceFamily !== null && targetFamily !== null && sourceFamily !== targetFamily;
}
