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

export function v04CommitSourceEvidence(commit: string, root = process.cwd()): { treeDigest: string; files: number } {
  const files = execFileSync(
    "git",
    ["ls-tree", "-rz", "--name-only", commit],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean)
    .map((item) => item.replaceAll("\\", "/"))
    .filter((item) => !item.startsWith("artifacts/"))
    .sort((left, right) => left.localeCompare(right));
  return manifestEvidence(files.map((file) => ({
    path: file,
    sha256: normalizedBufferDigest(execFileSync("git", ["show", `${commit}:${file}`], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    })),
  })));
}

export function v04SourceEvidence(root = process.cwd()): V04SourceEvidence {
  const headCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean)
    .map((item) => item.replaceAll("\\", "/"))
    .filter((item) => !item.startsWith("artifacts/") && existsSync(path.join(root, item)))
    .sort((left, right) => left.localeCompare(right));
  const manifest = files.map((file) => ({
    path: file,
    sha256: normalizedDigest(path.join(root, file)),
  }));
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
