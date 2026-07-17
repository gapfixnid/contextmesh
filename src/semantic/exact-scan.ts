import { quantizeScore } from "./ranking.js";

export interface ExactScanRow {
  id: string;
  score: number;
  vector: Float32Array;
}

export interface EncodedEntityIds {
  bytes: Uint8Array;
  offsets: Uint32Array;
  count: number;
}

interface ScoredRow {
  row: number;
  score: number;
}

const SHA256_BYTES = 32;

function hexNibble(character: number): number {
  if (character >= 48 && character <= 57) return character - 48;
  if (character >= 97 && character <= 102) return character - 87;
  if (character >= 65 && character <= 70) return character - 55;
  return -1;
}

export function writeSha256Hex(target: Uint8Array, offset: number, value: string): void {
  if (value.length !== SHA256_BYTES * 2 || offset < 0 || offset + SHA256_BYTES > target.length) {
    throw new Error("Invalid SHA-256 cache metadata");
  }
  for (let index = 0; index < SHA256_BYTES; index += 1) {
    const high = hexNibble(value.charCodeAt(index * 2));
    const low = hexNibble(value.charCodeAt(index * 2 + 1));
    if (high < 0 || low < 0) throw new Error("Invalid SHA-256 cache metadata");
    target[offset + index] = high * 16 + low;
  }
}

function sha256Matches(sourceHashBytes: Uint8Array, row: number, value: string): boolean {
  if (value.length !== SHA256_BYTES * 2) return false;
  const offset = row * SHA256_BYTES;
  for (let index = 0; index < SHA256_BYTES; index += 1) {
    const high = hexNibble(value.charCodeAt(index * 2));
    const low = hexNibble(value.charCodeAt(index * 2 + 1));
    if (high < 0 || low < 0 || sourceHashBytes[offset + index] !== high * 16 + low) return false;
  }
  return true;
}

export function encodeEntityIds(ids: readonly string[]): EncodedEntityIds {
  const offsets = new Uint32Array(ids.length + 1);
  let totalBytes = 0;
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index] ?? "";
    for (let characterIndex = 0; characterIndex < id.length; characterIndex += 1) {
      if (id.charCodeAt(characterIndex) > 0x7f) throw new Error("Semantic entity IDs must be ASCII");
    }
    totalBytes += id.length;
    offsets[index + 1] = totalBytes;
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const id of ids) {
    for (let index = 0; index < id.length; index += 1) bytes[offset++] = id.charCodeAt(index);
  }
  return { bytes, offsets, count: ids.length };
}

function compareEncodedIdToString(entityIds: EncodedEntityIds, row: number, value: string): number {
  const start = entityIds.offsets[row] ?? 0;
  const end = entityIds.offsets[row + 1] ?? start;
  const length = end - start;
  const common = Math.min(length, value.length);
  for (let index = 0; index < common; index += 1) {
    const difference = (entityIds.bytes[start + index] ?? 0) - value.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return length - value.length;
}

function compareEncodedRows(entityIds: EncodedEntityIds, leftRow: number, rightRow: number): number {
  const leftStart = entityIds.offsets[leftRow] ?? 0;
  const leftEnd = entityIds.offsets[leftRow + 1] ?? leftStart;
  const rightStart = entityIds.offsets[rightRow] ?? 0;
  const rightEnd = entityIds.offsets[rightRow + 1] ?? rightStart;
  const common = Math.min(leftEnd - leftStart, rightEnd - rightStart);
  for (let index = 0; index < common; index += 1) {
    const difference =
      (entityIds.bytes[leftStart + index] ?? 0) - (entityIds.bytes[rightStart + index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftEnd - leftStart - (rightEnd - rightStart);
}

function decodeEntityId(entityIds: EncodedEntityIds, row: number): string {
  const start = entityIds.offsets[row] ?? 0;
  const end = entityIds.offsets[row + 1] ?? start;
  let result = "";
  for (let index = start; index < end; index += 1) result += String.fromCharCode(entityIds.bytes[index] ?? 0);
  return result;
}

export function scanNormalizedMatrix(
  matrix: Float32Array,
  entityIds: EncodedEntityIds,
  sourceHashBytes: Uint8Array,
  eligible: ReadonlyMap<string, string>,
  queryVector: Float32Array,
  dimensions: number,
  limit: number,
): { rows: ExactScanRow[]; validEmbeddingCount: number } {
  if (queryVector.length !== dimensions) {
    throw new Error(`Query vector dimension mismatch: expected ${dimensions}, received ${queryVector.length}`);
  }
  if (
    matrix.length !== entityIds.count * dimensions ||
    entityIds.offsets.length !== entityIds.count + 1 ||
    sourceHashBytes.length !== entityIds.count * SHA256_BYTES
  ) {
    throw new Error("Semantic matrix metadata does not match its dimensions");
  }

  const scored: ScoredRow[] = [];
  const eligibleIterator = eligible.entries();
  let eligibleEntry = eligibleIterator.next();
  for (let row = 0; row < entityIds.count; row += 1) {
    while (!eligibleEntry.done && compareEncodedIdToString(entityIds, row, eligibleEntry.value[0]) > 0) {
      eligibleEntry = eligibleIterator.next();
    }
    if (eligibleEntry.done || compareEncodedIdToString(entityIds, row, eligibleEntry.value[0]) !== 0) continue;
    const eligibleSourceHash = eligibleEntry.value[1];
    if (!sha256Matches(sourceHashBytes, row, eligibleSourceHash)) continue;
    let score = 0;
    const offset = row * dimensions;
    for (let index = 0; index < dimensions; index += 1) {
      score += (queryVector[index] ?? 0) * (matrix[offset + index] ?? 0);
    }
    scored.push({ row, score: quantizeScore(score) });
  }
  scored.sort(
    (left, right) =>
      right.score - left.score || compareEncodedRows(entityIds, left.row, right.row),
  );
  return {
    validEmbeddingCount: scored.length,
    rows: scored.slice(0, limit).map((entry) => {
      const offset = entry.row * dimensions;
      return {
        id: decodeEntityId(entityIds, entry.row),
        score: entry.score,
        vector: matrix.slice(offset, offset + dimensions),
      };
    }),
  };
}
