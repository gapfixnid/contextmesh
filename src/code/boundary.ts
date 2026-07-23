import type {
  CodeEdgeRecord,
  CodeNodeRecord,
  IndexedSourceFile,
  UnresolvedReferenceRecord,
} from "../contracts.js";

export const HTTP_BOUNDARY_PROVIDER = "contextmesh_http_boundary";
export const HTTP_BOUNDARY_PROVIDER_VERSION = "http-literal-v1";

const CALLABLE_KINDS = new Set(["function", "method"]);
const HTTP_METHOD = "(?:get|post|put|patch|delete|options|head)";
const MAX_DIAGNOSTICS = 100;

interface SourcePosition {
  startByte: number;
  endByte: number;
  line: number;
  column: number;
}

interface HttpEndpoint extends SourcePosition {
  role: "client" | "server";
  method: string;
  path: string;
  file: IndexedSourceFile;
  owner: CodeNodeRecord;
}

export interface HttpBoundaryResult {
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
        continue;
      }
      if (quote.length === 1 && character === "\\") index += 1;
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
  const lineStart = Math.max(source.lastIndexOf("\n", Math.max(0, start - 1)), source.lastIndexOf("\r", Math.max(0, start - 1))) + 1;
  const line = source.slice(0, start).split(/\r\n|\r|\n/).length;
  return {
    startByte: Buffer.byteLength(source.slice(0, start), "utf8"),
    endByte: Buffer.byteLength(source.slice(0, end), "utf8"),
    line,
    column: Buffer.byteLength(source.slice(lineStart, start), "utf8") + 1,
  };
}

