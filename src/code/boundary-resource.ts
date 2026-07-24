import type {
  CodeEdgeKind,
  CodeEdgeRecord,
  CodeEvidence,
  CodeNodeRecord,
  WorkspaceRecord,
} from "../contracts.js";
import { sha256 } from "../utils.js";

export type BoundaryProtocol = "http" | "rpc" | "queue" | "database";

export interface BoundaryResourceIdentity {
  protocol: BoundaryProtocol;
  operation: string;
  resource: string;
}

export function boundaryResourceKey(identity: BoundaryResourceIdentity): string {
  return `resource:${identity.protocol}:${identity.operation}:${identity.resource}`;
}

export function boundaryResourceNode(
  workspace: Pick<WorkspaceRecord, "id">,
  generation: number,
  identity: BoundaryResourceIdentity,
): CodeNodeRecord {
  const localKey = boundaryResourceKey(identity);
  const display = identity.protocol === "http"
    ? `${identity.operation.toUpperCase()} ${identity.resource}`
    : identity.resource;
  return {
    id: sha256(`${workspace.id}\0${localKey}`),
    workspaceId: workspace.id,
    fileId: null,
    kind: "resource",
    name: display,
    qualifiedName: localKey,
    localKey,
    signature: localKey,
    doc: "",
    isExported: false,
    startByte: 0,
    endByte: 0,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 1,
    contentHash: sha256(localKey),
    generation,
    metadata: {
      boundaryProtocol: identity.protocol,
      boundaryOperation: identity.operation,
      boundaryResource: identity.resource,
    },
    nativeKind: "boundary_resource",
    analysisLevel: "resolved",
  };
}

export function boundaryResourceEdge(input: {
  workspaceId: string;
  sourceId: string;
  targetId: string;
  kind: CodeEdgeKind;
  generation: number;
  evidence: CodeEvidence[];
  identity: BoundaryResourceIdentity;
}): CodeEdgeRecord {
  return {
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    targetId: input.targetId,
    kind: input.kind,
    confidence: 1,
    resolutionKind: "exact",
    generation: input.generation,
    metadata: {
      boundaryProtocol: input.identity.protocol,
      boundaryOperation: input.identity.operation,
      boundaryResource: input.identity.resource,
      boundaries: input.evidence.map((item) => item.details).filter(Boolean),
    },
    status: "resolved",
    evidence: input.evidence,
  };
}
