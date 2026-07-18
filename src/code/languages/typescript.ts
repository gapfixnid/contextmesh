import { readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

import { normalizePathKey, sha256 } from "../../utils.js";
import type { LanguageAdapter, PrecisionProvider, ProjectDescriptor, ProjectDiscoveryInput, SyntaxGraphBatch, SyntaxProvider } from "../providers.js";

export interface TypeScriptCompilerConfiguration {
  options: ts.CompilerOptions;
  diagnostics: string[];
  fatalDiagnostics: string[];
  configHash: string;
  hasConfig: boolean;
  configuredFileNames: Set<string>;
}

export interface TypeScriptProjectRuntime {
  compiler: TypeScriptCompilerConfiguration;
}

function diagnosticText(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  if (!diagnostic.file || diagnostic.start === undefined) return message;
  const location = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${diagnostic.file.fileName}:${location.line + 1}:${location.character + 1} ${message}`;
}

function canonicalizeCompilerValue(value: unknown, caseSensitivePaths: boolean): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    const normalized = value.normalize("NFC").replaceAll("\\", "/");
    return path.isAbsolute(value) ? normalizePathKey(value, caseSensitivePaths) : normalized;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalizeCompilerValue(item, caseSensitivePaths));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (key === "configFile") continue;
      const normalized = canonicalizeCompilerValue((value as Record<string, unknown>)[key], caseSensitivePaths);
      if (normalized !== undefined) result[key] = normalized;
    }
    return result;
  }
  return String(value);
}

export function discoverTypeScriptProject(rootPath: string, input: ProjectDiscoveryInput = {}): ProjectDescriptor {
  const caseSensitivePaths = input.caseSensitivePaths ?? ts.sys.useCaseSensitiveFileNames;
  const diagnostics: string[] = [];
  const fatalDiagnostics: string[] = [];
  const configPath = ["tsconfig.json", "jsconfig.json"].map((name) => path.join(rootPath, name)).find(ts.sys.fileExists);
  let options: ts.CompilerOptions = {
    allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, jsx: ts.JsxEmit.Preserve,
  };
  let configuredFileNames = (input.sourceFiles ?? []).map((file) => normalizePathKey(file.absolutePath, caseSensitivePaths));
  const configContents = new Map<string, string>();
  const trackedReadFile = (fileName: string): string | undefined => {
    const content = ts.sys.readFile(fileName);
    if (content !== undefined && fileName.toLocaleLowerCase("en-US").endsWith(".json")) {
      configContents.set(normalizePathKey(fileName, caseSensitivePaths), content);
    }
    return content;
  };
  if (configPath) {
    const normalizedConfigPath = configPath.replaceAll("\\", "/");
    const config = ts.readConfigFile(normalizedConfigPath, trackedReadFile);
    if (config.error) {
      const message = diagnosticText(config.error); diagnostics.push(message); fatalDiagnostics.push(message); configuredFileNames = [];
    } else {
      const parsed = ts.parseJsonConfigFileContent(config.config, {
        useCaseSensitiveFileNames: caseSensitivePaths, fileExists: ts.sys.fileExists,
        readFile: trackedReadFile, readDirectory: ts.sys.readDirectory,
      }, rootPath, { allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true }, normalizedConfigPath);
      for (const diagnostic of parsed.errors) {
        const message = diagnosticText(diagnostic); diagnostics.push(message);
        if (diagnostic.category === ts.DiagnosticCategory.Error && diagnostic.code !== 18002 && diagnostic.code !== 18003) fatalDiagnostics.push(message);
      }
      options = { ...parsed.options, allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true };
      configuredFileNames = parsed.fileNames.map((fileName) => normalizePathKey(path.resolve(fileName), caseSensitivePaths));
    }
  }
  let packageJson = "";
  try { packageJson = readFileSync(path.join(rootPath, "package.json"), "utf8"); } catch { /* optional */ }
  configuredFileNames = [...new Set(configuredFileNames)].sort();
  const configFiles = [...configContents.entries()].map(([fileName, content]) => ({ fileName, contentHash: sha256(content) }))
    .sort((left, right) => left.fileName.localeCompare(right.fileName));
  const configHash = sha256(JSON.stringify({
    typescriptVersion: ts.version,
    configPath: configPath ? normalizePathKey(configPath, caseSensitivePaths) : null,
    configuredFileNames,
    effectiveCompilerOptions: canonicalizeCompilerValue(options, caseSensitivePaths),
    configFiles,
    packageJsonHash: sha256(packageJson),
  }));
  const compiler: TypeScriptCompilerConfiguration = {
    options, diagnostics, fatalDiagnostics, configHash, hasConfig: configPath !== undefined,
    configuredFileNames: new Set(configuredFileNames),
  };
  return {
    language: "typescript/javascript", ecosystem: "npm", sourceRoots: [""], configHash,
    diagnostics, runtime: { compiler } satisfies TypeScriptProjectRuntime,
  };
}

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

  discoverProject(rootPath: string, input?: ProjectDiscoveryInput): ProjectDescriptor {
    return discoverTypeScriptProject(rootPath, input);
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
