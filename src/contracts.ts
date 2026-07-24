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
  "resource",
] as const;

export const CODE_EDGE_KINDS = [
  "CONTAINS",
  "IMPORTS",
  "EXPORTS",
  "CALLS",
  "EXTENDS",
  "IMPLEMENTS",
  "REFERENCES",
  "REQUESTS",
  "HANDLED_BY",
  "PUBLISHES",
  "CONSUMES",
  "READS_FROM",
  "WRITES_TO",
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
export const MEMORY_VALIDATION_STATES = [
  "unlinked",
  "valid",
  "relocated",
  "stale",
  "orphaned",
  "contradicted",
  "needs_review",
] as const;
export const MEMORY_MAINTENANCE_STATES = [
  "clean",
  "duplicate_candidate",
  "conflict_candidate",
  "review_required",
] as const;
export const MEMORY_CLAIM_NAMESPACES = ["code", "config", "api", "custom"] as const;
export const CODE_CLAIM_KEYS = [
  "symbol.exists",
  "symbol.signature",
  "symbol.contentHash",
  "symbol.qualifiedName",
] as const;

export type CodeNodeKind = (typeof CODE_NODE_KINDS)[number];
export type CodeEdgeKind = (typeof CODE_EDGE_KINDS)[number];
export type MemoryType = (typeof MEMORY_TYPES)[number];
export type AssertionStatus = (typeof ASSERTION_STATUSES)[number];
export type MemoryValidationState = (typeof MEMORY_VALIDATION_STATES)[number];
export type MemoryMaintenanceState = (typeof MEMORY_MAINTENANCE_STATES)[number];
export type IndexMode = "full" | "incremental";
export type AnalysisLevel = "syntax" | "resolved" | "typed";
export type EvidenceSource = "syntax" | "resolver" | "type_checker" | "language_server" | "manifest" | "heuristic";
export type CodeLanguage = "typescript" | "tsx" | "javascript" | "jsx" | "mjs" | "cjs" | "python" | "go" | "rust" | "java" | "csharp";
export type CodeEcosystem = "npm" | "pypi" | "go" | "cargo" | "maven" | "nuget";
export type EdgeStatus = "candidate" | "rejected" | "resolved";
export type PrecisionProviderStatus = "not_configured" | "running" | "ready" | "stale" | "failed" | "partial";

export interface WorkspaceSnapshot {
  graphGeneration: number;
  precisionRevision: number;
  successFence: number;
  freshness: "fresh" | "fast-verified" | "stale";
  memoryRevision?: number;
}

export interface CodeEvidence {
  provider: string;
  providerVersion: string;
  source: EvidenceSource;
  confidence: number;
  sourceSpan?: { startByte: number; endByte: number; line: number; column: number };
  details?: Record<string, unknown>;
}

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

const isoDateTimeWithTimezone = z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString());
export const memoryClaimSchema = z.object({
  namespace: z.enum(MEMORY_CLAIM_NAMESPACES),
  key: z.string().trim().min(1).max(200),
  operator: z.literal("eq"),
  value: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
  sourceSymbolId: z.string().min(1).optional(),
}).superRefine((claim, context) => {
  if (claim.namespace !== "code") return;
  if (!CODE_CLAIM_KEYS.includes(claim.key as (typeof CODE_CLAIM_KEYS)[number])) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `Unsupported code claim key: ${claim.key}`, path: ["key"] });
  }
  if (!claim.sourceSymbolId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "code claims require sourceSymbolId", path: ["sourceSymbolId"] });
  }
});

const memoryDraftBaseSchema = z.object({
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
  validFrom: isoDateTimeWithTimezone.optional(),
  validTo: isoDateTimeWithTimezone.optional(),
  observedAt: isoDateTimeWithTimezone.optional(),
  claims: z.array(memoryClaimSchema).max(50).default([]),
});
function validateMemoryDraft(
  draft: z.infer<typeof memoryDraftBaseSchema>,
  context: z.RefinementCtx,
): void {
  if (draft.validFrom && draft.validTo && draft.validTo <= draft.validFrom) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "validTo must be later than validFrom", path: ["validTo"] });
  }
  const sourceIds = new Set(draft.sourceSymbolIds);
  const claimKeys = new Set<string>();
  draft.claims.forEach((claim, index) => {
    const claimKey = `${claim.namespace}\0${claim.key}\0${claim.operator}`;
    if (claimKeys.has(claimKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "duplicate claim key",
        path: ["claims", index, "key"],
      });
    }
    claimKeys.add(claimKey);
    if (claim.namespace === "code" && claim.sourceSymbolId && !sourceIds.has(claim.sourceSymbolId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "code claim sourceSymbolId must be present in sourceSymbolIds",
        path: ["claims", index, "sourceSymbolId"],
      });
    }
  });
}
export const memoryDraftSchema = memoryDraftBaseSchema.superRefine(validateMemoryDraft);

export const rememberSchema = memoryDraftBaseSchema.extend({
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

export const exploreContextSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  symbolId: z.string().min(1).optional(),
  intent: z.enum(["implementation", "architecture", "debugging"]).default("implementation"),
  depth: z.number().int().min(1).max(3).default(2),
  limit: z.number().int().min(1).max(50).default(12),
  tokenBudget: z.number().int().min(256).max(8000).default(2000),
});

export const reflectSchema = z.object({
  sessionId: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(4000),
  learnings: z.array(memoryDraftBaseSchema.omit({ supersedesId: true }).superRefine(validateMemoryDraft)).max(50).default([]),
  clientName: z.string().trim().min(1).max(120).optional(),
});

