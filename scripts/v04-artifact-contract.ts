import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const V04_ARTIFACT_CONTRACT = "contextmesh-v04-fixed-fixtures-v4";
export const V04_SOURCE_CONTRACT = "git-source-snapshot-lf-v3";
export const V04_ARTIFACT_PATH = "artifacts/v04-performance.json";

export const V04_FIXED_HARDWARE = {
  profile: "windows-ms7d75-7800x3d-32gb-v1",
  platform: "win32",
  architecture: "x64",
  cpu: "AMD Ryzen 7 7800X3D 8-Core Processor",
  logicalCpus: 16,
  ramBytes: 33_694_904_320,
  powerSchemeGuid: "381b4222-f694-41f0-9685-ff5bb260df2e",
} as const;

export interface V04SourceEvidence {
  contract: typeof V04_SOURCE_CONTRACT;
  treeDigest: string;
  files: number;
  headCommit: string;
  headTreeDigest: string;
  dirty: boolean;
}

export interface V04SourceManifestEntry {
  path: string;
  sha256: string;
}

export interface V04HardwareIdentity {
  hardwareProfile: string;
  os: string;
  cpu: string;
  logicalCpus: number;
  ramBytes: number;
  powerSchemeGuid: string;
}

export function stableStringify(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalize(nested)]));
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

function isGeneratedArtifactPath(relativePath: string): boolean {
  return relativePath.startsWith("artifacts/") || relativePath.startsWith("evaluation/artifacts/");
}

function normalizedBufferDigest(source: Buffer): string {
  const normalized = source.includes(0)
    ? source
    : Buffer.from(source.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  return createHash("sha256").update(normalized).digest("hex");
}

function normalizedDigest(file: string): string {
  return normalizedBufferDigest(readFileSync(file));
}

function manifestEvidence(manifest: Array<{ path: string; sha256: string }>): { treeDigest: string; files: number } {
  return {
    treeDigest: createHash("sha256").update(stableStringify(manifest)).digest("hex"),
    files: manifest.length,
  };
}

function workingSourceManifest(root: string): V04SourceManifestEntry[] {
  return execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean)
    .map((item) => item.replaceAll("\\", "/"))
    .filter((item) => !isGeneratedArtifactPath(item) && existsSync(path.join(root, item)))
    .sort((left, right) => left.localeCompare(right))
    .map((file) => ({ path: file, sha256: normalizedDigest(path.join(root, file)) }));
}

export function v04SourceDifferencePaths(root = process.cwd(), commit = "HEAD"): string[] {
  const committed = new Map(v04CommitSourceManifest(commit, root).map((item) => [item.path, item.sha256]));
  const working = new Map(workingSourceManifest(root).map((item) => [item.path, item.sha256]));
  return [...new Set([...committed.keys(), ...working.keys()])]
    .sort((left, right) => left.localeCompare(right))
    .flatMap((file) => {
      if (!committed.has(file)) return [`added:${file}`];
      if (!working.has(file)) return [`removed:${file}`];
      return committed.get(file) === working.get(file) ? [] : [`changed:${file}`];
    });
}

export function v04CommitSourceManifest(commit: string, root = process.cwd()): V04SourceManifestEntry[] {
  const files = execFileSync(
    "git",
    ["ls-tree", "-rz", "--name-only", commit],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean)
    .map((item) => item.replaceAll("\\", "/"))
    .filter((item) => !isGeneratedArtifactPath(item))
    .sort((left, right) => left.localeCompare(right));
  return files.map((file) => ({
    path: file,
    sha256: normalizedBufferDigest(execFileSync("git", ["show", `${commit}:${file}`], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    })),
  }));
}

export function v04CommitSourceEvidence(commit: string, root = process.cwd()): { treeDigest: string; files: number } {
  return manifestEvidence(v04CommitSourceManifest(commit, root));
}

export function v04SourceEvidence(root = process.cwd()): V04SourceEvidence {
  const headCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const manifest = workingSourceManifest(root);
  const working = manifestEvidence(manifest);
  const head = v04CommitSourceEvidence(headCommit, root);
  return {
    contract: V04_SOURCE_CONTRACT,
    ...working,
    headCommit,
    headTreeDigest: head.treeDigest,
    dirty: working.treeDigest !== head.treeDigest || working.files !== head.files,
  };
}

export function v04CanonicalSourceEvidence(root = process.cwd()): V04SourceEvidence {
  const current = v04SourceEvidence(root);
  if (current.dirty) return current;
  let sourceCommit = current.headCommit;
  const commits = execFileSync("git", ["rev-list", "--first-parent", "HEAD"], {
    cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  }).split(/\r?\n/).filter(Boolean);
  for (const commit of commits.slice(1)) {
    const evidence = v04CommitSourceEvidence(commit, root);
    if (evidence.treeDigest !== current.treeDigest || evidence.files !== current.files) break;
    sourceCommit = commit;
  }
  return {
    ...current,
    headCommit: sourceCommit,
    headTreeDigest: current.treeDigest,
  };
}

