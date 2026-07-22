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

const ADM_ZIP_ADVISORY = "GHSA-xcpc-8h2w-3j85";
const ADM_ZIP_EXPIRES_AT = "2026-10-18T00:00:00.000Z";
const ADM_ZIP_CHAIN = ["contextmesh", "@huggingface/transformers", "onnxruntime-node", "adm-zip"] as const;
const SHARP_ADVISORY = "GHSA-f88m-g3jw-g9cj";
const SHARP_EXPIRES_AT = "2026-08-31T00:00:00.000Z";
const SHARP_CHAIN = ["contextmesh", "@huggingface/transformers", "sharp"] as const;

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

function sameStrings(actual: string[], expected: readonly string[]): boolean {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function hasExactAdvisory(
  vulnerability: AuditVulnerability | undefined,
  advisory: string,
  range: string,
): boolean {
  if (!vulnerability) return false;
  const advisories = vulnerability.via.filter(
    (via): via is AuditViaAdvisory => typeof via !== "string",
  );
  return vulnerability.via.length === 1 && advisories.length === 1 && Boolean(
    advisories[0]?.url.endsWith(advisory) &&
    advisories[0]?.range === range &&
    advisories[0]?.severity === "high",
  );
}

function isExpectedWaiverSet(report: AuditReport): boolean {
  const names = Object.keys(report.vulnerabilities).sort();
  const rootNames = ["@huggingface/transformers", "onnxruntime-node", "adm-zip", "sharp"];
  const consumerNames = [...rootNames, "contextmesh"];
  if (!sameStrings(names, rootNames) && !sameStrings(names, consumerNames)) return false;
  const archive = report.vulnerabilities["adm-zip"];
  const runtime = report.vulnerabilities["onnxruntime-node"];
  const transformers = report.vulnerabilities["@huggingface/transformers"];
  const sharp = report.vulnerabilities.sharp;
  const contextmesh = report.vulnerabilities.contextmesh;
  const advisoryUrls = Object.values(report.vulnerabilities).flatMap((vulnerability) =>
    vulnerability.via
      .filter((via): via is AuditViaAdvisory => typeof via !== "string")
      .map((via) => via.url),
  );
  if (
    advisoryUrls.length !== 2 ||
    !advisoryUrls.some((url) => url.endsWith(ADM_ZIP_ADVISORY)) ||
    !advisoryUrls.some((url) => url.endsWith(SHARP_ADVISORY))
  ) return false;
  return Boolean(
    archive?.severity === "high" &&
    archive.isDirect === false &&
    hasExactAdvisory(archive, ADM_ZIP_ADVISORY, "<0.6.0") &&
    runtime?.severity === "high" &&
    sameStrings(runtime.via.filter((via): via is string => typeof via === "string"), ["adm-zip"]) &&
    transformers?.severity === "high" &&
    sameStrings(
      transformers.via.filter((via): via is string => typeof via === "string"),
      ["onnxruntime-node", "sharp"],
    ) &&
    sharp?.severity === "high" &&
    sharp.isDirect === false &&
    hasExactAdvisory(sharp, SHARP_ADVISORY, "<0.35.0") &&
    (!contextmesh || (
      contextmesh.severity === "high" &&
      contextmesh.isDirect &&
      sameStrings(
        contextmesh.via.filter((via): via is string => typeof via === "string"),
        ["@huggingface/transformers"],
      )
    ))
  );
}

const cwd = path.resolve(argument("--cwd") ?? process.cwd());
const report = JSON.parse(auditJson(cwd)) as AuditReport;
const vulnerabilities = Object.keys(report.vulnerabilities);
if (vulnerabilities.length === 0) {
  process.stdout.write(`${JSON.stringify({ productionAudit: "clean", cwd }, null, 2)}\n`);
} else {
  if (!isExpectedWaiverSet(report)) {
    throw new Error(`Production audit contains an unapproved vulnerability set: ${vulnerabilities.join(", ")}`);
  }
  for (const waiver of [
    { advisory: ADM_ZIP_ADVISORY, expiresAt: ADM_ZIP_EXPIRES_AT },
    { advisory: SHARP_ADVISORY, expiresAt: SHARP_EXPIRES_AT },
  ]) {
    if (Date.now() >= Date.parse(waiver.expiresAt)) {
      throw new Error(`Security waiver ${waiver.advisory} expired at ${waiver.expiresAt}`);
    }
  }
  process.stdout.write(
    `${JSON.stringify({
      productionAudit: "waived",
      waivers: [
        {
          advisory: ADM_ZIP_ADVISORY,
          severity: "high",
          dependencyChain: ADM_ZIP_CHAIN,
          expiresAt: ADM_ZIP_EXPIRES_AT,
          rationale: "onnxruntime-node install-only NuGet extraction; no runtime user ZIP input",
        },
        {
          advisory: SHARP_ADVISORY,
          severity: "high",
          dependencyChain: SHARP_CHAIN,
          expiresAt: SHARP_EXPIRES_AT,
          rationale: "Transformers.js may load sharp, but ContextMesh exposes only text feature extraction and accepts no image, audio, multimodal, Buffer, file, or URL media input",
        },
      ],
      cwd,
    }, null, 2)}\n`,
  );
}