export const forgetSchema = z.object({
  fragmentId: z.string().min(1),
  reason: z.string().trim().min(1).max(1000),
});

const reviewListSchema = z.object({
  action: z.literal("list"),
  validationStates: z.array(z.enum(MEMORY_VALIDATION_STATES)).max(MEMORY_VALIDATION_STATES.length).optional(),
  candidateTypes: z.array(z.enum(["duplicate", "conflict", "episode_compaction", "code_validation"])).max(4).optional(),
  maintenanceStates: z.array(z.enum(MEMORY_MAINTENANCE_STATES)).max(MEMORY_MAINTENANCE_STATES.length).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(10_000).default(0),
  tokenBudget: z.number().int().min(256).max(8000).default(2000),
});
const reviewMaintenanceSchema = z.object({
  action: z.literal("run_maintenance"),
  kinds: z.array(z.enum([
    "revalidate_links",
    "detect_duplicates",
    "detect_conflicts",
    "compact_episodes",
    "recompute_utility",
    "expire_lifecycle",
  ])).max(6).optional(),
  maxItems: z.number().int().min(1).max(500).default(100),
  dryRun: z.boolean().default(false),
  tokenBudget: z.number().int().min(256).max(8000).default(2000),
});
const reviewResolveSchema = z.object({
  action: z.literal("resolve"),
  candidateId: z.string().min(1),
  decision: z.enum(["dismiss", "reject_memory", "forget_memory", "relink", "compact_episodes"]),
  reason: z.string().trim().min(1).max(1000),
  fragmentId: z.string().min(1).optional(),
  targetSymbolId: z.string().min(1).optional(),
  replacementContent: z.string().trim().min(1).max(4000).optional(),
  tokenBudget: z.number().int().min(256).max(8000).default(2000),
});
export const reviewMemoriesSchema = z.discriminatedUnion("action", [
  reviewListSchema,
  reviewMaintenanceSchema,
  reviewResolveSchema,
]);

export type IndexWorkspaceInput = z.infer<typeof indexWorkspaceSchema>;
export type SearchCodeInput = z.infer<typeof searchCodeSchema>;
export type TraceCodeInput = z.infer<typeof traceCodeSchema>;
export type RememberInput = z.infer<typeof rememberSchema>;
export type RecallInput = z.infer<typeof recallSchema>;
export type GetContextInput = z.infer<typeof getContextSchema>;
export type ExploreContextInput = z.infer<typeof exploreContextSchema>;
export type ReflectInput = z.infer<typeof reflectSchema>;
export type ForgetInput = z.infer<typeof forgetSchema>;
export type MemoryClaim = z.infer<typeof memoryClaimSchema>;
export type ReviewMemoriesInput = z.infer<typeof reviewMemoriesSchema>;

export interface Envelope<T> {
  schemaVersion: 1;
  workspaceId: string;
  generation: number;
  data: T;
  warnings: string[];
  truncated: boolean;
  estimatedTokens: number;
  snapshot?: WorkspaceSnapshot;
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
  language: CodeLanguage;
  ecosystem?: CodeEcosystem;
  sourceRoot?: string;
  adapterConfigHash?: string;
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
  language?: IndexedSourceFile["language"];
  ecosystem?: CodeEcosystem;
  nativeKind?: string;
  analysisLevel?: AnalysisLevel;
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
  status?: EdgeStatus;
  evidence?: CodeEvidence[];
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
  confidence?: number;
  evidence?: CodeEvidence[];
}

export interface ExtractedGraph {
  files: IndexedSourceFile[];
  nodes: CodeNodeRecord[];
  edges: CodeEdgeRecord[];
  unresolvedReferences: UnresolvedReferenceRecord[];
  diagnostics: string[];
  adapterStats?: AdapterStats[];
}

export interface AdapterStats {
  language: string;
  ecosystem: string;
  syntaxProvider: string;
  precisionProvider: string | null;
  analysisLevel: AnalysisLevel;
  files: number;
  filesReparsed?: number;
  kernelRssBytes?: number;
  syntaxInvocations: number;
  precisionInvocations: number;
  configHash: string;
  providerVersions?: Record<string, string>;
  status?: "ready" | "partial" | "unavailable" | "not_configured" | "failed" | "stale";
  coverage?: number;
  diagnostics?: AdapterDiagnostic[];
}

export interface AdapterDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  path?: string;
}

export interface AdapterStateRecord {
  configHash: string;
  lastGeneration: number;
  precisionRevision: number;
  stats: AdapterStats;
}

export type AdapterStateMap = Record<string, AdapterStateRecord>;

export interface PrecisionProviderState {
  language: string;
  provider: string;
  providerVersion: string;
  capability: AnalysisLevel;
  status: PrecisionProviderStatus;
  baseGeneration: number;
  precisionRevision: number;
  eligibleEdges: number;
  resolvedEdges: number;
  rejectedEdges: number;
  coverage: number;
  lastError: string | null;
  leaseExpiresAt: string | null;
  updatedAt: string;
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
  validFrom: string;
  validTo: string | null;
  observedAt: string | null;
  utilityScore: number;
  maintenanceState: MemoryMaintenanceState;
  validation: {
    state: MemoryValidationState;
    checkedGeneration: number | null;
    checkedAt: string | null;
    confidence: number;
    reasonCodes: string[];
    linkCount: number;
  };
  claims?: MemoryClaim[];
}
