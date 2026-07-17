import { writeFileSync } from "node:fs";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

import { decodeVectorInto, VECTOR_CODEC } from "./vector-codec.js";

const MAGIC = "CMSH4C01";
const HEADER_BYTES = 48;
const SOURCE_HASH_BYTES = 32;

function valueString(value: SQLOutputValue | undefined, name: string): string {
  if (typeof value !== "string") throw new Error(`Packed hydration ${name} is not text`);
  return value;
}

function valueNumber(value: SQLOutputValue | undefined, name: string): number {
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`Packed hydration ${name} is not numeric`);
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`Packed hydration ${name} is invalid`);
  return result;
}

function valueBytes(value: SQLOutputValue | undefined, name: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`Packed hydration ${name} is not a BLOB`);
  return value;
}

function sqlForPlane(plane: string, aggregate: boolean): string {
  const selection = aggregate
    ? "count(*) AS capacity, coalesce(sum(length(embedding.entity_key)), 0) AS id_bytes"
    : `embedding.entity_key, embedding.source_hash, embedding.vector,
       model.dimensions, model.vector_codec AS codec`;
  if (plane === "code") {
    return `SELECT ${selection}
      FROM semantic_embeddings embedding
      JOIN semantic_models model ON model.model_id = embedding.model_id
      JOIN code_nodes node ON node.workspace_id = ? AND node.id = lower(hex(embedding.entity_key))
        AND node.semantic_source_hash = lower(hex(embedding.source_hash))
        AND node.generation = embedding.generation
      JOIN workspaces workspace ON workspace.id = node.workspace_id
        AND workspace.current_generation = node.generation
      WHERE embedding.workspace_key = ? AND embedding.plane = 'code'
        AND model.model_key = ?${aggregate ? "" : " ORDER BY embedding.entity_key"}`;
  }
  if (plane !== "memory") throw new Error(`Unsupported semantic plane: ${plane}`);
  return `SELECT ${selection}
    FROM semantic_embeddings embedding
    JOIN semantic_models model ON model.model_id = embedding.model_id
    JOIN memory_fragments memory ON memory.workspace_id = ?
      AND memory.id = CAST(embedding.entity_key AS TEXT)
      AND memory.semantic_source_hash = lower(hex(embedding.source_hash))
    WHERE embedding.workspace_key = ? AND embedding.plane = 'memory'
      AND model.model_key = ? AND memory.state = 'active'
      AND (memory.expires_at IS NULL OR memory.expires_at > ?)${aggregate ? "" : " ORDER BY embedding.entity_key"}`;
}

function writeAsciiId(
  plane: string,
  entityKey: Uint8Array,
  target: Uint8Array,
  offset: number,
): number {
  if (plane === "code") {
    const value = Buffer.from(entityKey).toString("hex");
    target.set(Buffer.from(value, "ascii"), offset);
    return value.length;
  }
  for (const byte of entityKey) {
    if (byte > 0x7f) throw new Error("Semantic memory entity IDs must be ASCII");
  }
  target.set(entityKey, offset);
  return entityKey.byteLength;
}

const [databasePath, workspaceId, workspaceKeyText, plane, modelKey, timestamp, dimensionsText, outputPath] =
  process.argv.slice(2);
if (
  !databasePath ||
  !workspaceId ||
  !workspaceKeyText ||
  !plane ||
  !modelKey ||
  !timestamp ||
  !dimensionsText ||
  !outputPath
) {
  throw new Error("Packed semantic hydration arguments are incomplete");
}
const workspaceKey = BigInt(workspaceKeyText);
const dimensions = Number(dimensionsText);
if (!Number.isSafeInteger(dimensions) || dimensions <= 0) throw new Error("Packed hydration dimensions are invalid");

const database = new DatabaseSync(databasePath, { readOnly: true, timeout: 30_000 });
try {
  const parameters = plane === "memory"
    ? [workspaceId, workspaceKey, modelKey, timestamp] as const
    : [workspaceId, workspaceKey, modelKey] as const;
  const aggregate = database.prepare(sqlForPlane(plane, true)).get(...parameters);
  const capacity = valueNumber(aggregate?.capacity, "capacity");
  const rawIdBytes = valueNumber(aggregate?.id_bytes, "ID byte count");
  const idCapacity = plane === "code" ? capacity * 64 : rawIdBytes;
  const matrixOffset = HEADER_BYTES;
  const hashesOffset = matrixOffset + capacity * dimensions * Float32Array.BYTES_PER_ELEMENT;
  const offsetsOffset = hashesOffset + capacity * SOURCE_HASH_BYTES;
  const idsOffset = offsetsOffset + (capacity + 1) * Uint32Array.BYTES_PER_ELEMENT;
  const totalBytes = idsOffset + idCapacity;
  if (totalBytes > 128 * 1024 * 1024) throw new Error("Packed hydration output exceeds its safety limit");

  const output = Buffer.alloc(totalBytes);
  output.write(MAGIC, 0, "ascii");
  output.writeUInt32LE(dimensions, 8);
  output.writeUInt32LE(capacity, 12);
  output.writeUInt32LE(0, 16);
  output.writeUInt32LE(0, 20);
  output.writeUInt32LE(matrixOffset, 24);
  output.writeUInt32LE(hashesOffset, 28);
  output.writeUInt32LE(offsetsOffset, 32);
  output.writeUInt32LE(idsOffset, 36);
  output.writeUInt32LE(0, 40);
  output.writeUInt32LE(totalBytes, 44);

  const matrix = new Float32Array(output.buffer, output.byteOffset + matrixOffset, capacity * dimensions);
  const hashes = new Uint8Array(output.buffer, output.byteOffset + hashesOffset, capacity * SOURCE_HASH_BYTES);
  const offsets = new Uint32Array(output.buffer, output.byteOffset + offsetsOffset, capacity + 1);
  const ids = new Uint8Array(output.buffer, output.byteOffset + idsOffset, idCapacity);
  let validCount = 0;
  let invalidRows = 0;
  let idOffset = 0;
  for (const row of database.prepare(sqlForPlane(plane, false)).iterate(...parameters)) {
    try {
      if (valueNumber(row.dimensions, "dimensions") !== dimensions || valueString(row.codec, "codec") !== VECTOR_CODEC) {
        throw new Error("Packed hydration embedding metadata mismatch");
      }
      const entityKey = valueBytes(row.entity_key, "entity key");
      const sourceHash = valueBytes(row.source_hash, "source hash");
      if (sourceHash.byteLength !== SOURCE_HASH_BYTES) throw new Error("Packed hydration source hash is invalid");
      decodeVectorInto(valueBytes(row.vector, "vector"), dimensions, matrix, validCount * dimensions);
      hashes.set(sourceHash, validCount * SOURCE_HASH_BYTES);
      idOffset += writeAsciiId(plane, entityKey, ids, idOffset);
      validCount += 1;
      offsets[validCount] = idOffset;
    } catch {
      invalidRows += 1;
    }
  }
  output.writeUInt32LE(validCount, 16);
  output.writeUInt32LE(invalidRows, 20);
  output.writeUInt32LE(idOffset, 40);
  writeFileSync(outputPath, output, { mode: 0o600 });
} finally {
  database.close();
}
