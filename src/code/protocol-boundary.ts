import type {
  CodeEdgeKind,
  CodeEdgeRecord,
  CodeNodeRecord,
  IndexedSourceFile,
  UnresolvedReferenceRecord,
} from "../contracts.js";

export const PROTOCOL_BOUNDARY_PROVIDER = "contextmesh_protocol_boundary";
export const PROTOCOL_BOUNDARY_PROVIDER_VERSION = "rpc-queue-db-literal-v1";

const CALLABLE_KINDS = new Set(["function", "method"]);
const MAX_DIAGNOSTICS = 100;

type Protocol = "rpc" | "queue" | "database";
type Role = "client" | "server" | "producer" | "consumer" | "writer" | "reader";

interface SourcePosition {
  startByte: number;
  endByte: number;
  line: number;
  column: number;
}

interface Endpoint extends SourcePosition {
  protocol: Protocol;
  role: Role;
  operation: string;
  resource: string;
  file: IndexedSourceFile;
  owner: CodeNodeRecord;
}

export interface ProtocolBoundaryResult {
  edges: CodeEdgeRecord[];
  unresolvedReferences: UnresolvedReferenceRecord[];
  diagnostics: string[];
}

function maskComments(source: string, language: IndexedSourceFile["language"]): string {
  const output = source.split("");
  const python = language === "python";
  let quote: "'" | "\"" | "`" | "'''" | "\"\"\"" | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1] ?? "";
    if (lineComment) {
      if (character === "\n" || character === "\r") lineComment = false;
      else output[index] = " ";
      continue;
    }
    if (blockComment) {
      output[index] = character === "\n" || character === "\r" ? character : " ";
      if (character === "*" && next === "/") {
        output[index + 1] = " ";
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (source.startsWith(quote, index)) {
        index += quote.length - 1;
        quote = null;
      } else if (quote.length === 1 && character === "\\") {
        index += 1;
      }
      continue;
    }
    if (python && (source.startsWith("'''", index) || source.startsWith("\"\"\"", index))) {
      quote = source.startsWith("'''", index) ? "'''" : "\"\"\"";
      index += 2;
      continue;
    }
    if (character === "'" || character === "\"" || character === "`") {
      quote = character;
      continue;
    }
    if (python && character === "#") {
      output[index] = " ";
      lineComment = true;
      continue;
    }
    if (!python && character === "/" && next === "/") {
      output[index] = " ";
      output[index + 1] = " ";
      lineComment = true;
      index += 1;
      continue;
    }
    if (!python && character === "/" && next === "*") {
      output[index] = " ";
      output[index + 1] = " ";
      blockComment = true;
      index += 1;
    }
  }
  return output.join("");
}

function sourcePosition(source: string, start: number, end: number): SourcePosition {
  const before = source.slice(0, start);
  const lineStart = Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r")) + 1;
  return {
    startByte: Buffer.byteLength(before, "utf8"),
    endByte: Buffer.byteLength(source.slice(0, end), "utf8"),
    line: before.split(/\r\n|\r|\n/).length,
    column: Buffer.byteLength(source.slice(lineStart, start), "utf8") + 1,
  };
}

function callableNodes(file: IndexedSourceFile, nodes: CodeNodeRecord[]): CodeNodeRecord[] {
  return nodes.filter((node) => node.fileId === file.id && CALLABLE_KINDS.has(node.kind));
}

function containingOwner(file: IndexedSourceFile, nodes: CodeNodeRecord[], byteOffset: number): CodeNodeRecord | null {
  const callable = callableNodes(file, nodes)
    .filter((node) => node.startByte <= byteOffset && node.endByte >= byteOffset)
    .sort((left, right) =>
      (left.endByte - left.startByte) - (right.endByte - right.startByte) ||
      right.startByte - left.startByte || left.id.localeCompare(right.id));
  if (callable[0]) return callable[0];
  return nodes
    .filter((node) => node.fileId === file.id && node.kind === "module")
    .sort((left, right) => left.id.localeCompare(right.id))[0] ?? null;
}

function namedOwner(file: IndexedSourceFile, nodes: CodeNodeRecord[], name: string): CodeNodeRecord | null {
  const local = callableNodes(file, nodes).filter((node) => node.name === name);
  return local.length === 1 ? local[0]! : null;
}

