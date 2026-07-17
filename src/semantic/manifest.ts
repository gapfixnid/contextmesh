import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const LOCAL_MODEL_MANIFEST_FILE = "contextmesh-model-manifest.json";

export interface ApprovedModelFile {
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface ApprovedModelManifest {
  manifestVersion: 1;
  backend: {
    package: "@huggingface/transformers";
    version: "4.2.0";
    module: "onnxruntime-node";
    moduleVersion: "1.24.3";
    device: "cpu";
    requestedExecutionProviders: readonly ["cpu"];
    requestedSessionOptions: {
      intraOpNumThreads: 4;
      interOpNumThreads: 1;
      executionMode: "sequential";
    };
  };
  model: {
    repository: "Xenova/multilingual-e5-small";
    revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
    modelFile: "onnx/model_quantized.onnx";
    dtype: "q8";
    dimensions: 384;
    outputType: "float32";
  };
  preprocessing: {
    queryPrefix: "query: ";
    passagePrefix: "passage: ";
    pooling: "mean";
    normalize: true;
    maxLength: 512;
    truncation: true;
    padding: "longest_in_batch";
  };
  textBuilderVersion: 1;
  sourceHashVersion: 1;
  vectorCodec: "f32le-v1";
  files: readonly ApprovedModelFile[];
}

export const APPROVED_MODEL_MANIFEST: ApprovedModelManifest = {
  manifestVersion: 1,
  backend: {
    package: "@huggingface/transformers",
    version: "4.2.0",
    module: "onnxruntime-node",
    moduleVersion: "1.24.3",
    device: "cpu",
    requestedExecutionProviders: ["cpu"],
    requestedSessionOptions: {
      intraOpNumThreads: 4,
      interOpNumThreads: 1,
      executionMode: "sequential",
    },
  },
  model: {
    repository: "Xenova/multilingual-e5-small",
    revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
    modelFile: "onnx/model_quantized.onnx",
    dtype: "q8",
    dimensions: 384,
    outputType: "float32",
  },
  preprocessing: {
    queryPrefix: "query: ",
    passagePrefix: "passage: ",
    pooling: "mean",
    normalize: true,
    maxLength: 512,
    truncation: true,
    padding: "longest_in_batch",
  },
  textBuilderVersion: 1,
  sourceHashVersion: 1,
  vectorCodec: "f32le-v1",
  files: [
    {
      path: "onnx/model_quantized.onnx",
      sizeBytes: 118_308_185,
      sha256: "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
    },
    {
      path: "config.json",
      sizeBytes: 658,
      sha256: "cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1",
    },
    {
      path: "quant_config.json",
      sizeBytes: 674,
      sha256: "59d175f15264115f18c698d76e443b5d49fc6c8c599911c421405ef4f236e87d",
    },
    {
      path: "tokenizer.json",
      sizeBytes: 17_082_730,
      sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
    },
    {
      path: "sentencepiece.bpe.model",
      sizeBytes: 5_069_051,
      sha256: "cfc8146abe2a0488e9e2a0c56de7952f7c11ab059eca145a0a727afce0db2865",
    },
    {
      path: "special_tokens_map.json",
      sizeBytes: 167,
      sha256: "d05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7",
    },
    {
      path: "tokenizer_config.json",
      sizeBytes: 443,
      sha256: "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b",
    },
  ],
};

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export const APPROVED_MODEL_KEY = createHash("sha256")
  .update(canonicalJson(APPROVED_MODEL_MANIFEST))
  .digest("hex");

export class SemanticModelValidationError extends Error {
  readonly reason:
    | "MODEL_DIRECTORY_MISSING"
    | "MANIFEST_MISSING"
    | "MANIFEST_INVALID"
    | "MODEL_FILE_MISSING"
    | "MODEL_FILE_OUTSIDE_ROOT"
    | "MODEL_FILE_SIZE_MISMATCH"
    | "MODEL_FILE_HASH_MISMATCH";

  constructor(reason: SemanticModelValidationError["reason"], message: string) {
    super(message);
    this.name = "SemanticModelValidationError";
    this.reason = reason;
  }
}

async function fileSha256(filePath: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

function isWithinRoot(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export interface ValidatedModelDirectory {
  rootPath: string;
  manifestPath: string;
  manifestDigest: string;
  modelPath: string;
  verifiedFiles: Array<{ path: string; canonicalPath: string; sizeBytes: number; sha256: string }>;
}

export async function validateApprovedModelDirectory(modelDirectory: string): Promise<ValidatedModelDirectory> {
  const requestedRoot = path.resolve(modelDirectory);
  if (!existsSync(requestedRoot)) {
    throw new SemanticModelValidationError(
      "MODEL_DIRECTORY_MISSING",
      `Semantic model directory does not exist: ${requestedRoot}`,
    );
  }
  const rootPath = await realpath(requestedRoot);
  const manifestPath = path.join(rootPath, LOCAL_MODEL_MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    throw new SemanticModelValidationError(
      "MANIFEST_MISSING",
      `Semantic model manifest is missing: ${manifestPath}`,
    );
  }
  let localManifest: unknown;
  try {
    localManifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  } catch (error) {
    throw new SemanticModelValidationError(
      "MANIFEST_INVALID",
      `Semantic model manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (canonicalJson(localManifest) !== canonicalJson(APPROVED_MODEL_MANIFEST)) {
    throw new SemanticModelValidationError(
      "MANIFEST_INVALID",
      `Semantic model manifest does not match approved model key ${APPROVED_MODEL_KEY}`,
    );
  }

  const verifiedFiles: ValidatedModelDirectory["verifiedFiles"] = [];
  for (const file of APPROVED_MODEL_MANIFEST.files) {
    const requestedPath = path.resolve(rootPath, file.path);
    if (!existsSync(requestedPath)) {
      throw new SemanticModelValidationError("MODEL_FILE_MISSING", `Approved model file is missing: ${file.path}`);
    }
    const canonicalPath = await realpath(requestedPath);
    if (!isWithinRoot(rootPath, canonicalPath)) {
      throw new SemanticModelValidationError(
        "MODEL_FILE_OUTSIDE_ROOT",
        `Approved model file resolves outside the model directory: ${file.path}`,
      );
    }
    const fileStat = await stat(canonicalPath);
    if (!fileStat.isFile() || fileStat.size !== file.sizeBytes) {
      throw new SemanticModelValidationError(
        "MODEL_FILE_SIZE_MISMATCH",
        `Approved model file size mismatch for ${file.path}: expected ${file.sizeBytes}, received ${fileStat.size}`,
      );
    }
    const digest = await fileSha256(canonicalPath);
    if (digest !== file.sha256) {
      throw new SemanticModelValidationError(
        "MODEL_FILE_HASH_MISMATCH",
        `Approved model file hash mismatch for ${file.path}: expected ${file.sha256}, received ${digest}`,
      );
    }
    verifiedFiles.push({ path: file.path, canonicalPath, sizeBytes: fileStat.size, sha256: digest });
  }
  const model = verifiedFiles.find((file) => file.path === APPROVED_MODEL_MANIFEST.model.modelFile);
  if (!model) {
    throw new SemanticModelValidationError("MODEL_FILE_MISSING", "Approved ONNX model file was not verified");
  }
  return {
    rootPath,
    manifestPath,
    manifestDigest: APPROVED_MODEL_KEY,
    modelPath: model.canonicalPath,
    verifiedFiles,
  };
}
