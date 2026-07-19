import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import createIgnore, { type Ignore } from "ignore";

import type { IndexedSourceFile } from "../contracts.js";
import { isPathInside, normalizeRelativePath, sha256 } from "../utils.js";
import type { MetadataStatPool } from "./metadata-stat-pool.js";

export interface ScannedFileMetadata {
  absolutePath: string;
  relativePath: string;
  pathKey: string;
  language: IndexedSourceFile["language"];
  sizeBytes: number;
  mtimeMs: number;
}

export interface ScannedFile extends ScannedFileMetadata {
  content: string;
  contentHash: string;
}

export interface MetadataScanResult {
  files: ScannedFileMetadata[];
  diagnostics: string[];
}

export interface ScanResult {
  files: ScannedFile[];
  diagnostics: string[];
}

const DEFAULT_EXCLUDES = [
  ".git/",
  ".contextmesh/",
  "node_modules/",
  "dist/",
  "build/",
  "out/",
  "coverage/",
  ".next/",
  ".turbo/",
  ".cache/",
  "*.min.js",
  "*.map",
];

const SECRET_PATTERNS = [
  /(^|\/)\.env(?:\.|$)/i,
  /\.(?:pem|key|p12|pfx|jks)$/i,
  /(^|\/)(?:credentials?|secrets?)(?:\.|\/|$)/i,
];

function languageForFile(fileName: string): ScannedFileMetadata["language"] | null {
  const lower = fileName.toLocaleLowerCase("en-US");
  if (lower.endsWith(".d.ts") || lower.endsWith(".ts")) return "typescript";
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".mjs")) return "mjs";
  if (lower.endsWith(".cjs")) return "cjs";
  if (lower.endsWith(".jsx")) return "jsx";
  if (lower.endsWith(".js")) return "javascript";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".cs")) return "csharp";
  return null;
}

function loadIgnoreRules(rootPath: string): Ignore {
  const rules = createIgnore().add(DEFAULT_EXCLUDES);
  try {
    rules.add(readFileSync(path.join(rootPath, ".gitignore"), "utf8"));
  } catch {
    // A .gitignore is optional.
  }
  try {
    rules.add(readFileSync(path.join(rootPath, ".contextmeshignore"), "utf8"));
  } catch {
    // A ContextMesh-specific ignore file is optional.
  }
  return rules;
}

