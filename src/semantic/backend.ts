import type { ApprovedModelManifest } from "./manifest.js";

export type SemanticPlane = "code" | "memory";
export type SemanticEffectiveValue = number | string | "not_observable" | "not_applicable";

export interface SemanticRuntimeDiagnostics {
  requestedSessionOptions: {
    intraOpNumThreads: 4;
    interOpNumThreads: 1;
    executionMode: "sequential";
  };
  resolvedBackend: string;
  requestedExecutionProviders: readonly ["cpu"];
  effectiveExecutionProvider: SemanticEffectiveValue;
  effectiveIntraOpThreads: SemanticEffectiveValue;
  effectiveInterOpThreads: "not_applicable";
  verificationMethod: string[];
  observedModelPath: string;
  observedModelSha256: string;
}

export interface EmbeddingBackend {
  readonly modelKey: string;
  readonly dimensions: number;
  readonly manifest: ApprovedModelManifest;
  readonly diagnostics: SemanticRuntimeDiagnostics;
  embedQuery(text: string): Promise<Float32Array>;
  embedPassages(texts: string[]): Promise<Float32Array[]>;
  dispose(): Promise<void>;
}

export type EmbeddingBackendFactory = (modelPath: string) => Promise<EmbeddingBackend>;
