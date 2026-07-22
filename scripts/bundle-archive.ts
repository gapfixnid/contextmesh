import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

export interface BundledPackageRecord {
  name: string;
  version: string;
  path: string;
  contentSha256: string;
  license: string;
  lifecycleScripts: Record<string, string>;
  fileCount: number;
}

export interface BundleArchiveSummary {
  packedSizeBytes: number;
  unpackedSizeBytes: number;
  bundledPackageCount: number;
  bundledFileCount: number;
  bundledTreeSha256: string;
  packages: BundledPackageRecord[];
  files: string[];
  rootPackageJson: Record<string, unknown>;
}

export interface BundleManifest {
  schemaVersion: 1;
  directBundles: ["@modelcontextprotocol/sdk"];
  baseline: {
    packedSizeBytes: number;
    unpackedSizeBytes: number;
    bundledPackageCount: number;
    bundledFileCount: number;
  };
  limits: {
    maxPackedSizeBytes: number;
    maxUnpackedSizeBytes: number;
    maxBundledPackageCount: number;
    maxBundledFileCount: number;
  };
  bundledTreeSha256: string;
  packages: BundledPackageRecord[];
}

interface TarEntry {
  path: string;
  type: "file" | "directory";
  mode: number;
  data: Buffer;
}

interface PackageJson {
  name?: unknown;
  version?: unknown;
  license?: unknown;
  scripts?: unknown;
}

const TAR_BLOCK_SIZE = 512;
const LIFECYCLE_SCRIPT_NAMES = ["preinstall", "install", "postinstall"] as const;

function nullTerminated(buffer: Buffer): string {
  const ending = buffer.indexOf(0);
  return buffer.subarray(0, ending >= 0 ? ending : buffer.length).toString("utf8");
}

function tarNumber(buffer: Buffer, field: string): number {
  if ((buffer[0] ?? 0) & 0x80) throw new Error(`Unsupported base-256 tar ${field}`);
  const value = nullTerminated(buffer).trim();
  if (value === "") return 0;
  if (!/^[0-7]+$/.test(value)) throw new Error(`Invalid tar ${field}: ${JSON.stringify(value)}`);
  return Number.parseInt(value, 8);
}

function validateChecksum(header: Buffer): void {
  const expected = tarNumber(header.subarray(148, 156), "checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  if (actual !== expected) throw new Error(`Invalid tar header checksum: expected ${expected}, received ${actual}`);
}

function parsePax(data: Buffer): Record<string, string> {
  const values: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error("Invalid PAX record length");
    const lengthText = data.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw new Error(`Invalid PAX record length: ${lengthText}`);
    const length = Number.parseInt(lengthText, 10);
    const end = offset + length;
    if (end > data.length || data[end - 1] !== 0x0a) throw new Error("Invalid PAX record boundary");
    const record = data.subarray(space + 1, end - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals <= 0) throw new Error("Invalid PAX key/value record");
    values[record.slice(0, equals)] = record.slice(equals + 1);
    offset = end;
  }
  return values;
}

