import { z } from "zod";

export const CODE_NODE_KINDS = [
  "module",
  "external_module",
  "function",
  "class",
  "method",
  "interface",
  "type_alias",
  "enum",
  "variable",
] as const;

export const CODE_EDGE_KINDS = [
  "CONTAINS",
  "IMPORTS",
  "EXPORTS",
  "CALLS",
  "EXTENDS",
  "IMPLEMENTS",
  "REFERENCES",
] as const;

export const MEMORY_TYPES = [
  "fact",
  "decision",
  "error",
  "preference",
  "procedure",
  "relation",
  "episode",
] as const;

export const ASSERTION_STATUSES = ["observed", "inferred", "verified", "rejected"] as const;

export type CodeNodeKind = (typeof CODE_NODE_KINDS)[number];
export type CodeEdgeKind = (typeof CODE_EDGE_KINDS)[number];
export type MemoryType = (typeof MEMORY_TYPES)[number];
export type AssertionStatus = (typeof ASSERTION_STATUSES)[number];
export type IndexMode = "full" | "incremental";

export const indexWorkspaceSchema = z.object({
  mode: z.enum(["full", "incremental"]).default("incremental"),
});

export const searchCodeSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  kinds: z.array(z.enum(CODE_NODE_KINDS)).max(CODE_NODE_KINDS.length).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(10_000).default(0),
});

export const traceCodeSchema = z.object({
  symbolId: z.string().min(1),
  direction: z.enum(["in", "out", "both"]).default("both"),
  edgeKinds: z.array(z.enum(CODE_EDGE_KINDS)).max(CODE_EDGE_KINDS.length).optional(),
  depth: z.number().int().min(1).max(5).default(2),
  limit: z.number().int().min(1).max(500).default(100),
});

export const memoryDraftSchema = z.object({
  content: z.string().trim().min(1).max(4000),
  topic: z.string().trim().min(1).max(120),
  type: z.enum(MEMORY_TYPES),
  keywords: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  importance: z.number().int().min(1).max(5).default(3),
  anchor: z.boolean().default(false),
  assertionStatus: z.enum(ASSERTION_STATUSES).default("observed"),
  ttlDays: z.number().int().min(1).max(3650).optional(),
  sourceSymbolIds: z.array(z.string().min(1)).max(20).default([]),
  supersedesId: z.string().min(1).optional(),
});

export const rememberSchema = memoryDraftSchema.extend({
  sessionId: z.string().min(1).max(200).optional(),
});

export const recallSchema = z
  .object({
    query: z.string().trim().min(1).max(1000).optional(),
    keywords: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
    types: z.array(z.enum(MEMORY_TYPES)).max(MEMORY_TYPES.length).optional(),
    topic: z.string().trim().min(1).max(120).optional(),
    tokenBudget: z.number().int().min(128).max(8000).default(1000),
    includeAnchors: z.boolean().default(false),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).max(10_000).default(0),
  })
  .refine((value) => value.query || value.keywords?.length || value.includeAnchors, {
    message: "At least one of query, keywords, or includeAnchors is required",
  });

export const getContextSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  symbolId: z.string().min(1).optional(),
  tokenBudget: z.number().int().min(256).max(8000).default(2000),
  include: z.array(z.enum(["code", "memory"])).min(1).max(2).default(["code", "memory"]),
});

export const reflectSchema = z.object({
  sessionId: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(4000),
  learnings: z.array(memoryDraftSchema.omit({ supersedesId: true })).max(50).default([]),
  clientName: z.string().trim().min(1).max(120).optional(),
});

export const forgetSchema = z.object({
  fragmentId: z.string().min(1),
  reason: z.string().trim().min(1).max(1000),
});

export type IndexWorkspaceInput = z.infer<typeof indexWorkspaceSchema>;
export type SearchCodeInput = z.infer<typeof searchCodeSchema>;
export type TraceCodeInput = z.infer<typeof traceCodeSchema>;
export type RememberInput = z.infer<typeof rememberSchema>;
export type RecallInput = z.infer<typeof recallSchema>;
export type GetContextInput = z.infer<typeof getContextSchema>;
export type ReflectInput = z.infer<typeof reflectSchema>;
export type ForgetInput = z.infer<typeof forgetSchema>;

export interface Envelope<T> {
  schemaVersion: 1;
  workspaceId: string;
  generation: number;
  data: T;
  warnings: string[];
  truncated: boolean;
  estimatedTokens: number;
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  rootPath: string;
  rootPathKey: string;
  currentGeneration: number;
  createdAt: string;
  updatedAt: string;
}

export interface IndexedSourceFile {
  id: string;
  workspaceId: string;
  relativePath: string;
  pathKey: string;
  absolutePath: string;
  language: "typescript" | "tsx" | "javascript" | "jsx" | "mjs" | "cjs";
  content: string;
  contentHash: string;
  sizeBytes: number;
  mtimeMs: number;
  parseStatus: "ok" | "partial" | "error";
  diagnosticCount: number;
  generation: number;
}

export interface CodeNodeRecord {
  id: string;
  workspaceId: string;
  fileId: string | null;
  kind: CodeNodeKind;
  name: string;
  qualifiedName: string;
  localKey: string;
  signature: string;
  doc: string;
  isExported: boolean;
  startByte: number;
  endByte: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  contentHash: string;
  generation: number;
  metadata: Record<string, unknown>;
}

export interface CodeEdgeRecord {
  workspaceId: string;
  sourceId: string;
  targetId: string;
  kind: CodeEdgeKind;
  confidence: number;
  resolutionKind: "exact" | "local" | "import" | "heuristic";
  generation: number;
  metadata: Record<string, unknown>;
}

export interface UnresolvedReferenceRecord {
  workspaceId: string;
  fileId: string;
  sourceNodeId: string | null;
  kind: string;
  rawName: string;
  qualifier: string | null;
  line: number;
  column: number;
  candidates: string[];
  generation: number;
}

export interface ExtractedGraph {
  files: IndexedSourceFile[];
  nodes: CodeNodeRecord[];
  edges: CodeEdgeRecord[];
  unresolvedReferences: UnresolvedReferenceRecord[];
  diagnostics: string[];
}

export interface MemoryFragmentRecord {
  id: string;
  workspaceId: string;
  type: MemoryType;
  topic: string;
  content: string;
  keywords: string[];
  importance: number;
  isAnchor: boolean;
  assertionStatus: AssertionStatus;
  state: "active" | "superseded" | "forgotten" | "expired";
  sessionId: string | null;
  supersedesId: string | null;
  accessCount: number;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
  expiresAt: string | null;
}