export function v04CanonicalSourceEvidenceOrArchive(root = process.cwd()): V04SourceEvidence {
  if (existsSync(path.join(root, ".git"))) return v04CanonicalSourceEvidence(root);
  const evidencePath = path.join(root, "SOURCE_EVIDENCE.json");
  const sourceCommitPath = path.join(root, "SOURCE_COMMIT");
  const manifestPath = path.join(root, "SOURCE_MANIFEST.json");
  if (![evidencePath, sourceCommitPath, manifestPath].every((file) => existsSync(file))) {
    throw new Error("SOURCE_PROVENANCE_MISSING: git metadata or verified source archive evidence is required");
  }
  const sourceText = readFileSync(evidencePath, "utf8");
  const evidence = JSON.parse(sourceText) as V04SourceEvidence;
  const sourceCommit = readFileSync(sourceCommitPath, "utf8");
  if (
    sourceText !== stableStringify(evidence) ||
    evidence.contract !== V04_SOURCE_CONTRACT ||
    !/^[0-9a-f]{64}$/.test(evidence.treeDigest) ||
    !/^[0-9a-f]{40}$/.test(evidence.headCommit) ||
    evidence.headTreeDigest !== evidence.treeDigest ||
    !Number.isSafeInteger(evidence.files) ||
    evidence.files < 1 ||
    evidence.dirty !== false ||
    sourceCommit !== evidence.headCommit
  ) {
    throw new Error("SOURCE_PROVENANCE_INVALID: source archive evidence is not canonical");
  }
  verifyV04ArchiveSourceManifest(evidence, root);
  return evidence;
}

export function verifyV04ArchiveSourceManifest(
  expected: Pick<V04SourceEvidence, "treeDigest" | "files">,
  root = process.cwd(),
): void {
  const manifestPath = path.join(root, "SOURCE_MANIFEST.json");
  if (!existsSync(manifestPath)) throw new Error("archive source manifest is missing");
  const source = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(source) as V04SourceManifestEntry[];
  if (source.replaceAll("\r\n", "\n") !== `${stableStringify(manifest)}\n`) {
    throw new Error("archive source manifest is not canonical");
  }
  const normalizedPaths = manifest.map((item) => item.path.replaceAll("\\", "/"));
  if (new Set(normalizedPaths).size !== manifest.length ||
    normalizedPaths.some((item, index) => item !== manifest[index]!.path || path.isAbsolute(item) ||
      item.split("/").includes("..") || isGeneratedArtifactPath(item)) ||
    [...normalizedPaths].sort((left, right) => left.localeCompare(right))
      .some((item, index) => item !== normalizedPaths[index])) {
    throw new Error("archive source manifest paths are invalid");
  }
  for (const item of manifest) {
    const absolute = path.resolve(root, item.path);
    if (!absolute.startsWith(path.resolve(root) + path.sep) || !existsSync(absolute) ||
      !/^[0-9a-f]{64}$/.test(item.sha256) || normalizedDigest(absolute) !== item.sha256) {
      throw new Error(`archive source file does not match manifest: ${item.path}`);
    }
  }
  const actual = manifestEvidence(manifest);
  if (actual.treeDigest !== expected.treeDigest || actual.files !== expected.files) {
    throw new Error("archive source manifest does not match expected evidence");
  }
}

export function expectedNativeRuntime(root = process.cwd()): string {
  const cargo = readFileSync(path.join(root, "native", "graph-kernel", "Cargo.toml"), "utf8");
  const packageSection = cargo.match(/\[package\]([\s\S]*?)(?:\n\[|$)/)?.[1] ?? "";
  const version = packageSection.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!version) throw new Error("Cannot derive graph-kernel package version from Cargo.toml");
  return `contextmesh-graph-kernel@${version}`;
}

export function validateFixedHardwareIdentity(identity: V04HardwareIdentity): void {
  const expectedOsPrefix = `${V04_FIXED_HARDWARE.platform} `;
  const expectedOsSuffix = ` ${V04_FIXED_HARDWARE.architecture}`;
  if (
    identity.hardwareProfile !== V04_FIXED_HARDWARE.profile ||
    !identity.os.startsWith(expectedOsPrefix) ||
    !identity.os.endsWith(expectedOsSuffix) ||
    identity.cpu.trim() !== V04_FIXED_HARDWARE.cpu ||
    identity.logicalCpus !== V04_FIXED_HARDWARE.logicalCpus ||
    identity.ramBytes !== V04_FIXED_HARDWARE.ramBytes ||
    identity.powerSchemeGuid.toLocaleLowerCase("en-US") !== V04_FIXED_HARDWARE.powerSchemeGuid
  ) {
    throw new Error("runner does not match the canonical fixed hardware profile");
  }
}