function normalizeNamedResource(value: string): string | null {
  const normalized = value.trim().normalize("NFC");
  if (
    normalized.length === 0 ||
    normalized.length > 240 ||
    normalized.includes("\\") ||
    /\$\{|[{}<>*\s]/.test(normalized) ||
    !/^[A-Za-z0-9._:/-]+$/.test(normalized)
  ) return null;
  return normalized;
}

function literalIsComplete(source: string, end: number): boolean {
  const suffix = source.slice(end, Math.min(source.length, end + 64)).trimStart();
  return suffix.startsWith(")") || suffix.startsWith(",");
}

function addNamedEndpoint(
  target: Endpoint[],
  protocol: "rpc" | "queue",
  role: Role,
  operation: string,
  rawResource: string,
  file: IndexedSourceFile,
  owner: CodeNodeRecord | null,
  source: string,
  start: number,
  end: number,
  initiating: boolean,
): boolean {
  const resource = normalizeNamedResource(rawResource);
  if (!resource || !owner || (initiating && !literalIsComplete(source, end))) return false;
  target.push({
    protocol,
    role,
    operation,
    resource,
    file,
    owner,
    ...sourcePosition(source, start, end),
  });
  return true;
}

function reportMissingHandler(
  diagnostics: string[],
  protocol: "rpc" | "queue",
  file: IndexedSourceFile,
  handler: string,
  rawResource: string,
  owner: CodeNodeRecord | null,
): void {
  if (diagnostics.length >= MAX_DIAGNOSTICS || !normalizeNamedResource(rawResource) || owner) return;
  diagnostics.push(`${protocol.toUpperCase()}_BOUNDARY_HANDLER_UNRESOLVED: ${file.relativePath}:${handler}`);
}

function extractNamedEndpoints(
  file: IndexedSourceFile,
  nodes: CodeNodeRecord[],
  masked: string,
  endpoints: Endpoint[],
  diagnostics: string[],
): void {
  const rpcServer = /\b(?:rpc|rpcServer|rpc_server)\s*\.\s*(?:register|handle|method|registerMethod)\s*\(\s*(["'])([^"'\\\r\n]+)\1\s*,\s*([A-Za-z_$][\w$]*)/gi;
  for (const match of masked.matchAll(rpcServer)) {
    const owner = namedOwner(file, nodes, match[3]!);
    if (!addNamedEndpoint(endpoints, "rpc", "server", "handle", match[2]!, file, owner,
      file.content, match.index!, match.index! + match[0].length, false)) {
      reportMissingHandler(diagnostics, "rpc", file, match[3]!, match[2]!, owner);
    }
  }
  const rpcDecorator = /@(?:rpc|rpc_server)\s*\.\s*(?:method|handler)\s*\(\s*(["'])([^"'\\\r\n]+)\1\s*\)\s*\r?\n[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)/gi;
  for (const match of masked.matchAll(rpcDecorator)) {
    const owner = namedOwner(file, nodes, match[3]!);
    if (!addNamedEndpoint(endpoints, "rpc", "server", "handle", match[2]!, file, owner,
      file.content, match.index!, match.index! + match[0].length, false)) {
      reportMissingHandler(diagnostics, "rpc", file, match[3]!, match[2]!, owner);
    }
  }
  const rpcClient = /\b(?:rpc|rpcClient|rpc_client)\s*\.\s*(?:call|request|invoke)\s*\(\s*(["'])([^"'\\\r\n]+)\1/gi;
  for (const match of masked.matchAll(rpcClient)) {
    const position = sourcePosition(file.content, match.index!, match.index! + match[0].length);
    addNamedEndpoint(endpoints, "rpc", "client", "call", match[2]!, file,
      containingOwner(file, nodes, position.startByte), file.content,
      match.index!, match.index! + match[0].length, true);
  }

  const queueConsumer = /\b(?:queue|broker|consumer)\s*\.\s*(?:subscribe|consume|handle|on)\s*\(\s*(["'])([^"'\\\r\n]+)\1\s*,\s*([A-Za-z_$][\w$]*)/gi;
  for (const match of masked.matchAll(queueConsumer)) {
    const owner = namedOwner(file, nodes, match[3]!);
    if (!addNamedEndpoint(endpoints, "queue", "consumer", "consume", match[2]!, file, owner,
      file.content, match.index!, match.index! + match[0].length, false)) {
      reportMissingHandler(diagnostics, "queue", file, match[3]!, match[2]!, owner);
    }
  }
  const queueDecorator = /@(?:queue|broker)\s*\.\s*(?:consumer|subscribe|handler)\s*\(\s*(["'])([^"'\\\r\n]+)\1\s*\)\s*\r?\n[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)/gi;
  for (const match of masked.matchAll(queueDecorator)) {
    const owner = namedOwner(file, nodes, match[3]!);
    if (!addNamedEndpoint(endpoints, "queue", "consumer", "consume", match[2]!, file, owner,
      file.content, match.index!, match.index! + match[0].length, false)) {
      reportMissingHandler(diagnostics, "queue", file, match[3]!, match[2]!, owner);
    }
  }
  const queueProducer = /\b(?:queue|broker|producer)\s*\.\s*(?:publish|send|emit|produce)\s*\(\s*(["'])([^"'\\\r\n]+)\1/gi;
  for (const match of masked.matchAll(queueProducer)) {
    const position = sourcePosition(file.content, match.index!, match.index! + match[0].length);
    addNamedEndpoint(endpoints, "queue", "producer", "publish", match[2]!, file,
      containingOwner(file, nodes, position.startByte), file.content,
      match.index!, match.index! + match[0].length, true);
  }
}

function normalizeSqlResource(value: string): string | null {
  const normalized = value.trim().replaceAll('"', "").replaceAll("`", "").toLocaleLowerCase("en-US");
  return /^[a-z_][a-z0-9_$]*(?:\.[a-z_][a-z0-9_$]*)?$/.test(normalized) ? normalized : null;
}

function classifySql(value: string): { role: "writer" | "reader"; operation: string; resource: string } | null {
  const compact = value.replace(/\s+/g, " ").trim();
  const statements = compact.split(";").map((item) => item.trim()).filter(Boolean);
  if (statements.length !== 1) return null;
  const statement = statements[0]!;
  const read = statement.match(/^select\b[\s\S]*?\bfrom\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)/i);
  if (read) {
    const resource = normalizeSqlResource(read[1]!);
    return resource ? { role: "reader", operation: "read", resource } : null;
  }
  for (const [operation, expression] of [
    ["insert", /^insert\s+into\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)/i],
    ["update", /^update\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)/i],
    ["delete", /^delete\s+from\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)/i],
  ] as const) {
    const match = statement.match(expression);
    if (!match) continue;
    const resource = normalizeSqlResource(match[1]!);
    return resource ? { role: "writer", operation, resource } : null;
  }
  return null;
}

function extractSqlEndpoints(file: IndexedSourceFile, nodes: CodeNodeRecord[], masked: string, endpoints: Endpoint[]): void {
  const patterns = [
    /'([^'\\\r\n]{1,4000})'/g,
    /"([^"\\\r\n]{1,4000})"/g,
    /`([^`\\]{1,4000})`/g,
  ];
  for (const pattern of patterns) {
    for (const match of masked.matchAll(pattern)) {
      const classified = classifySql(match[1]!);
      if (!classified) continue;
      const position = sourcePosition(file.content, match.index!, match.index! + match[0].length);
      const owner = containingOwner(file, nodes, position.startByte);
      if (!owner) continue;
      endpoints.push({
        protocol: "database",
        role: classified.role,
        operation: classified.operation,
        resource: classified.resource,
        file,
        owner,
        ...position,
      });
    }
  }
}

function endpointKey(item: Endpoint): string {
  return [
    item.protocol,
    item.role,
    item.operation,
    item.resource,
    item.file.pathKey,
    String(item.startByte).padStart(12, "0"),
    item.owner.id,
  ].join("\0");
}

function extractEndpoints(files: IndexedSourceFile[], nodes: CodeNodeRecord[]): {
  endpoints: Endpoint[];
  diagnostics: string[];
} {
  const endpoints: Endpoint[] = [];
  const diagnostics: string[] = [];
  for (const file of [...files].sort((left, right) => left.pathKey.localeCompare(right.pathKey))) {
    if (!["typescript", "tsx", "javascript", "jsx", "mjs", "cjs", "python", "go", "rust"].includes(file.language)) continue;
    const masked = maskComments(file.content, file.language);
    extractNamedEndpoints(file, nodes, masked, endpoints, diagnostics);
    extractSqlEndpoints(file, nodes, masked, endpoints);
  }
  const unique = new Map(endpoints.map((item) => [endpointKey(item), item]));
  return {
    endpoints: [...unique.values()].sort((left, right) => endpointKey(left).localeCompare(endpointKey(right))),
    diagnostics: [...new Set(diagnostics)].sort(),
  };
}

function endpointSpan(endpoint: Endpoint): SourcePosition {
  return {
    startByte: endpoint.startByte,
    endByte: endpoint.endByte,
    line: endpoint.line,
    column: endpoint.column,
  };
}

function boundaryEvidence(source: Endpoint, target: Endpoint): NonNullable<CodeEdgeRecord["evidence"]>[number] {
  return {
    provider: PROTOCOL_BOUNDARY_PROVIDER,
    providerVersion: PROTOCOL_BOUNDARY_PROVIDER_VERSION,
    source: "resolver",
    confidence: 1,
    sourceSpan: endpointSpan(source),
    details: {
      boundaryProvider: PROTOCOL_BOUNDARY_PROVIDER,
      boundaryProviderVersion: PROTOCOL_BOUNDARY_PROVIDER_VERSION,
      boundaryProtocol: source.protocol,
      boundaryOperation: source.protocol === "database" ? `${source.operation}_to_${target.operation}` : source.operation,
      boundaryResource: source.resource,
      sourceRole: source.role,
      sourceLanguage: source.file.language,
      sourceFile: source.file.relativePath,
      sourceSpan: endpointSpan(source),
      targetRole: target.role,
      targetLanguage: target.file.language,
      targetFile: target.file.relativePath,
      targetSourceSpan: endpointSpan(target),
    },
  };
}

function evidenceKey(item: NonNullable<CodeEdgeRecord["evidence"]>[number]): string {
  return `${item.provider}\0${item.providerVersion}\0${JSON.stringify(item.sourceSpan)}\0${JSON.stringify(item.details)}`;
}

function addPair(
  pairs: Map<string, { source: Endpoint; target: Endpoint; kind: CodeEdgeKind; evidence: NonNullable<CodeEdgeRecord["evidence"]> }>,
  source: Endpoint,
  target: Endpoint,
  kind: CodeEdgeKind,
): void {
  const key = `${source.owner.id}\0${target.owner.id}\0${kind}`;
  const item = boundaryEvidence(source, target);
  const prior = pairs.get(key);
  if (prior) {
    prior.evidence = [...new Map([...prior.evidence, item].map((entry) => [evidenceKey(entry), entry])).values()]
      .sort((left, right) => evidenceKey(left).localeCompare(evidenceKey(right)));
  } else {
    pairs.set(key, { source, target, kind, evidence: [item] });
  }
}

function unresolved(
  source: Endpoint,
  kind: string,
  candidates: Endpoint[],
): UnresolvedReferenceRecord {
  const candidateIds = [...new Set(candidates.map((item) => item.owner.id))].sort();
  return {
    workspaceId: source.file.workspaceId,
    fileId: source.file.id,
    sourceNodeId: source.owner.id,
    kind,
    rawName: `${source.operation.toUpperCase()} ${source.resource}`,
    qualifier: source.protocol,
    line: source.line,
    column: source.column,
    candidates: candidateIds,
    generation: source.file.generation,
    confidence: candidateIds.length > 1 ? 0.5 : 0,
    evidence: [{
      provider: PROTOCOL_BOUNDARY_PROVIDER,
      providerVersion: PROTOCOL_BOUNDARY_PROVIDER_VERSION,
      source: "resolver",
      confidence: candidateIds.length > 1 ? 0.5 : 0,
      sourceSpan: endpointSpan(source),
      details: {
        boundaryProvider: PROTOCOL_BOUNDARY_PROVIDER,
        boundaryProviderVersion: PROTOCOL_BOUNDARY_PROVIDER_VERSION,
        boundaryProtocol: source.protocol,
        boundaryOperation: source.operation,
        boundaryResource: source.resource,
        sourceRole: source.role,
        sourceLanguage: source.file.language,
        sourceFile: source.file.relativePath,
        sourceSpan: endpointSpan(source),
        candidateCount: candidateIds.length,
      },
    }],
  };
}

export function linkProtocolBoundaries(
  files: IndexedSourceFile[],
  nodes: CodeNodeRecord[],
): ProtocolBoundaryResult {
  const extracted = extractEndpoints(files, nodes);
  const pairs = new Map<string, {
    source: Endpoint;
    target: Endpoint;
    kind: CodeEdgeKind;
    evidence: NonNullable<CodeEdgeRecord["evidence"]>;
  }>();
  const unresolvedReferences: UnresolvedReferenceRecord[] = [];

  const rpcClients = extracted.endpoints.filter((item) => item.protocol === "rpc" && item.role === "client");
  const rpcServers = extracted.endpoints.filter((item) => item.protocol === "rpc" && item.role === "server");
  for (const client of rpcClients) {
    const candidates = rpcServers.filter((server) =>
      server.resource === client.resource && server.file.language !== client.file.language);
    const uniqueTargets = new Map(candidates.map((item) => [item.owner.id, item]));
    if (uniqueTargets.size === 1) addPair(pairs, client, [...uniqueTargets.values()][0]!, "CALLS");
    else unresolvedReferences.push(unresolved(client, "RPC_BOUNDARY_CALL", [...uniqueTargets.values()]));
  }

  const producers = extracted.endpoints.filter((item) => item.protocol === "queue" && item.role === "producer");
  const consumers = extracted.endpoints.filter((item) => item.protocol === "queue" && item.role === "consumer");
  for (const producer of producers) {
    const targets = new Map(consumers
      .filter((consumer) => consumer.resource === producer.resource && consumer.file.language !== producer.file.language)
      .map((item) => [item.owner.id, item]));
    if (targets.size === 0) unresolvedReferences.push(unresolved(producer, "QUEUE_BOUNDARY_PUBLISH", []));
    else for (const target of targets.values()) addPair(pairs, producer, target, "CALLS");
  }

  const writers = extracted.endpoints.filter((item) => item.protocol === "database" && item.role === "writer");
  const readers = extracted.endpoints.filter((item) => item.protocol === "database" && item.role === "reader");
  for (const writer of writers) {
    const targets = new Map(readers
      .filter((reader) => reader.resource === writer.resource && reader.file.language !== writer.file.language)
      .map((item) => [item.owner.id, item]));
    if (targets.size === 0) unresolvedReferences.push(unresolved(writer, "DATABASE_BOUNDARY_WRITE", []));
    else for (const target of targets.values()) addPair(pairs, writer, target, "REFERENCES");
  }

  const edges = [...pairs.values()].map(({ source, target, kind, evidence }) => ({
    workspaceId: source.file.workspaceId,
    sourceId: source.owner.id,
    targetId: target.owner.id,
    kind,
    confidence: 1,
    resolutionKind: "exact" as const,
    generation: source.file.generation,
    metadata: {
      boundaryProtocol: source.protocol,
      boundaries: evidence.map((item) => item.details).filter(Boolean),
    },
    status: "resolved" as const,
    evidence,
  })).sort((left, right) =>
    `${left.kind}\0${left.sourceId}\0${left.targetId}`.localeCompare(`${right.kind}\0${right.sourceId}\0${right.targetId}`));

  const unresolvedKey = (item: UnresolvedReferenceRecord): string =>
    `${item.fileId}\0${item.sourceNodeId ?? ""}\0${item.kind}\0${item.rawName}\0${item.line}\0${item.column}`;
  unresolvedReferences.sort((left, right) => unresolvedKey(left).localeCompare(unresolvedKey(right)));
  return { edges, unresolvedReferences, diagnostics: extracted.diagnostics };
}
