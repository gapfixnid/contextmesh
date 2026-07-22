import { describe, expect, it } from "vitest";

import {
  byteOffsetToLspPosition,
  createLspTextIndex,
  lspPositionToByteOffset,
} from "../src/code/languages/rust-precision.js";

describe("rust-analyzer LSP text positions", () => {
  it("round-trips UTF-8 and UTF-16 positions across CRLF, CR, Korean, and emoji", () => {
    const source = "fn 첫째() {}\r\nfn 둘째😀() {}\rfn 셋째() {}\n";
    const index = createLspTextIndex(source);
    const offsets = [
      Buffer.byteLength("fn ", "utf8"),
      Buffer.byteLength("fn 첫째() {}\r\nfn 둘째", "utf8"),
      Buffer.byteLength("fn 첫째() {}\r\nfn 둘째😀", "utf8"),
      Buffer.byteLength("fn 첫째() {}\r\nfn 둘째😀() {}\rfn 셋째", "utf8"),
    ];

    for (const encoding of ["utf-8", "utf-16"] as const) {
      for (const offset of offsets) {
        const position = byteOffsetToLspPosition(index, offset, encoding);
        expect(position).not.toBeNull();
        expect(lspPositionToByteOffset(index, position!, encoding)).toBe(offset);
      }
    }
  });

  it("rejects non-boundary bytes, surrogate-pair interiors, and out-of-range characters", () => {
    const source = "한😀글\nnext";
    const index = createLspTextIndex(source);
    expect(byteOffsetToLspPosition(index, 1, "utf-8")).toBeNull();
    expect(lspPositionToByteOffset(index, { line: 0, character: 2 }, "utf-16")).toBeNull();
    expect(lspPositionToByteOffset(index, { line: 0, character: 99 }, "utf-16")).toBeNull();
    expect(lspPositionToByteOffset(index, { line: 0, character: 99 }, "utf-8")).toBeNull();
    expect(lspPositionToByteOffset(index, { line: 99, character: 0 }, "utf-16")).toBeNull();
  });
});
