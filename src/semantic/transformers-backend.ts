import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import type { FeatureExtractionPipeline } from "@huggingface/transformers";

import type { EmbeddingBackend, SemanticRuntimeDiagnostics } from "./backend.js";
import { AsyncMutex } from "../concurrency.js";
import {
  APPROVED_MODEL_KEY,
  APPROVED_MODEL_MANIFEST,
  type ApprovedModelManifest,
  validateApprovedModelDirectory,
} from "./manifest.js";

const require = createRequire(import.meta.url);
let runtimeLoaded = false;
const backendCreationMutex = new AsyncMutex();

interface OrtCreateObservation {
  canonicalModelPath: string | null;
  modelSha256: string | null;
  sessionOptions: Record<string, unknown>;
}

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

async function fileSha256(filePath: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk as Buffer);
  return digest.digest("hex");
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
    return backendCreationMutex.runExclusive(() => TransformersEmbeddingBackend.createExclusive(modelDirectory));
  }

  private static async createExclusive(modelDirectory: string): Promise<TransformersEmbeddingBackend> {
    const validated = await validateApprovedModelDirectory(modelDirectory);
    const ortModule = await import("onnxruntime-node");
    const instrumentedSession = ortModule.InferenceSession as unknown as {
      create: (...arguments_: unknown[]) => Promise<unknown>;
    };
    const originalCreate = instrumentedSession.create;
    const observations: OrtCreateObservation[] = [];
    instrumentedSession.create = async (...arguments_: unknown[]): Promise<unknown> => {
      const model = arguments_[0];
      const sessionOptions =
        arguments_[1] && typeof arguments_[1] === "object"
          ? { ...(arguments_[1] as Record<string, unknown>) }
          : {};
      const canonicalModelPath = typeof model === "string" ? await realpath(model) : null;
      const modelSha256 = canonicalModelPath ? await fileSha256(canonicalModelPath) : null;
      observations.push({ canonicalModelPath, modelSha256, sessionOptions });
      return originalCreate.apply(instrumentedSession, arguments_);
    };
    let extractor: FeatureExtractionPipeline | null = null;
    try {
      const { env, pipeline } = await import("@huggingface/transformers");
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
      if (
        typeof ortModule.InferenceSession?.create !== "function" ||
        typeof ortModule.listSupportedBackends !== "function"
      ) {
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
      extractor = await pipeline("feature-extraction", validated.rootPath, {
        local_files_only: true,
        revision: APPROVED_MODEL_MANIFEST.model.revision,
        device: "cpu",
        dtype: "q8",
        subfolder: "onnx",
        model_file_name: "model",
        session_options: requestedSessionOptions,
      });
      if (extractor.tokenizer.model_max_length !== APPROVED_MODEL_MANIFEST.preprocessing.maxLength) {
        throw new Error(
          `Tokenizer maximum length mismatch: expected ${APPROVED_MODEL_MANIFEST.preprocessing.maxLength}, received ${String(extractor.tokenizer.model_max_length)}`,
        );
      }
      const modelFile = APPROVED_MODEL_MANIFEST.files.find(
        (file) => file.path === APPROVED_MODEL_MANIFEST.model.modelFile,
      );
      if (!modelFile) throw new Error("Approved model manifest does not identify the ONNX file");
      if (observations.length !== 1) {
        throw new Error(`Expected one observed ONNX session, received ${observations.length}`);
      }
      const observation = observations[0]!;
      if (
        observation.canonicalModelPath !== validated.modelPath ||
        observation.modelSha256 !== modelFile.sha256
      ) {
        throw new Error(
          `Transformers.js selected an unapproved ONNX file: path=${observation.canonicalModelPath ?? "buffer"}, sha256=${observation.modelSha256 ?? "not_observable"}`,
        );
      }
      const observedProviders = observation.sessionOptions.executionProviders;
      if (
        observation.sessionOptions.intraOpNumThreads !== 4 ||
        observation.sessionOptions.interOpNumThreads !== 1 ||
        observation.sessionOptions.executionMode !== "sequential" ||
        !Array.isArray(observedProviders) ||
        observedProviders.length !== 1 ||
        observedProviders[0] !== "cpu"
      ) {
        throw new Error("Transformers.js did not pass the approved CPU session options to onnxruntime-node");
      }
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
          "ort_create_instrumentation",
          "actual_model_path_sha256",
          "tokenizer_max_length_512",
          "pipeline_dynamic_padding_truncation",
          "session_creation",
        ],
        observedModelPath: validated.modelPath,
        observedModelSha256: modelFile.sha256,
      });
    } catch (error) {
      if (extractor) await extractor.dispose();
      throw error;
    } finally {
      instrumentedSession.create = originalCreate;
    }
  }

  private async embed(texts: string[], prefix: string): Promise<Float32Array[]> {
    if (this.disposed) throw new Error("Semantic embedding backend has been disposed");
    if (texts.length === 0) return [];
    const output = await this.extractor(
      texts.map((text) => `${prefix}${text.normalize("NFC")}`),
      {
        pooling: APPROVED_MODEL_MANIFEST.preprocessing.pooling,
        normalize: APPROVED_MODEL_MANIFEST.preprocessing.normalize,
      },
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
    if (!this.diagnostics.verificationMethod.includes("inference_smoke")) {
      this.diagnostics.verificationMethod.push("inference_smoke");
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
    this.diagnostics.verificationMethod.push("async_dispose");
  }
}

export async function createTransformersEmbeddingBackend(modelPath: string): Promise<EmbeddingBackend> {
  return TransformersEmbeddingBackend.create(modelPath);
}
