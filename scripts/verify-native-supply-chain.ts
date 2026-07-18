import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const manifest = JSON.parse(readFileSync(path.join(root, "docs", "graph-kernel.manifest.json"), "utf8")) as {
  protocol: string; runtimeNetwork: string; crates: Record<string, string>; grammars: Array<{ crate: string; version: string }>;
};
const cargo = readFileSync(path.join(root, "native", "graph-kernel", "Cargo.toml"), "utf8");
const lock = readFileSync(path.join(root, "native", "graph-kernel", "Cargo.lock"), "utf8");
if (manifest.protocol !== "contextmesh.graph-kernel/v1" || manifest.runtimeNetwork !== "denied") throw new Error("Native manifest protocol/network policy mismatch");
for (const [name, version] of Object.entries(manifest.crates)) {
  if (!cargo.includes(`${name} = "=${version}"`) && !cargo.includes(`${name} = { version = "=${version}"`)) throw new Error(`Cargo.toml does not exactly pin ${name}@${version}`);
  const stanza = lock.split("[[package]]").find((item) => item.includes(`name = "${name}"`) && item.includes(`version = "${version}"`));
  if (!stanza?.includes("checksum = ")) throw new Error(`Cargo.lock checksum missing for ${name}@${version}`);
}
for (const grammar of manifest.grammars) if (!manifest.crates[grammar.crate] || manifest.crates[grammar.crate] !== grammar.version) throw new Error(`Grammar registry mismatch: ${grammar.crate}`);
process.stdout.write(`${JSON.stringify({ protocol: manifest.protocol, exactPins: Object.keys(manifest.crates).length, lockChecksums: true, runtimeNetwork: 0 })}\n`);
