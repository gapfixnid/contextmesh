import type { MemoryFragmentRecord } from "../contracts.js";
import type { CodeSearchResult } from "../storage/database.js";

export function buildCodeRedundancyText(
  node: Pick<CodeSearchResult, "name" | "qualifiedName" | "signature" | "doc">,
): string {
  return [node.name, node.qualifiedName, node.signature, node.doc].join("\n");
}

export function buildMemoryRedundancyText(
  memory: Pick<MemoryFragmentRecord, "topic" | "keywords" | "content">,
): string {
  const keywords = memory.keywords.map((keyword) => keyword.normalize("NFC")).sort();
  return [memory.topic, keywords.join(" "), memory.content].join("\n");
}
