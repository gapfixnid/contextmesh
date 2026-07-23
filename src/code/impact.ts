import { z } from "zod";

import {
  CODE_EDGE_KINDS,
  type CodeEdgeKind,
  type CodeEvidence,
  type EdgeStatus,
  type Envelope,
} from "../contracts.js";
import { ContextMeshError } from "../errors.js";
import type {
  CodeSearchResult,
  TraceEdgeResult,
  TraceResult,
} from "../storage/database.js";
import {
  envelopeFits,
  stabilizeEnvelope,
  type EnvelopeScope,
} from "../token-budget.js";

const DEFAULT_IMPACT_EDGE_KINDS = [
  "CALLS",
  "REFERENCES",
  "IMPORTS",
  "EXTENDS",
  "IMPLEMENTS",
] as const satisfies readonly CodeEdgeKind[];

export const impactCodeSchema = z.object({
  symbolId: z.string().min(1),
  direction: z.enum(["in", "out"]).default("in"),
  edgeKinds: z.array(z.enum(CODE_EDGE_KINDS)).min(1).max(CODE_EDGE_KINDS.length)
    .default([...DEFAULT_IMPACT_EDGE_KINDS]),
  depth: z.number().int().min(1).max(5).default(3),
  limit: z.number().int().min(1).max(200).default(50),
  tokenBudget: z.number().int().min(256).max(8000).default(2000),
});

export type ImpactCodeInput = z.infer<typeof impactCodeSchema>;

export interface ImpactBoundary {
  protocol: string;
  method: string | null;
  path: string | null;
  clientLanguage: string | null;
  clientFile: string | null;
  serverLanguage: string | null;
  serverFile: string | null;
}

interface ImpactNode {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  signature: string;
  language: string | null;
  relativePath: string | null;
}

export interface ImpactTarget extends ImpactNode {
  minDepth: number;
  confidence: number;
  confirmed: boolean;
  verificationRequired: boolean;
  crossLanguage: boolean;
  statuses: EdgeStatus[];
  relationKinds: CodeEdgeKind[];
  boundaries: ImpactBoundary[];
}

export interface ImpactRelation {
  sourceId: string;
  targetId: string;
  kind: CodeEdgeKind;
  depth: number;
  status: EdgeStatus;
  confidence: number;
  confirmed: boolean;
  boundaries: ImpactBoundary[];
}

export interface ImpactData {
  start: ImpactNode;
  direction: ImpactCodeInput["direction"];
  requestedDepth: number;
  summary: {
    observedAffectedCount: number;
    returnedAffectedCount: number;
    confirmedCount: number;
    verificationRequiredCount: number;
    crossLanguageCount: number;
    boundaryCount: number;
    observedRelationCount: number;
    returnedRelationCount: number;
    unresolvedCount: number;
    returnedUnresolvedCount: number;
  };
  affected: ImpactTarget[];
  relations: ImpactRelation[];
  unresolved: TraceResult["unresolved"];
}

interface MutableTarget {
  node: CodeSearchResult;
  minDepth: number;
  confidence: number;
  confirmed: boolean;
  statuses: Set<EdgeStatus>;
  relationKinds: Set<CodeEdgeKind>;
  boundaries: Map<string, ImpactBoundary>;
}

function stringDetail(details: Record<string, unknown>, key: string): string | null {
  const value = details[key];
  return typeof value === "string" ? value : null;
}

function boundaryKey(boundary: ImpactBoundary): string {
  return [
    boundary.protocol,
    boundary.method ?? "",
    boundary.path ?? "",
    boundary.clientLanguage ?? "",
    boundary.clientFile ?? "",
    boundary.serverLanguage ?? "",
    boundary.serverFile ?? "",
  ].join("\0");
}

function boundaryEvidence(evidence: CodeEvidence[] | undefined): ImpactBoundary[] {
  const boundaries = new Map<string, ImpactBoundary>();
  for (const item of evidence ?? []) {
    const details = item.details;
    if (!details || typeof details.boundaryProtocol !== "string") continue;
    const boundary: ImpactBoundary = {
      protocol: details.boundaryProtocol,
      method: stringDetail(details, "boundaryMethod"),
      path: stringDetail(details, "boundaryPath"),
      clientLanguage: stringDetail(details, "clientLanguage"),
      clientFile: stringDetail(details, "clientFile"),
      serverLanguage: stringDetail(details, "serverLanguage"),
      serverFile: stringDetail(details, "serverFile"),
    };
    boundaries.set(boundaryKey(boundary), boundary);
  }
  return [...boundaries.values()].sort((left, right) =>
    boundaryKey(left).localeCompare(boundaryKey(right)));
}

function impactNode(node: CodeSearchResult): ImpactNode {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    signature: node.signature,
    language: node.language ?? null,
    relativePath: node.relativePath,
  };
}

function targetId(edge: TraceEdgeResult, direction: ImpactCodeInput["direction"]): string {
  return direction === "in" ? edge.sourceId : edge.targetId;
}

function relation(edge: TraceEdgeResult): ImpactRelation {
  return {
    sourceId: edge.sourceId,
    targetId: edge.targetId,
    kind: edge.kind,
    depth: edge.depth,
    status: edge.status,
    confidence: edge.confidence,
    confirmed: edge.status === "resolved" && edge.confidence >= 0.9,
    boundaries: boundaryEvidence(edge.evidence),
  };
}