export function scanWorkspaceMetadata(
  rootPath: string,
  caseSensitivePaths: boolean,
  maximumFileBytes = 2 * 1024 * 1024,
): MetadataScanResult {
  const rules = loadIgnoreRules(rootPath);
  const files: ScannedFileMetadata[] = [];
  const diagnostics: string[] = [];

  const visitDirectory = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      diagnostics.push(`Cannot read directory ${directory}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(rootPath, absolutePath).replaceAll("\\", "/");
      const rulePath = entry.isDirectory() ? `${relativePath}/` : relativePath;
      if (rules.ignores(rulePath)) continue;
      if (entry.isSymbolicLink()) {
        diagnostics.push(`Skipped symbolic link: ${relativePath}`);
        continue;
      }
      if (entry.isDirectory()) {
        visitDirectory(absolutePath);
        continue;
      }
      if (!entry.isFile() || SECRET_PATTERNS.some((pattern) => pattern.test(relativePath))) continue;
      const language = languageForFile(entry.name);
      if (!language) continue;
      try {
        const linkStatus = lstatSync(absolutePath);
        if (!linkStatus.isFile()) continue;
        if (linkStatus.size > maximumFileBytes) {
          diagnostics.push(`Skipped oversized file (${linkStatus.size} bytes): ${relativePath}`);
          continue;
        }
        files.push({
          absolutePath,
          relativePath,
          pathKey: normalizeRelativePath(relativePath, caseSensitivePaths),
          language,
          sizeBytes: linkStatus.size,
          mtimeMs: linkStatus.mtimeMs,
        });
      } catch (error) {
        diagnostics.push(`Cannot read file ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  visitDirectory(rootPath);
  files.sort((left, right) => left.pathKey.localeCompare(right.pathKey));
  return { files, diagnostics };
}

export async function scanWorkspaceMetadataFast(
  rootPath: string,
  caseSensitivePaths: boolean,
  statPool: MetadataStatPool,
  maximumFileBytes = 2 * 1024 * 1024,
): Promise<MetadataScanResult> {
  const rules = loadIgnoreRules(rootPath);
  const candidates: Array<Omit<ScannedFileMetadata, "sizeBytes" | "mtimeMs">> = [];
  const events: Array<{ diagnostic: string } | { candidateIndex: number }> = [];

  const visitDirectory = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      events.push({
        diagnostic: `Cannot read directory ${directory}: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(rootPath, absolutePath).replaceAll("\\", "/");
      const rulePath = entry.isDirectory() ? `${relativePath}/` : relativePath;
      if (rules.ignores(rulePath)) continue;
      if (entry.isSymbolicLink()) {
        events.push({ diagnostic: `Skipped symbolic link: ${relativePath}` });
        continue;
      }
      if (entry.isDirectory()) {
        visitDirectory(absolutePath);
        continue;
      }
      if (!entry.isFile() || SECRET_PATTERNS.some((pattern) => pattern.test(relativePath))) continue;
      const language = languageForFile(entry.name);
      if (!language) continue;
      events.push({ candidateIndex: candidates.length });
      candidates.push({
        absolutePath,
        relativePath,
        pathKey: normalizeRelativePath(relativePath, caseSensitivePaths),
        language,
      });
    }
  };

  visitDirectory(rootPath);
  let inspected;
  try {
    inspected = await statPool.inspect(candidates.map((candidate) => candidate.absolutePath));
  } catch {
    return scanWorkspaceMetadata(rootPath, caseSensitivePaths, maximumFileBytes);
  }
  const files: ScannedFileMetadata[] = [];
  const diagnostics: string[] = [];
  for (const event of events) {
    if ("diagnostic" in event) {
      diagnostics.push(event.diagnostic);
      continue;
    }
    const candidate = candidates[event.candidateIndex]!;
    const result = inspected[event.candidateIndex]!;
    if (result.error) {
      diagnostics.push(`Cannot read file ${candidate.relativePath}: ${result.error}`);
    } else if (result.isFile && result.sizeBytes > maximumFileBytes) {
      diagnostics.push(`Skipped oversized file (${result.sizeBytes} bytes): ${candidate.relativePath}`);
    } else if (result.isFile) {
      files.push({ ...candidate, sizeBytes: result.sizeBytes, mtimeMs: result.mtimeMs });
    }
  }
  files.sort((left, right) => left.pathKey.localeCompare(right.pathKey));
  return { files, diagnostics };
}

export function hydrateScannedFile(file: ScannedFileMetadata, rootPath?: string): ScannedFile {
  const linkStatus = lstatSync(file.absolutePath);
  if (!linkStatus.isFile() || linkStatus.isSymbolicLink()) {
    throw new Error(`Refused non-regular source file: ${file.relativePath}`);
  }
  const realFile = realpathSync(file.absolutePath);
  const boundaryRoot = rootPath ? path.resolve(rootPath) : null;
  if (boundaryRoot && !isPathInside(boundaryRoot, realFile)) {
    throw new Error(`Refused source outside workspace: ${file.relativePath}`);
  }
  const descriptor = openSync(realFile, "r");
  try {
    const before = fstatSync(descriptor);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(file.absolutePath);
    const realAfter = realpathSync(file.absolutePath);
    const identityAvailable = before.dev !== 0 || before.ino !== 0;
    if (
      pathAfter.isSymbolicLink() ||
      realAfter !== realFile ||
      (boundaryRoot && !isPathInside(boundaryRoot, realAfter)) ||
      (identityAvailable &&
        (before.dev !== after.dev ||
          before.ino !== after.ino ||
          after.dev !== pathAfter.dev ||
          after.ino !== pathAfter.ino)) ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.byteLength !== after.size
    ) {
      throw new Error(`Source changed while reading: ${file.relativePath}`);
    }
    return {
      ...file,
      content: bytes.toString("utf8"),
      contentHash: sha256(bytes),
      sizeBytes: bytes.byteLength,
      mtimeMs: after.mtimeMs,
    };
  } finally {
    closeSync(descriptor);
  }
}

export function scanWorkspace(
  rootPath: string,
  caseSensitivePaths: boolean,
  maximumFileBytes = 2 * 1024 * 1024,
): ScanResult {
  const metadata = scanWorkspaceMetadata(rootPath, caseSensitivePaths, maximumFileBytes);
  const files: ScannedFile[] = [];
  const diagnostics = [...metadata.diagnostics];
  for (const file of metadata.files) {
    try {
      files.push(hydrateScannedFile(file, rootPath));
    } catch (error) {
      diagnostics.push(
        `Cannot read file ${file.relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { files, diagnostics };
}
