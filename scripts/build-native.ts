import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const release = process.argv.includes("--release");
const root = process.cwd();
const manifest = path.join(root, "native", "graph-kernel", "Cargo.toml");
execFileSync("cargo", ["build", "--locked", "--manifest-path", manifest, ...(release ? ["--release"] : [])], {
  cwd: root,
  stdio: "inherit",
});
if (release) {
  const executable = `contextmesh-graph-kernel${process.platform === "win32" ? ".exe" : ""}`;
  const source = path.join(root, "native", "graph-kernel", "target", "release", executable);
  const destination = path.join(root, "dist", "native", executable);
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}