function relationKey(item: ImpactRelation): string {
  return `${String(item.depth).padStart(3, "0")}\0${item.kind}\0${item.sourceId}\0${item.targetId}`;
}

function targetKey(item: ImpactTarget): string {
  return [
    String(item.minDepth).padStart(3, "0"),
    item.confirmed ? "0" : "1",
    item.boundaries.length > 0 ? "0" : "1",
    item.qualifiedName,
    item.id,
  ].join("\0");
}

function collectImpact(trace: TraceResult, input: ImpactCodeInput): {
  affected: ImpactTarget[];
  relations: ImpactRelation[];
} {
  const nodeById = new Map(trace.nodes.map((node) => [node.id, node]));
  nodeById.set(trace.start.id, trace.start);
  const targets = new Map<string, MutableTarget>();
  const relations = trace.edges
    .filter((edge) => edge.status !== "rejected")
    .map(relation)
    .sort((left, right) => relationKey(left).localeCompare(relationKey(right)));

  for (const edge of trace.edges) {
    if (edge.status === "rejected") continue;
    const id = targetId(edge, input.direction);
    if (id === trace.start.id) continue;
    const node = nodeById.get(id);
    if (!node) continue;
    const current = targets.get(id) ?? {
      node,
      minDepth: edge.depth,
      confidence: 0,
      confirmed: false,
      statuses: new Set<EdgeStatus>(),
      relationKinds: new Set<CodeEdgeKind>(),
      boundaries: new Map<string, ImpactBoundary>(),
    };
    current.minDepth = Math.min(current.minDepth, edge.depth);
    current.confidence = Math.max(current.confidence, edge.confidence);
    current.confirmed ||= edge.status === "resolved" && edge.confidence >= 0.9;
    current.statuses.add(edge.status);
    current.relationKinds.add(edge.kind);
    for (const boundary of boundaryEvidence(edge.evidence)) {
      current.boundaries.set(boundaryKey(boundary), boundary);
    }
    targets.set(id, current);
  }

  const affected = [...targets.values()].map((target): ImpactTarget => ({
    ...impactNode(target.node),
    minDepth: target.minDepth,
    confidence: target.confidence,
    confirmed: target.confirmed,
    verificationRequired: !target.confirmed,
    crossLanguage: Boolean(
      trace.start.language && target.node.language && trace.start.language !== target.node.language,
    ),
    statuses: [...target.statuses].sort(),
    relationKinds: [...target.relationKinds].sort(),
    boundaries: [...target.boundaries.values()].sort((left, right) =>
      boundaryKey(left).localeCompare(boundaryKey(right))),
  })).sort((left, right) => targetKey(left).localeCompare(targetKey(right)));

  return { affected, relations };
}

export function buildImpactEnvelope(
  traceEnvelope: Envelope<TraceResult>,
  input: ImpactCodeInput,
): Envelope<ImpactData> {
  const scope: EnvelopeScope = {
    workspaceId: traceEnvelope.workspaceId,
    generation: traceEnvelope.generation,
    ...(traceEnvelope.snapshot ? { snapshot: traceEnvelope.snapshot } : {}),
  };
  const collected = collectImpact(traceEnvelope.data, input);
  const allBoundaries = new Map<string, ImpactBoundary>();
  for (const item of collected.relations.flatMap((entry) => entry.boundaries)) {
    allBoundaries.set(boundaryKey(item), item);
  }
  const baseSummary = {
    observedAffectedCount: collected.affected.length,
    confirmedCount: collected.affected.filter((item) => item.confirmed).length,
    verificationRequiredCount: collected.affected.filter((item) => item.verificationRequired).length,
    crossLanguageCount: collected.affected.filter((item) => item.crossLanguage).length,
    boundaryCount: allBoundaries.size,
    observedRelationCount: collected.relations.length,
    unresolvedCount: traceEnvelope.data.unresolved.length,
  };

  let affected = [...collected.affected];
  let relations = [...collected.relations];
  let unresolved = [...traceEnvelope.data.unresolved];
  let truncated = traceEnvelope.truncated;
  const warnings = [...new Set([
    ...traceEnvelope.warnings,
    "IMPACT_STATIC_GRAPH_ONLY: runtime reachability is not proven",
    ...(
      baseSummary.verificationRequiredCount > 0 || baseSummary.unresolvedCount > 0
        ? ["IMPACT_VERIFICATION_REQUIRED: candidate or unresolved paths require source verification"]
        : []
    ),
  ])];
  const makeData = (): ImpactData => ({
    start: impactNode(traceEnvelope.data.start),
    direction: input.direction,
    requestedDepth: input.depth,
    summary: {
      ...baseSummary,
      returnedAffectedCount: affected.length,
      returnedRelationCount: relations.length,
      returnedUnresolvedCount: unresolved.length,
    },
    affected,
    relations,
    unresolved,
  });

  while (!envelopeFits(scope, makeData(), warnings, truncated, input.tokenBudget)) {
    truncated = true;
    if (unresolved.length > 0) {
      unresolved = unresolved.slice(0, -1);
      continue;
    }
    if (relations.length > 0) {
      relations = relations.slice(0, -1);
      continue;
    }
    if (affected.length > 0) {
      affected = affected.slice(0, -1);
      continue;
    }
    throw new ContextMeshError(
      "INVALID_ARGUMENT",
      "tokenBudget is smaller than the minimum impact_code response envelope",
      { tokenBudget: input.tokenBudget },
    );
  }

  return stabilizeEnvelope(scope, makeData(), warnings, truncated);
}
