import type { CodeNodeRecord, MemoryFragmentRecord } from "../contracts.js";
import { sha256, tokenizeIdentifier, unique } from "../utils.js";

export interface SemanticDocument {
  entityId: string;
  sourceHash: string;
  text: string;
}

function normalizeText(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

function identifiers(...values: string[]): string {
  return unique(
    values
      .flatMap((value) => tokenizeIdentifier(value).split(/\s+/u))
      .map(normalizeText)
      .filter(Boolean),
  )
    .slice(0, 32)
    .join(" ");
}

function document(entityId: string, lines: Array<[string, string | null | undefined]>): SemanticDocument {
  const text = lines
    .map(([label, value]) => [label, normalizeText(value ?? "")] as const)
    .filter(([, value]) => value.length > 0)
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n")
    .normalize("NFC");
  return { entityId, sourceHash: sha256(text), text };
}

export function buildCodeSemanticDocument(node: CodeNodeRecord, relativePath: string | null): SemanticDocument {
  return document(node.id, [
    ["kind", node.kind],
    ["name", node.name],
    ["qualified_name", node.qualifiedName],
    ["path", relativePath],
    ["signature", node.signature],
    ["documentation", node.doc],
    ["identifiers", identifiers(node.name, node.qualifiedName, node.signature, node.doc)],
  ]);
}

export function buildMemorySemanticDocument(memory: MemoryFragmentRecord): SemanticDocument {
  return document(memory.id, [
    ["type", memory.type],
    ["topic", memory.topic],
    ["keywords", memory.keywords.join(" ")],
    ["content", memory.content],
    ["assertion_status", memory.assertionStatus],
  ]);
}