function safeTarPath(input: string): string {
  if (input.includes("\\") || input.startsWith("/") || /^[A-Za-z]:/.test(input)) {
    throw new Error(`Unsafe tar path: ${input}`);
  }
  const path = input.endsWith("/") ? input.slice(0, -1) : input;
  const segments = path.split("/");
  if (segments.length === 0 || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Unsafe tar path: ${input}`);
  }
  if (segments[0] !== "package") throw new Error(`Tar entry escaped package root: ${input}`);
  return path;
}

function parseTar(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  const seen = new Set<string>();
  const seenCaseInsensitive = new Set<string>();
  let offset = 0;
  let globalPax: Record<string, string> = {};
  let localPax: Record<string, string> = {};
  let longPath: string | null = null;
  let longLink: string | null = null;
  while (offset + TAR_BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;
    validateChecksum(header);
    const size = tarNumber(header.subarray(124, 136), "size");
    const mode = tarNumber(header.subarray(100, 108), "mode");
    const typeByte = header[156] ?? 0;
    const type = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
    const name = nullTerminated(header.subarray(0, 100));
    const prefix = nullTerminated(header.subarray(345, 500));
    const headerPath = prefix ? `${prefix}/${name}` : name;
    const linkName = nullTerminated(header.subarray(157, 257));
    const dataStart = offset + TAR_BLOCK_SIZE;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) throw new Error(`Truncated tar entry: ${headerPath}`);
    const data = archive.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;

    if (type === "g") {
      globalPax = { ...globalPax, ...parsePax(data) };
      continue;
    }
    if (type === "x") {
      localPax = parsePax(data);
      continue;
    }
    if (type === "L") {
      longPath = nullTerminated(data);
      continue;
    }
    if (type === "K") {
      longLink = nullTerminated(data);
      continue;
    }

    const metadata = { ...globalPax, ...localPax };
    const effectivePath = safeTarPath(metadata.path ?? longPath ?? headerPath);
    const effectiveLink = metadata.linkpath ?? longLink ?? linkName;
    localPax = {};
    longPath = null;
    longLink = null;
    if (type === "1" || type === "2") {
      throw new Error(`Tar links are prohibited: ${effectivePath} -> ${effectiveLink}`);
    }
    if (type !== "0" && type !== "5" && type !== "7") {
      throw new Error(`Unsupported tar entry type ${JSON.stringify(type)} at ${effectivePath}`);
    }
    if (seen.has(effectivePath)) throw new Error(`Duplicate tar entry: ${effectivePath}`);
    const caseKey = effectivePath.toLowerCase();
    if (seenCaseInsensitive.has(caseKey)) throw new Error(`Case-colliding tar entry: ${effectivePath}`);
    seen.add(effectivePath);
    seenCaseInsensitive.add(caseKey);
    entries.push({
      path: effectivePath,
      type: type === "5" ? "directory" : "file",
      mode,
      data: type === "5" ? Buffer.alloc(0) : Buffer.from(data),
    });
  }
  if (localPax.path || longPath || longLink) throw new Error("Tar archive ended with unresolved metadata");
  return entries;
}

function packageRootForPath(path: string): string | null {
  const segments = path.split("/");
  let result: string | null = null;
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] !== "node_modules") continue;
    const first = segments[index + 1];
    if (!first) continue;
    const end = first.startsWith("@") ? index + 3 : index + 2;
    if (end <= segments.length) result = segments.slice(0, end).join("/");
  }
  return result;
}

function packageNameFromRoot(root: string): string {
  const segments = root.split("/");
  const nodeModules = segments.lastIndexOf("node_modules");
  const first = segments[nodeModules + 1];
  if (!first) throw new Error(`Invalid bundled package path: ${root}`);
  if (!first.startsWith("@")) return first;
  const second = segments[nodeModules + 2];
  if (!second) throw new Error(`Invalid scoped bundled package path: ${root}`);
  return `${first}/${second}`;
}

function packageDigest(root: string, entries: TarEntry[]): string {
  const digest = createHash("sha256");
  digest.update("contextmesh-bundled-package-v1\0");
  for (const entry of entries.sort((left, right) => left.path.localeCompare(right.path))) {
    const relative = entry.path.slice(root.length + 1);
    digest.update(relative);
    digest.update("\0");
    digest.update(entry.data.length.toString(10));
    digest.update("\0");
    digest.update(entry.data);
  }
  return digest.digest("hex");
}

function lifecycleScripts(packageJson: PackageJson): Record<string, string> {
  if (packageJson.scripts === undefined) return {};
  if (!packageJson.scripts || typeof packageJson.scripts !== "object" || Array.isArray(packageJson.scripts)) {
    throw new Error(`Invalid scripts metadata in ${String(packageJson.name)}`);
  }
  const scripts = packageJson.scripts as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const name of LIFECYCLE_SCRIPT_NAMES) {
    const command = scripts[name];
    if (command === undefined) continue;
    if (typeof command !== "string") throw new Error(`Invalid ${name} script in ${String(packageJson.name)}`);
    result[name] = command;
  }
  return result;
}

function inspectPackages(entries: TarEntry[]): BundledPackageRecord[] {
  const packageJsonEntries = entries.filter(
    (entry) => entry.type === "file" && entry.path.includes("/node_modules/") && entry.path.endsWith("/package.json"),
  );
  const roots = new Map<string, TarEntry>();
  for (const entry of packageJsonEntries) {
    const root = packageRootForPath(entry.path);
    if (!root || entry.path !== `${root}/package.json`) continue;
    if (roots.has(root)) throw new Error(`Duplicate bundled package metadata: ${root}`);
    roots.set(root, entry);
  }
  const grouped = new Map<string, TarEntry[]>();
  for (const entry of entries) {
    if (entry.type !== "file" || !entry.path.includes("/node_modules/")) continue;
    const root = packageRootForPath(entry.path);
    if (!root || !roots.has(root)) throw new Error(`Bundled file has no owning package: ${entry.path}`);
    const files = grouped.get(root) ?? [];
    files.push(entry);
    grouped.set(root, files);
  }
  const packages: BundledPackageRecord[] = [];
  for (const [root, metadata] of roots) {
    const packageJson = JSON.parse(metadata.data.toString("utf8")) as PackageJson;
    if (typeof packageJson.name !== "string" || packageJson.name !== packageNameFromRoot(root)) {
      throw new Error(`Bundled package name/path mismatch at ${root}`);
    }
    if (typeof packageJson.version !== "string" || packageJson.version === "") {
      throw new Error(`Bundled package has no exact version: ${packageJson.name}`);
    }
    if (typeof packageJson.license !== "string" || packageJson.license === "") {
      throw new Error(`Bundled package has no license identifier: ${packageJson.name}`);
    }
    const files = grouped.get(root) ?? [];
    packages.push({
      name: packageJson.name,
      version: packageJson.version,
      path: root.slice("package/".length),
      contentSha256: packageDigest(root, files),
      license: packageJson.license,
      lifecycleScripts: lifecycleScripts(packageJson),
      fileCount: files.length,
    });
  }
  return packages.sort((left, right) => left.path.localeCompare(right.path));
}

function canonicalPackages(packages: BundledPackageRecord[]): string {
  return JSON.stringify([...packages].sort((left, right) => left.path.localeCompare(right.path)));
}

function treeDigest(packages: BundledPackageRecord[]): string {
  return createHash("sha256").update("contextmesh-bundled-tree-v1\0").update(canonicalPackages(packages)).digest("hex");
}

export function inspectBundleTarball(archivePath: string): BundleArchiveSummary {
  const compressed = readFileSync(archivePath);
  const entries = parseTar(gunzipSync(compressed));
  const rootPackage = entries.find((entry) => entry.type === "file" && entry.path === "package/package.json");
  if (!rootPackage) throw new Error("Packed archive has no root package.json");
  const rootPackageJson = JSON.parse(rootPackage.data.toString("utf8")) as Record<string, unknown>;
  const packages = inspectPackages(entries);
  const files = entries.filter((entry) => entry.type === "file").map((entry) => entry.path.slice("package/".length));
  const bundledFileCount = packages.reduce((total, item) => total + item.fileCount, 0);
  return {
    packedSizeBytes: statSync(archivePath).size,
    unpackedSizeBytes: entries.reduce((total, entry) => total + (entry.type === "file" ? entry.data.length : 0), 0),
    bundledPackageCount: packages.length,
    bundledFileCount,
    bundledTreeSha256: treeDigest(packages),
    packages,
    files: files.sort(),
    rootPackageJson,
  };
}

function installedEntries(packageRoot: string): TarEntry[] {
  const canonicalRoot = realpathSync(packageRoot);
  const nodeModulesRoot = path.join(canonicalRoot, "node_modules");
  const entries: TarEntry[] = [];
  const seenCaseInsensitive = new Set<string>();
  const visit = (absolute: string): void => {
    for (const directoryEntry of readdirSync(absolute, { withFileTypes: true })) {
      const child = path.join(absolute, directoryEntry.name);
      const relative = path.relative(canonicalRoot, child).replaceAll("\\", "/");
      const installationMetadata =
        relative === "node_modules/.package-lock.json" ||
        relative === "node_modules/.bin" ||
        relative.startsWith("node_modules/.bin/");
      const caseKey = relative.toLowerCase();
      if (seenCaseInsensitive.has(caseKey)) throw new Error(`Case-colliding installed path: ${relative}`);
      seenCaseInsensitive.add(caseKey);
      const status = lstatSync(child);
      if (status.isSymbolicLink()) {
        const target = realpathSync(child);
        const targetRelative = path.relative(nodeModulesRoot, target);
        if (targetRelative.startsWith("..") || path.isAbsolute(targetRelative)) {
          throw new Error(`Installed symlink escaped bundled node_modules: ${relative}`);
        }
        continue;
      }
      if (status.isDirectory()) {
        if (!installationMetadata) {
          entries.push({ path: `package/${relative}`, type: "directory", mode: status.mode, data: Buffer.alloc(0) });
        }
        visit(child);
        continue;
      }
      if (!status.isFile()) throw new Error(`Unsupported installed entry type: ${relative}`);
      if (installationMetadata) continue;
      entries.push({ path: `package/${relative}`, type: "file", mode: status.mode, data: readFileSync(child) });
    }
  };
  visit(nodeModulesRoot);
  return entries;
}

export function inspectInstalledBundle(packageRoot: string): BundleArchiveSummary {
  const entries = installedEntries(packageRoot);
  const packages = inspectPackages(entries);
  const files = entries.filter((entry) => entry.type === "file").map((entry) => entry.path.slice("package/".length));
  const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as Record<string, unknown>;
  return {
    packedSizeBytes: 0,
    unpackedSizeBytes: entries.reduce((total, entry) => total + (entry.type === "file" ? entry.data.length : 0), 0),
    bundledPackageCount: packages.length,
    bundledFileCount: packages.reduce((total, item) => total + item.fileCount, 0),
    bundledTreeSha256: treeDigest(packages),
    packages,
    files: files.sort(),
    rootPackageJson: packageJson,
  };
}

function requiredPackage(summary: BundleArchiveSummary, name: string, version: string): BundledPackageRecord {
  const matches = summary.packages.filter((item) => item.name === name);
  if (matches.length !== 1 || matches[0]?.version !== version) {
    throw new Error(`Expected exactly one ${name}@${version}, received ${matches.map((item) => item.version).join(", ") || "none"}`);
  }
  return matches[0];
}

export function verifyBundleSummary(summary: BundleArchiveSummary, manifest: BundleManifest): void {
  if (manifest.schemaVersion !== 1) throw new Error(`Unsupported bundle manifest schema: ${manifest.schemaVersion}`);
  if (JSON.stringify(manifest.directBundles) !== JSON.stringify(["@modelcontextprotocol/sdk"])) {
    throw new Error("Only @modelcontextprotocol/sdk may be directly bundled");
  }
  const rootBundles = summary.rootPackageJson.bundleDependencies;
  if (JSON.stringify(rootBundles) !== JSON.stringify(manifest.directBundles)) {
    throw new Error("Packed package bundleDependencies do not match the approved direct bundle");
  }
  const dependencies = summary.rootPackageJson.dependencies as Record<string, unknown> | undefined;
  if (dependencies?.["@modelcontextprotocol/sdk"] !== "1.29.0") {
    throw new Error("Packed package must depend on @modelcontextprotocol/sdk@1.29.0 exactly");
  }
  const overrides = summary.rootPackageJson.overrides as Record<string, unknown> | undefined;
  const sdkOverride = overrides?.["@modelcontextprotocol/sdk"] as Record<string, unknown> | undefined;
  if (sdkOverride?.["@hono/node-server"] !== "2.0.11") {
    throw new Error("Packed package must override @hono/node-server to 2.0.11 exactly");
  }
  if (canonicalPackages(summary.packages) !== canonicalPackages(manifest.packages)) {
    throw new Error("Bundled package allowlist, metadata, lifecycle scripts, or content digest changed");
  }
  const manifestPaths = manifest.packages.map((item) => item.path);
  if (
    new Set(manifestPaths).size !== manifestPaths.length ||
    new Set(manifestPaths.map((item) => item.toLowerCase())).size !== manifestPaths.length
  ) {
    throw new Error("Bundle manifest contains duplicate or case-colliding package paths");
  }
  if (summary.bundledTreeSha256 !== manifest.bundledTreeSha256) {
    throw new Error("Bundled dependency tree digest changed");
  }
  if (
    summary.bundledPackageCount !== manifest.baseline.bundledPackageCount ||
    summary.bundledFileCount !== manifest.baseline.bundledFileCount
  ) {
    throw new Error("Bundled package or file count changed");
  }
  if (
    summary.packedSizeBytes > manifest.limits.maxPackedSizeBytes ||
    summary.unpackedSizeBytes > manifest.limits.maxUnpackedSizeBytes ||
    summary.bundledPackageCount > manifest.limits.maxBundledPackageCount ||
    summary.bundledFileCount > manifest.limits.maxBundledFileCount
  ) {
    throw new Error("Packed package exceeded an approved bundle size or count limit");
  }
  requiredPackage(summary, "@modelcontextprotocol/sdk", "1.29.0");
  requiredPackage(summary, "@hono/node-server", "2.0.11");
  requiredPackage(summary, "fast-uri", "3.1.4");
  const contentTypeVersions = summary.packages
    .filter((item) => item.name === "content-type")
    .map((item) => item.version)
    .sort();
  if (JSON.stringify(contentTypeVersions) !== JSON.stringify(["1.0.5", "2.0.0", "2.0.0"])) {
    throw new Error(
      `Expected content-type@1.0.5 once and content-type@2.0.0 twice, received ${contentTypeVersions.join(", ")}`,
    );
  }
  if (summary.packages.some((item) => item.name === "@hono/node-server" && item.version.startsWith("1."))) {
    throw new Error("Bundled archive contains a vulnerable @hono/node-server 1.x package");
  }
  if (summary.packages.some((item) => item.name === "fast-uri" && item.version !== "3.1.4")) {
    throw new Error("Bundled archive contains an unapproved fast-uri version");
  }
}