function normalizeStaticPath(value: string): string | null {
  if (!value || value.includes("\\") || /\$\{|[{}<>*]/.test(value)) return null;
  let normalized = value.trim();
  if (/^https?:\/\//i.test(normalized)) {
    try {
      normalized = new URL(normalized).pathname;
    } catch {
      return null;
    }
  } else {
    normalized = normalized.split(/[?#]/, 1)[0] ?? "";
  }
  if (!normalized.startsWith("/") || /(^|\/)[:][^/]+/.test(normalized)) return null;
  normalized = normalized.replace(/\/{2,}/g, "/");
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, "");
  return normalized || "/";
}

function normalizeMethod(value: string): string {
  return value.toUpperCase();
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

function namedOwner(
  file: IndexedSourceFile,
  nodes: CodeNodeRecord[],
  name: string,
): CodeNodeRecord | null {
  const local = callableNodes(file, nodes).filter((node) => node.name === name);
  if (local.length === 1) return local[0]!;
  if (local.length > 1) return null;
  const sameLanguage = nodes.filter((node) =>
    CALLABLE_KINDS.has(node.kind) && node.name === name && node.language === file.language);
  return sameLanguage.length === 1 ? sameLanguage[0]! : null;
}

function literalPath(value: string): string | null {
  return value.includes("\\") ? null : normalizeStaticPath(value);
}

function addEndpoint(
  target: HttpEndpoint[],
  role: HttpEndpoint["role"],
  method: string,
  rawPath: string,
  file: IndexedSourceFile,
  owner: CodeNodeRecord | null,
  source: string,
  start: number,
  end: number,
): boolean {
  const path = literalPath(rawPath);
  if (!path || !owner) return false;
  target.push({ role, method: normalizeMethod(method), path, file, owner, ...sourcePosition(source, start, end) });
  return true;
}

function callWindow(source: string, start: number, maximum = 400): string {
  const bounded = source.slice(start, Math.min(source.length, start + maximum));
  const close = bounded.indexOf(")");
  return close >= 0 ? bounded.slice(0, close + 1) : bounded;
}

function extractJavaScript(
  file: IndexedSourceFile,
  nodes: CodeNodeRecord[],
  masked: string,
  clients: HttpEndpoint[],
  servers: HttpEndpoint[],
  diagnostics: string[],
): void {
  const server = new RegExp(
    `\\b(?:app|router|server|fastify)\\s*\\.\\s*(${HTTP_METHOD})\\s*\\(\\s*([\"'])([^\"'\\\\\\r\\n]+)\\2\\s*,\\s*([A-Za-z_$][\\w$]*)`,
    "gi",
  );
  for (const match of masked.matchAll(server)) {
    const owner = namedOwner(file, nodes, match[4]!);
    if (!addEndpoint(servers, "server", match[1]!, match[3]!, file, owner, file.content, match.index!, match.index! + match[0].length)) {
      if (diagnostics.length < MAX_DIAGNOSTICS && literalPath(match[3]!) && !owner) {
        diagnostics.push(`HTTP_BOUNDARY_SERVER_HANDLER_UNRESOLVED: ${file.relativePath}:${match[4]}`);
      }
    }
  }

  const fetchCall = /\bfetch\s*\(\s*(["'])([^"'\\\r\n]+)\1/gi;
  for (const match of masked.matchAll(fetchCall)) {
    const position = sourcePosition(file.content, match.index!, match.index! + match[0].length);
    const owner = containingOwner(file, nodes, position.startByte);
    const method = callWindow(masked, match.index!).match(/\bmethod\s*:\s*["'](get|post|put|patch|delete|options|head)["']/i)?.[1] ?? "GET";
    addEndpoint(clients, "client", method, match[2]!, file, owner, file.content, match.index!, match.index! + match[0].length);
  }

  const axiosCall = new RegExp(
    `\\b(?:axios|ky)\\s*\\.\\s*(${HTTP_METHOD})\\s*\\(\\s*([\"'])([^\"'\\\\\\r\\n]+)\\2`,
    "gi",
  );
  for (const match of masked.matchAll(axiosCall)) {
    const position = sourcePosition(file.content, match.index!, match.index! + match[0].length);
    addEndpoint(clients, "client", match[1]!, match[3]!, file,
      containingOwner(file, nodes, position.startByte), file.content, match.index!, match.index! + match[0].length);
  }
}

function extractPython(
  file: IndexedSourceFile,
  nodes: CodeNodeRecord[],
  masked: string,
  clients: HttpEndpoint[],
  servers: HttpEndpoint[],
  diagnostics: string[],
): void {
  const decorator = new RegExp(
    `@(?:app|router|blueprint)\\s*\\.\\s*(${HTTP_METHOD})\\s*\\(\\s*([\"'])([^\"'\\\\\\r\\n]+)\\2[^\\r\\n]*\\)\\s*\\r?\\n[ \\t]*(?:async[ \\t]+)?def[ \\t]+([A-Za-z_]\\w*)`,
    "gi",
  );
  for (const match of masked.matchAll(decorator)) {
    const owner = namedOwner(file, nodes, match[4]!);
    if (!addEndpoint(servers, "server", match[1]!, match[3]!, file, owner, file.content, match.index!, match.index! + match[0].length)) {
      if (diagnostics.length < MAX_DIAGNOSTICS && literalPath(match[3]!) && !owner) {
        diagnostics.push(`HTTP_BOUNDARY_SERVER_HANDLER_UNRESOLVED: ${file.relativePath}:${match[4]}`);
      }
    }
  }

  const route = /@(?:app|router|blueprint)\s*\.\s*route\s*\(\s*(["'])([^"'\\\r\n]+)\1([^\r\n]*)\)\s*\r?\n[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)/gi;
  for (const match of masked.matchAll(route)) {
    const methodsSource = match[3]?.match(/methods\s*=\s*\[([^\]]*)\]/i)?.[1] ?? "";
    const methods = [...methodsSource.matchAll(/["']([A-Za-z]+)["']/g)].map((item) => item[1]!);
    const owner = namedOwner(file, nodes, match[4]!);
    for (const method of methods.length > 0 ? methods : ["ANY"]) {
      if (!addEndpoint(servers, "server", method, match[2]!, file, owner, file.content, match.index!, match.index! + match[0].length) &&
          diagnostics.length < MAX_DIAGNOSTICS && literalPath(match[2]!) && !owner) {
        diagnostics.push(`HTTP_BOUNDARY_SERVER_HANDLER_UNRESOLVED: ${file.relativePath}:${match[4]}`);
      }
    }
  }

  const client = new RegExp(
    `\\b(?:requests|httpx)\\s*\\.\\s*(${HTTP_METHOD})\\s*\\(\\s*([\"'])([^\"'\\\\\\r\\n]+)\\2`,
    "gi",
  );
  for (const match of masked.matchAll(client)) {
    const position = sourcePosition(file.content, match.index!, match.index! + match[0].length);
    addEndpoint(clients, "client", match[1]!, match[3]!, file,
      containingOwner(file, nodes, position.startByte), file.content, match.index!, match.index! + match[0].length);
  }
}

function extractGo(
  file: IndexedSourceFile,
  nodes: CodeNodeRecord[],
  masked: string,
  clients: HttpEndpoint[],
  servers: HttpEndpoint[],
  diagnostics: string[],
): void {
  const handle = /\b(?:http\.)?HandleFunc\s*\(\s*"([^"\\\r\n]+)"\s*,\s*([A-Za-z_]\w*)/g;
  for (const match of masked.matchAll(handle)) {
    const owner = namedOwner(file, nodes, match[2]!);
    if (!addEndpoint(servers, "server", "ANY", match[1]!, file, owner, file.content, match.index!, match.index! + match[0].length) &&
        diagnostics.length < MAX_DIAGNOSTICS && literalPath(match[1]!) && !owner) {
      diagnostics.push(`HTTP_BOUNDARY_SERVER_HANDLER_UNRESOLVED: ${file.relativePath}:${match[2]}`);
    }
  }

  const client = /\bhttp\.(Get|Post|Head)\s*\(\s*"([^"\\\r\n]+)"/g;
  for (const match of masked.matchAll(client)) {
    const position = sourcePosition(file.content, match.index!, match.index! + match[0].length);
    addEndpoint(clients, "client", match[1]!, match[2]!, file,
      containingOwner(file, nodes, position.startByte), file.content, match.index!, match.index! + match[0].length);
  }

  const request = /\bhttp\.NewRequest(?:WithContext)?\s*\(\s*"([A-Za-z]+)"\s*,\s*"([^"\\\r\n]+)"/g;
  for (const match of masked.matchAll(request)) {
    const position = sourcePosition(file.content, match.index!, match.index! + match[0].length);
    addEndpoint(clients, "client", match[1]!, match[2]!, file,
      containingOwner(file, nodes, position.startByte), file.content, match.index!, match.index! + match[0].length);
  }
}

function extractRust(
  file: IndexedSourceFile,
  nodes: CodeNodeRecord[],
  masked: string,
  clients: HttpEndpoint[],
  servers: HttpEndpoint[],
  diagnostics: string[],
): void {
  const route = new RegExp(
    `\\.route\\s*\\(\\s*\"([^\"\\\\\\r\\n]+)\"\\s*,\\s*(${HTTP_METHOD})\\s*\\(\\s*([A-Za-z_]\\w*)\\s*\\)`,
    "gi",
  );
  for (const match of masked.matchAll(route)) {
    const owner = namedOwner(file, nodes, match[3]!);
    if (!addEndpoint(servers, "server", match[2]!, match[1]!, file, owner, file.content, match.index!, match.index! + match[0].length) &&
        diagnostics.length < MAX_DIAGNOSTICS && literalPath(match[1]!) && !owner) {
      diagnostics.push(`HTTP_BOUNDARY_SERVER_HANDLER_UNRESOLVED: ${file.relativePath}:${match[3]}`);
    }
  }

  const actix = new RegExp(
    `#\\[(${HTTP_METHOD})\\s*\\(\\s*\"([^\"\\\\\\r\\n]+)\"\\s*\\)\\]\\s*(?:pub\\s+)?(?:async\\s+)?fn\\s+([A-Za-z_]\\w*)`,
    "gi",
  );
  for (const match of masked.matchAll(actix)) {
    const owner = namedOwner(file, nodes, match[3]!);
    if (!addEndpoint(servers, "server", match[1]!, match[2]!, file, owner, file.content, match.index!, match.index! + match[0].length) &&
        diagnostics.length < MAX_DIAGNOSTICS && literalPath(match[2]!) && !owner) {
      diagnostics.push(`HTTP_BOUNDARY_SERVER_HANDLER_UNRESOLVED: ${file.relativePath}:${match[3]}`);
    }
  }

  const client = /\breqwest::get\s*\(\s*"([^"\\\r\n]+)"/g;
  for (const match of masked.matchAll(client)) {
    const position = sourcePosition(file.content, match.index!, match.index! + match[0].length);
    addEndpoint(clients, "client", "GET", match[1]!, file,
      containingOwner(file, nodes, position.startByte), file.content, match.index!, match.index! + match[0].length);
  }
}

function endpoints(files: IndexedSourceFile[], nodes: CodeNodeRecord[]): {
  clients: HttpEndpoint[];
  servers: HttpEndpoint[];
  diagnostics: string[];
} {
  const clients: HttpEndpoint[] = [];
  const servers: HttpEndpoint[] = [];
  const diagnostics: string[] = [];
  for (const file of [...files].sort((left, right) => left.pathKey.localeCompare(right.pathKey))) {
    const masked = maskComments(file.content, file.language);
    if (["typescript", "tsx", "javascript", "jsx", "mjs", "cjs"].includes(file.language)) {
      extractJavaScript(file, nodes, masked, clients, servers, diagnostics);
    } else if (file.language === "python") {
      extractPython(file, nodes, masked, clients, servers, diagnostics);
    } else if (file.language === "go") {
      extractGo(file, nodes, masked, clients, servers, diagnostics);
    } else if (file.language === "rust") {
      extractRust(file, nodes, masked, clients, servers, diagnostics);
    }
  }
  const endpointKey = (item: HttpEndpoint): string =>
    `${item.role}\0${item.method}\0${item.path}\0${item.file.pathKey}\0${item.startByte}\0${item.owner.id}`;
  clients.sort((left, right) => endpointKey(left).localeCompare(endpointKey(right)));
  servers.sort((left, right) => endpointKey(left).localeCompare(endpointKey(right)));
  return { clients, servers, diagnostics: [...new Set(diagnostics)] };
}

function evidence(client: HttpEndpoint, server: HttpEndpoint): NonNullable<CodeEdgeRecord["evidence"]>[number] {
  return {
    provider: HTTP_BOUNDARY_PROVIDER,
    providerVersion: HTTP_BOUNDARY_PROVIDER_VERSION,
    source: "resolver",
    confidence: 1,
    sourceSpan: {
      startByte: client.startByte,
      endByte: client.endByte,
      line: client.line,
      column: client.column,
    },
    details: {
      boundaryProtocol: "http",
      boundaryMethod: client.method,
      boundaryPath: client.path,
      clientLanguage: client.file.language,
      clientFile: client.file.relativePath,
      serverLanguage: server.file.language,
      serverFile: server.file.relativePath,
      serverSourceSpan: {
        startByte: server.startByte,
        endByte: server.endByte,
        line: server.line,
        column: server.column,
      },
    },
  };
}

export function linkHttpBoundaries(
  files: IndexedSourceFile[],
  nodes: CodeNodeRecord[],
): HttpBoundaryResult {
  const extracted = endpoints(files, nodes);
  const pairs = new Map<string, { client: HttpEndpoint; server: HttpEndpoint; evidence: NonNullable<CodeEdgeRecord["evidence"]> }>();
  const unresolvedReferences: UnresolvedReferenceRecord[] = [];

  for (const client of extracted.clients) {
    const differentLanguage = extracted.servers.filter((server) =>
      server.path === client.path && server.file.language !== client.file.language);
    const exact = differentLanguage.filter((server) => server.method === client.method);
    const fallback = differentLanguage.filter((server) => server.method === "ANY");
    const candidates = new Map((exact.length > 0 ? exact : fallback).map((server) => [server.owner.id, server]));
    if (candidates.size === 1) {
      const server = [...candidates.values()][0]!;
      const key = `${client.owner.id}\0${server.owner.id}`;
      const prior = pairs.get(key);
      const itemEvidence = evidence(client, server);
      if (prior) {
        const keyFor = (item: NonNullable<CodeEdgeRecord["evidence"]>[number]): string =>
          `${item.provider}\0${item.providerVersion}\0${JSON.stringify(item.sourceSpan)}\0${JSON.stringify(item.details)}`;
        prior.evidence = [...new Map([...prior.evidence, itemEvidence].map((item) => [keyFor(item), item])).values()]
          .sort((left, right) => keyFor(left).localeCompare(keyFor(right)));
      } else {
        pairs.set(key, { client, server, evidence: [itemEvidence] });
      }
      continue;
    }

    unresolvedReferences.push({
      workspaceId: client.file.workspaceId,
      fileId: client.file.id,
      sourceNodeId: client.owner.id,
      kind: "HTTP_BOUNDARY_CALL",
      rawName: `${client.method} ${client.path}`,
      qualifier: "http",
      line: client.line,
      column: client.column,
      candidates: [...candidates.keys()].sort(),
      generation: client.file.generation,
      confidence: candidates.size > 1 ? 0.5 : 0,
      evidence: [{
        provider: HTTP_BOUNDARY_PROVIDER,
        providerVersion: HTTP_BOUNDARY_PROVIDER_VERSION,
        source: "resolver",
        confidence: candidates.size > 1 ? 0.5 : 0,
        sourceSpan: {
          startByte: client.startByte,
          endByte: client.endByte,
          line: client.line,
          column: client.column,
        },
        details: {
          boundaryProtocol: "http",
          boundaryMethod: client.method,
          boundaryPath: client.path,
          clientLanguage: client.file.language,
          clientFile: client.file.relativePath,
          candidateCount: candidates.size,
        },
      }],
    });
  }

  const edges = [...pairs.values()].map(({ client, server, evidence: edgeEvidence }) => ({
    workspaceId: client.file.workspaceId,
    sourceId: client.owner.id,
    targetId: server.owner.id,
    kind: "CALLS" as const,
    confidence: 1,
    resolutionKind: "exact" as const,
    generation: client.file.generation,
    metadata: {
      boundaryProtocol: "http",
      boundaries: edgeEvidence.map((item) => item.details).filter(Boolean),
    },
    status: "resolved" as const,
    evidence: edgeEvidence,
  })).sort((left, right) =>
    `${left.sourceId}\0${left.targetId}`.localeCompare(`${right.sourceId}\0${right.targetId}`));

  const unresolvedKey = (item: UnresolvedReferenceRecord): string =>
    `${item.fileId}\0${item.sourceNodeId ?? ""}\0${item.rawName}\0${item.line}\0${item.column}`;
  unresolvedReferences.sort((left, right) => unresolvedKey(left).localeCompare(unresolvedKey(right)));
  return { edges, unresolvedReferences, diagnostics: extracted.diagnostics };
}
