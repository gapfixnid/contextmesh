import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const expected = {
  cpu: process.env.CONTEXTMESH_PERF_CPU ?? null,
  logicalCpuCount: process.env.CONTEXTMESH_PERF_LOGICAL_CPUS
    ? Number(process.env.CONTEXTMESH_PERF_LOGICAL_CPUS)
    : null,
  minimumRamBytes: process.env.CONTEXTMESH_PERF_MIN_RAM_BYTES
    ? Number(process.env.CONTEXTMESH_PERF_MIN_RAM_BYTES)
    : null,
  powerMode: process.env.CONTEXTMESH_PERF_POWER_MODE ?? null,
};

function activePowerMode(): string {
  if (process.platform === "win32") {
    try {
      return execFileSync("powercfg.exe", ["/getactivescheme"], { encoding: "utf8" })
        .replace(/\s+/gu, " ")
        .trim();
    } catch {
      // A locked-down runner can expose a provisioned value instead.
    }
  }
  return process.env.CONTEXTMESH_POWER_MODE ?? "not_observable";
}

const actual = {
  cpu: os.cpus()[0]?.model.trim() ?? "unknown",
  logicalCpuCount: os.cpus().length,
  totalRamBytes: os.totalmem(),
  availableRamBytes: os.freemem(),
  powerMode: activePowerMode(),
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
};
const configured = Boolean(
  expected.cpu && expected.logicalCpuCount && expected.minimumRamBytes && expected.powerMode,
);
const matches = Boolean(
  configured &&
    actual.cpu.includes(expected.cpu!) &&
    actual.logicalCpuCount === expected.logicalCpuCount &&
    actual.totalRamBytes >= expected.minimumRamBytes! &&
    actual.powerMode.includes(expected.powerMode!),
);
const report = {
  eligibleForBlockingPerformanceGate: matches,
  resultMode: matches ? "blocking" : "informational_machine_mismatch",
  expected,
  actual,
};
const outputPath = path.resolve(process.env.CONTEXTMESH_RUNNER_REPORT ?? "performance-runner.json");
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `eligible=${matches ? "true" : "false"}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!matches) {
  throw new Error("RUNNER_CONFIGURATION_FAILURE: fixed performance runner does not match its manifest");
}
