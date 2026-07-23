import type { CodeEdgeKind, CodeEdgeRecord, UnresolvedReferenceRecord } from "../contracts.js";
import type { ContextMeshStorage, TraceResult } from "../storage/database.js";
import type { CodeSearchResult } from "../storage/database.js";
import { HTTP_BOUNDARY_PROVIDER, HTTP_BOUNDARY_PROVIDER_VERSION } from "./boundary.js";

interface CacheEntry<T> { value: T; used: number }

function edgeKey(edge: Pick<CodeEdgeRecord, "sourceId" | "targetId" | "kind">): string {
  return `${edge.kind}\0${edge.sourceId}\0${edge.targetId}`;
}

function boundaryEvidence(edge: CodeEdgeRecord): CodeEdgeRecord["evidence"] {
  const values = Array.isArray(edge.metadata.boundaries) ? edge.metadata.boundaries : [];
  return values.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const details = value as Record<string, unknown>;
    const sourceSpan = details.clientSourceSpan;
    return [{
      provider: HTTP_BOUNDARY_PROVIDER,
      providerVersion: HTTP_BOUNDARY_PROVIDER_VERSION,
      source: "resolver" as const,
      confidence: 1,
      ...(sourceSpan && typeof sourceSpan === "object" && !Array.isArray(sourceSpan)
        ? { sourceSpan: sourceSpan as NonNullable<NonNullable<CodeEdgeRecord["evidence"]>[number]["sourceSpan"]> }
        : {}),
      details,
    }];
  });
}

function crossLanguageBoundaryEdges(database: ContextMeshStorage): CodeEdgeRecord[] {
  return database.getExistingRelations().edges.flatMap(({ edge }) => {
    if (edge.metadata.boundaryProtocol !== "http" || !Array.isArray(edge.metadata.boundaries)) return [];
    return [{
      ...edge,
      status: "resolved" as const,
      evidence: boundaryEvidence(edge),
    }];
  });
}

export class GenerationGraphCache {
  private generation = -1;
  private precisionRevision = -1;
  private tick = 0;
  private readonly searchEntries = new Map<string, CacheEntry<unknown>>();
  private readonly traceEntries = new Map<string, CacheEntry<TraceResult>>();
  private forward = new Map<string, readonly CodeEdgeRecord[]>();
  private reverse = new Map<string, readonly CodeEdgeRecord[]>();
  private nodes = new Map<string, CodeSearchResult>();
  private unresolved = new Map<string, readonly UnresolvedReferenceRecord[]>();

  constructor(private readonly database: ContextMeshStorage, private readonly capacity = 128) { this.hydrate(); }

  hydrate(): void {
    const generation = this.database.getWorkspace().currentGeneration;
    const precisionRevision = this.database.getPrecisionRevision();
    if (generation === this.generation && precisionRevision === this.precisionRevision) return;
    const partitions = [this.database.getStoredGraphPartition("non-python"), this.database.getStoredGraphPartition("python")];
    const effectiveEdges = new Map<string, CodeEdgeRecord>();
    for (const edge of [
      ...partitions.flatMap((partition) => partition.edges),
      ...crossLanguageBoundaryEdges(this.database),
    ]) effectiveEdges.set(edgeKey(edge), edge);
    const forward = new Map<string, CodeEdgeRecord[]>();
    const reverse = new Map<string, CodeEdgeRecord[]>();
    for (const edge of effectiveEdges.values()) {
      const out = forward.get(edge.sourceId) ?? []; out.push(edge); forward.set(edge.sourceId, out);
      const incoming = reverse.get(edge.targetId) ?? []; incoming.push(edge); reverse.set(edge.targetId, incoming);
    }
    const order = (left: CodeEdgeRecord, right: CodeEdgeRecord): number => edgeKey(left).localeCompare(edgeKey(right));
    for (const edges of forward.values()) edges.sort(order);
    for (const edges of reverse.values()) edges.sort(order);
    const nodeRecords = partitions.flatMap((partition) => partition.nodes);
    const hydratedNodes: CodeSearchResult[] = [];
    for (let offset = 0; offset < nodeRecords.length; offset += 500) hydratedNodes.push(...this.database.getCodeNodesByIds(nodeRecords.slice(offset, offset + 500).map((node) => node.id)));
    const unresolved = new Map<string, UnresolvedReferenceRecord[]>();
    for (const item of partitions.flatMap((partition) => partition.unresolvedReferences)) if (item.sourceNodeId) {
      const values = unresolved.get(item.sourceNodeId) ?? []; values.push(item); unresolved.set(item.sourceNodeId, values);
    }
    for (const values of unresolved.values()) values.sort((a, b) => a.line - b.line || a.column - b.column || a.rawName.localeCompare(b.rawName));
    // Replace every generation-owned structure together only after the durable commit is visible.
    this.forward = forward; this.reverse = reverse; this.nodes = new Map(hydratedNodes.map((node) => [node.id, node])); this.unresolved = unresolved; this.generation = generation; this.precisionRevision = precisionRevision;
    this.searchEntries.clear(); this.traceEntries.clear(); this.tick = 0;
  }

