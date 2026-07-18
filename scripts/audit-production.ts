import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

interface AuditViaAdvisory {
  source: number;
  name: string;
  url: string;
  severity: string;
  range: string;
}

interface AuditVulnerability {
  name: string;
  severity: string;
  isDirect: boolean;
  via: Array<string | AuditViaAdvisory>;
  effects: string[];
}

interface AuditReport {
  vulnerabilities: Record<string, AuditVulnerability>;
}

const WAIVED_ADVISORY = "GHSA-xcpc-8h2w-3j85";
const WAIVER_EXPIRES_AT = "2026-10-18T00:00:00.000Z";
const WAIVED_CHAIN = ["@huggingface/transformers", "onnxruntime-node", "adm-zip"] as const;

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : null;
}

function npmCli(): string {
  const resolved = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
  if (!resolved) throw new Error("Unable to resolve the npm CLI entry point");
  return resolved;
}

function auditJson(cwd: string): string {
  try {
    return execFileSync(process.execPath, [npmCli(), "audit", "--omit=dev", "--json"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch (error) {
    const stdout = (error as { stdout?: string | Buffer }).stdout;
    if (typeof stdout === "string") return stdout;
    if (stdout instanceof Buffer) return stdout.toString("utf8");
    throw error;
  }
}

function isExpectedWaiver(report: AuditReport): boolean {
  const names = Object.keys(report.vulnerabilities).sort();
  const rootNames = [...WAIVED_CHAIN].sort();
  const consumerNames = [...WAIVED_CHAIN, "contextmesh"].sort();
  if (
    JSON.stringify(names) !== JSON.stringify(rootNames) &&
    JSON.stringify(names) !== JSON.stringify(consumerNames)
  ) return false;
  const archive = report.vulnerabilities["adm-zip"];
  const runtime = report.vulnerabilities["onnxruntime-node"];
  const transformers = report.vulnerabilities["@huggingface/transformers"];
  const contextmesh = report.vulnerabilities.contextmesh;
  return Boolean(
    archive?.severity === "high" &&
    archive.isDirect === false &&
    archive.via.some(
      (via) => typeof via !== "string" && via.url.endsWith(WAIVED_ADVISORY) && via.range === "<0.6.0",
    ) &&
    runtime?.severity === "high" &&
    runtime.via.includes("adm-zip") &&
    transformers?.severity === "high" &&
    transformers.via.includes("onnxruntime-node") &&
    (!contextmesh || (
      contextmesh.severity === "high" &&
      contextmesh.isDirect &&
      contextmesh.via.includes("@huggingface/transformers")
    ))
  );
}

const cwd = path.resolve(argument("--cwd") ?? process.cwd());
const report = JSON.parse(auditJson(cwd)) as AuditReport;
const vulnerabilities = Object.keys(report.vulnerabilities);
if (vulnerabilities.length === 0) {
  process.stdout.write(`${JSON.stringify({ productionAudit: "clean", cwd }, null, 2)}\n`);
} else {
  if (!isExpectedWaiver(report)) {
    throw new Error(`Production audit contains an unapproved vulnerability set: ${vulnerabilities.join(", ")}`);
  }
  if (Date.now() >= Date.parse(WAIVER_EXPIRES_AT)) {
    throw new Error(`Security waiver ${WAIVED_ADVISORY} expired at ${WAIVER_EXPIRES_AT}`);
  }
  process.stdout.write(
    `${JSON.stringify({
      productionAudit: "waived",
      advisory: WAIVED_ADVISORY,
      dependencyChain: WAIVED_CHAIN,
      expiresAt: WAIVER_EXPIRES_AT,
      rationale: "onnxruntime-node install-only NuGet extraction; no runtime user ZIP input",
      cwd,
    }, null, 2)}\n`,
  );
}
