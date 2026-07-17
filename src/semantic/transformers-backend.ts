import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import type { FeatureExtractionPipeline } from "@huggingface/transformers";

import type { EmbeddingBackend, SemanticRuntimeDiagnostics } from "./backend.js";
import {
  APPROVED_MODEL_KEY,
  APPROVED_MODEL_MANIFEST,
  type ApprovedModelManifest,
  validateApprovedModelDirectory,
} from "./manifest.js";

const require = createRequire(import.meta.url);
let runtimeLoaded = false;

export function isTransformersRuntimeLoaded(): boolean {
  return runtimeLoaded;
}

function resolvedPackageVersion(specifier: string, expectedName: string): string {
  let current = path.dirname(require.resolve(specifier));
  for (let depth = 0; depth < 8; depth += 1) {
    const packagePath = path.join(current, "package.json");
    if (existsSync(packagePath)) {
      const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: string; version?: string };
      if (packageJson.name === expectedName && packageJson.version) return packageJson.version;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not resolve package metadata for ${expectedName}`);
}

function validateVector(vector: Float32Array, dimensions: number): void {
  if (vector.length !== dimensions) {
    throw new Error(`Embedding dimension mismatch: expected ${dimensions}, received ${vector.length}`);
  }
  let squaredNorm = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error("Embedding contains a non-finite value");
    squaredNorm += value * value;
  }
  const norm = Math.sqrt(squaredNorm);
  if (norm === 0 || Math.abs(norm - 1) > 0.001) {
    throw new Error(`Embedding is not L2-normalized: norm=${norm}`);
  }
}

export class TransformersEmbeddingBackend implements EmbeddingBackend {
  readonly modelKey = APPROVED_MODEL_KEY;
  readonly dimensions = APPROVED_MODEL_MANIFEST.model.dimensions;
  readonly manifest: ApprovedModelManifest = APPROVED_MODEL_MANIFEST;
  readonly diagnostics: SemanticRuntimeDiagnostics;
  private readonly extractor: FeatureExtractionPipeline;
  private disposed = false;

  private constructor(extractor: FeatureExtractionPipeline, diagnostics: SemanticRuntimeDiagnostics) {
    this.extractor = extractor;
    this.diagnostics = diagnostics;
  }

  static async create(modelDirectory: string): Promise<TransformersEmbeddingBackend> {
    const validated = await validateApprovedModelDirectory(modelDirectory);
    const [{ env, pipeline }, ort] = await Promise.all([
      import("@huggingface/transformers"),
      import("onnxruntime-node"),
    ]);
    runtimeLoaded = true;
    const transformersVersion = resolvedPackageVersion("@huggingface/transformers", "@huggingface/transformers");
    const ortVersion = resolvedPackageVersion("onnxruntime-node", "onnxruntime-node");
    if (transformersVersion !== APPROVED_MODEL_MANIFEST.backend.version) {
      throw new Error(
        `Transformers.js version mismatch: expected ${APPROVED_MODEL_MANIFEST.backend.version}, received ${transformersVersion}`,
      );
    }
    if (ortVersion !== APPROVED_MODEL_MANIFEST.backend.moduleVersion) {
      throw new Error(
        `onnxruntime-node version mismatch: expected ${APPROVED_MODEL_MANIFEST.backend.moduleVersion}, received ${ortVersion}`,
      );
    }
    if (typeof ort.InferenceSession?.create !== "function" || typeof ort.listSupportedBackends !== "function") {
      throw new Error("onnxruntime-node did not expose the expected Node inference API");
    }

    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = validated.rootPath;
    env.useFS = true;
    env.useBrowserCache = false;
    env.useFSCache = false;
    env.useCustomCache = false;
    env.useWasmCache = false;

    const requestedSessionOptions = {
      ...APPROVED_MODEL_MANIFEST.backend.requestedSessionOptions,
      executionProviders: [...APPROVED_MODEL_MANIFEST.backend.requestedExecutionProviders],
    };
    const extractor = await pipeline("feature-extraction", validated.rootPath, {
      local_files_only: true,
      revision: APPROVED_MODEL_MANIFEST.model.revision,
      device: "cpu",
      dtype: "q8",
      subfolder: "onnx",
      model_file_name: "model",
      session_options: requestedSessionOptions,
    });
    const modelFile = APPROVED_MODEL_MANIFEST.files.find(
      (file) => file.path === APPROVED_MODEL_MANIFEST.model.modelFile,
    );
    if (!modelFile) throw new Error("Approved model manifest does not identify the ONNX file");
    return new TransformersEmbeddingBackend(extractor, {
      requestedSessionOptions: APPROVED_MODEL_MANIFEST.backend.requestedSessionOptions,
      resolvedBackend: `onnxruntime-node@${ortVersion}`,
      requestedExecutionProviders: APPROVED_MODEL_MANIFEST.backend.requestedExecutionProviders,
      effectiveExecutionProvider: "not_observable",
      effectiveIntraOpThreads: "not_observable",
      effectiveInterOpThreads: "not_applicable",
      verificationMethod: [
        "module_resolution",
        "approved_manifest_sha256",
        "restricted_model_directory",
        "adapter_instrumentation",
        "session_creation",
      ],
      observedModelPath: validated.modelPath,
      observedModelSha256: modelFile.sha256,
    });
  }

  private async embed(texts: string[], prefix: string): Promise<Float32Array[]> {
    if (this.disposed) throw new Error("Semantic embedding backend has been disposed");
    if (texts.length === 0) return [];
    const output = await this.extractor(
      texts.map((text) => `${prefix}${text.normalize("NFC")}`),
      { pooling: "mean", normalize: true },
    );
    const expectedLength = texts.length * this.dimensions;
    if (output.type !== "float32" || output.data.length !== expectedLength) {
      throw new Error(
        `Unexpected embedding output: type=${output.type}, length=${output.data.length}, expected=${expectedLength}`,
      );
    }
    const result: Float32Array[] = [];
    const data = output.data as Float32Array;
    for (let index = 0; index < texts.length; index += 1) {
      const vector = data.slice(index * this.dimensions, (index + 1) * this.dimensions);
      validateVector(vector, this.dimensions);
      result.push(vector);
    }
    return result;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const vector = (await this.embed([text], APPROVED_MODEL_MANIFEST.preprocessing.queryPrefix))[0];
    if (!vector) throw new Error("Query embedding did not return a vector");
    return vector;
  }

  embedPassages(texts: string[]): Promise<Float32Array[]> {
    return this.embed(texts, APPROVED_MODEL_MANIFEST.preprocessing.passagePrefix);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.extractor.dispose();
  }
}

export async function createTransformersEmbeddingBackend(modelPath: string): Promise<EmbeddingBackend> {
  return TransformersEmbeddingBackend.create(modelPath);
}