  search<T>(key: string, load: () => T): T {
    return this.cached(this.searchEntries, `${this.generation}\0${this.precisionRevision}\0${key}`, load) as T;
  }

  trace(key: string, load: () => TraceResult): TraceResult {
    return this.cached(this.traceEntries, `${this.generation}\0${this.precisionRevision}\0${key}`, load);
  }

  traceGraph(symbolId: string, direction: "in" | "out" | "both", edgeKinds: CodeEdgeKind[] | undefined, maxDepth: number, limit: number): TraceResult | null {
    const startValue = this.nodes.get(symbolId);
    if (!startValue) return null;
    const start = { ...startValue, score: 1 };
    const nodes = new Map<string, CodeSearchResult>([[start.id, start]]); const edges: TraceResult["edges"] = [];
    const visited = new Set<string>([start.id]); const queue: Array<{ id: string; depth: number }> = [{ id: start.id, depth: 0 }];
    const allowed = edgeKinds ? new Set(edgeKinds) : null;
    while (queue.length > 0 && edges.length < limit) {
      const current = queue.shift(); if (!current || current.depth >= maxDepth) continue;
      const candidates = direction === "out" ? [...(this.forward.get(current.id) ?? [])]
        : direction === "in" ? [...(this.reverse.get(current.id) ?? [])]
          : [...(this.forward.get(current.id) ?? []), ...(this.reverse.get(current.id) ?? [])];
      const unique = new Map(candidates.filter((edge) => !allowed || allowed.has(edge.kind)).map((edge) => [edgeKey(edge), edge]));
      for (const edge of [...unique.values()].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)))) {
        if (edges.length >= limit) break;
        const nextId = edge.sourceId === current.id ? edge.targetId : edge.sourceId;
        edges.push({ sourceId: edge.sourceId, targetId: edge.targetId, kind: edge.kind, confidence: edge.confidence, resolutionKind: edge.resolutionKind,
          depth: current.depth + 1, status: edge.status ?? "resolved", evidence: edge.evidence });
        if (!visited.has(nextId)) {
          const next = this.nodes.get(nextId);
          if (next) nodes.set(nextId, { ...next, score: 1 });
          if (edge.status !== "rejected") {
            visited.add(nextId);
            queue.push({ id: nextId, depth: current.depth + 1 });
          }
        }
      }
    }
    const unresolved = [...visited].flatMap((id) => this.unresolved.get(id) ?? []).sort((a, b) => a.line - b.line || a.column - b.column).slice(0, 100)
      .map((item) => ({ sourceNodeId: item.sourceNodeId, kind: item.kind, rawName: item.rawName, line: item.line, column: item.column, confidence: item.confidence ?? 0.5, evidence: item.evidence }));
    return { start, nodes: [...nodes.values()], edges, unresolved, truncated: edges.length >= limit };
  }

  stats(): { generation: number; forwardNodes: number; reverseNodes: number; searchEntries: number; traceEntries: number } {
    return { generation: this.generation, forwardNodes: this.forward.size, reverseNodes: this.reverse.size, searchEntries: this.searchEntries.size, traceEntries: this.traceEntries.size };
  }

  private cached<T>(entries: Map<string, CacheEntry<T>>, key: string, load: () => T): T {
    const existing = entries.get(key);
    if (existing) { existing.used = ++this.tick; return structuredClone(existing.value); }
    const value = load(); entries.set(key, { value: structuredClone(value), used: ++this.tick });
    if (entries.size > this.capacity) {
      const oldest = [...entries].sort((a, b) => a[1].used - b[1].used || a[0].localeCompare(b[0]))[0];
      if (oldest) entries.delete(oldest[0]);
    }
    return value;
  }
}
