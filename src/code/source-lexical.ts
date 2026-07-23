import type { IndexedSourceFile } from "../contracts.js";

export interface LexicalSource {
  masked: string;
  executable: boolean[];
}

export function lexicalSource(
  source: string,
  language: IndexedSourceFile["language"],
): LexicalSource {
  const output = source.split("");
  const executable = Array.from({ length: source.length }, () => true);
  const python = language === "python";
  let quote: "'" | "\"" | "`" | "'''" | "\"\"\"" | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1] ?? "";
    if (lineComment) {
      executable[index] = false;
      if (character === "\n" || character === "\r") lineComment = false;
      else output[index] = " ";
      continue;
    }
    if (blockComment) {
      executable[index] = false;
      output[index] = character === "\n" || character === "\r" ? character : " ";
      if (character === "*" && next === "/") {
        executable[index + 1] = false;
        output[index + 1] = " ";
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      executable[index] = false;
      if (source.startsWith(quote, index)) {
        for (let offset = 1; offset < quote.length; offset += 1) executable[index + offset] = false;
        index += quote.length - 1;
        quote = null;
      } else if (quote.length === 1 && character === "\\") {
        executable[index + 1] = false;
        index += 1;
      }
      continue;
    }
    if (python && (source.startsWith("'''", index) || source.startsWith("\"\"\"", index))) {
      quote = source.startsWith("'''", index) ? "'''" : "\"\"\"";
      executable[index] = false;
      executable[index + 1] = false;
      executable[index + 2] = false;
      index += 2;
      continue;
    }
    if (character === "'" || character === "\"" || character === "`") {
      quote = character;
      executable[index] = false;
      continue;
    }
    if (python && character === "#") {
      output[index] = " ";
      executable[index] = false;
      lineComment = true;
      continue;
    }
    if (!python && character === "/" && next === "/") {
      output[index] = " ";
      output[index + 1] = " ";
      executable[index] = false;
      executable[index + 1] = false;
      lineComment = true;
      index += 1;
      continue;
    }
    if (!python && character === "/" && next === "*") {
      output[index] = " ";
      output[index + 1] = " ";
      executable[index] = false;
      executable[index + 1] = false;
      blockComment = true;
      index += 1;
    }
  }
  return { masked: output.join(""), executable };
}

export function* executableMatches(
  source: string,
  expression: RegExp,
  executable: readonly boolean[],
): IterableIterator<RegExpMatchArray> {
  for (const match of source.matchAll(expression)) {
    if (match.index !== undefined && executable[match.index]) yield match;
  }
}
