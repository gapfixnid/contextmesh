import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";

import {
  APPROVED_MODEL_MANIFEST,
  LOCAL_MODEL_MANIFEST_FILE,
  validateApprovedModelDirectory,
} from "../src/semantic/manifest.js";

function outputPath(): string {
  const index = process.argv.indexOf("--output");
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error("Pass --output <directory> for the CI-only semantic smoke model");
  return path.resolve(value);
}

const output = outputPath();
try {
  await validateApprovedModelDirectory(output);
  process.stdout.write(`Approved semantic smoke model is already present at ${output}\n`);
  process.exit(0);
} catch {
  // Missing or invalid CI artifacts are replaced from the immutable upstream revision below.
}

await mkdir(path.join(output, "onnx"), { recursive: true });
const revision = APPROVED_MODEL_MANIFEST.model.revision;
const repository = APPROVED_MODEL_MANIFEST.model.repository;
for (const file of APPROVED_MODEL_MANIFEST.files) {
  const url = `https://huggingface.co/${repository}/resolve/${revision}/${file.path}?download=true`;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to fetch ${file.path}: HTTP ${response.status}`);
  }
  const target = path.join(output, file.path);
  const partial = `${target}.partial`;
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await pipeline(
      Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
      createWriteStream(partial, { flags: "w" }),
    );
    await rm(target, { force: true });
    await rename(partial, target);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}
await writeFile(
  path.join(output, LOCAL_MODEL_MANIFEST_FILE),
  `${JSON.stringify(APPROVED_MODEL_MANIFEST, null, 2)}\n`,
  "utf8",
);
await validateApprovedModelDirectory(output);
process.stdout.write(`Fetched and verified approved semantic smoke model at ${output}\n`);
