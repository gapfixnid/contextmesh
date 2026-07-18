import ts from "typescript";

import type { LanguageAdapter, PrecisionProvider, ProjectDescriptor, SyntaxGraphBatch, SyntaxProvider } from "../providers.js";

/**
 * Capability descriptor for the legacy-compatible TS/JS pipeline. CodeIndexer owns
 * the shared Program lifetime; syntax declarations and TypeChecker relations are
 * committed as one batch so the v0.2 IDs and edge goldens remain unchanged.
 */
export class TypeScriptLanguageAdapter implements LanguageAdapter {
  readonly languageId = "typescript/javascript";
  readonly ecosystem = "npm";
  readonly extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const;
  private readonly extractSharedProgram: SyntaxProvider["extract"];
  private readonly refineSharedProgram: (project: ProjectDescriptor, batch: SyntaxGraphBatch) => Promise<SyntaxGraphBatch>;

  constructor(
    extractSharedProgram: SyntaxProvider["extract"],
    refineSharedProgram: (project: ProjectDescriptor, batch: SyntaxGraphBatch) => Promise<SyntaxGraphBatch>,
  ) {
    this.extractSharedProgram = extractSharedProgram;
    this.refineSharedProgram = refineSharedProgram;
  }

  discoverProject(): ProjectDescriptor {
    return { language: this.languageId, ecosystem: this.ecosystem, sourceRoots: [""], configHash: "", diagnostics: [] };
  }

  createSyntaxProvider(): SyntaxProvider {
    return {
      id: "typescript_compiler_ast",
      version: ts.version,
      extract: this.extractSharedProgram,
    };
  }

  createPrecisionProvider(project: ProjectDescriptor): PrecisionProvider {
    return {
      id: "typescript_type_checker",
      version: ts.version,
      refine: async (batch: SyntaxGraphBatch) => this.refineSharedProgram(project, batch),
    };
  }
}
