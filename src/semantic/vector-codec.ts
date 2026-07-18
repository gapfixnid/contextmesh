export const VECTOR_CODEC = "f32le-v1" as const;

const HOST_IS_LITTLE_ENDIAN = (() => {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, 0x0102, true);
  return new Uint16Array(bytes.buffer)[0] === 0x0102;
})();

export class InvalidSemanticVectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSemanticVectorError";
  }
}

export function validateNormalizedVector(vector: Float32Array, dimensions: number): Float32Array {
  if (vector.length !== dimensions) {
    throw new InvalidSemanticVectorError(
      `Semantic vector dimension mismatch: expected ${dimensions}, received ${vector.length}`,
    );
  }
  let squaredNorm = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new InvalidSemanticVectorError("Semantic vector contains a non-finite value");
    squaredNorm += value * value;
  }
  const norm = Math.sqrt(squaredNorm);
  if (norm === 0 || Math.abs(norm - 1) > 0.001) {
    throw new InvalidSemanticVectorError(`Semantic vector is not L2-normalized: norm=${norm}`);
  }
  return vector;
}

export function encodeVector(vector: Float32Array, dimensions = vector.length): Uint8Array {
  validateNormalizedVector(vector, dimensions);
  const bytes = new Uint8Array(dimensions * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < dimensions; index += 1) {
    view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, vector[index] ?? 0, true);
  }
  return bytes;
}

export function decodeVector(bytes: Uint8Array, dimensions: number): Float32Array {
  const vector = new Float32Array(dimensions);
  decodeVectorInto(bytes, dimensions, vector, 0);
  return vector;
}

export function validateEncodedVector(bytes: Uint8Array, dimensions: number): void {
  decodeAndValidate(bytes, dimensions);
}

export function decodeVectorInto(
  bytes: Uint8Array,
  dimensions: number,
  target: Float32Array,
  targetOffset: number,
): void {
  const expectedLength = dimensions * Float32Array.BYTES_PER_ELEMENT;
  if (bytes.byteLength !== expectedLength) {
    throw new InvalidSemanticVectorError(
      `Semantic vector byte length mismatch: expected ${expectedLength}, received ${bytes.byteLength}`,
    );
  }
  if (targetOffset < 0 || targetOffset + dimensions > target.length) {
    throw new InvalidSemanticVectorError("Semantic vector target range is out of bounds");
  }
  if (!HOST_IS_LITTLE_ENDIAN) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < dimensions; index += 1) {
      target[targetOffset + index] = view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
    }
  } else {
    new Uint8Array(
      target.buffer,
      target.byteOffset + targetOffset * Float32Array.BYTES_PER_ELEMENT,
      expectedLength,
    ).set(bytes);
  }
  validateNormalizedRange(target, targetOffset, dimensions);
}

function validateNormalizedRange(vector: Float32Array, offset: number, dimensions: number): void {
  let squaredNorm = 0;
  for (let index = 0; index < dimensions; index += 1) {
    const value = vector[offset + index]!;
    if (!Number.isFinite(value)) throw new InvalidSemanticVectorError("Semantic vector contains a non-finite value");
    squaredNorm += value * value;
  }
  const norm = Math.sqrt(squaredNorm);
  if (norm === 0 || Math.abs(norm - 1) > 0.001) {
    throw new InvalidSemanticVectorError(`Semantic vector is not L2-normalized: norm=${norm}`);
  }
}

function decodeAndValidate(
  bytes: Uint8Array,
  dimensions: number,
  write?: (index: number, value: number) => void,
): void {
  const expectedLength = dimensions * Float32Array.BYTES_PER_ELEMENT;
  if (bytes.byteLength !== expectedLength) {
    throw new InvalidSemanticVectorError(
      `Semantic vector byte length mismatch: expected ${expectedLength}, received ${bytes.byteLength}`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let squaredNorm = 0;
  for (let index = 0; index < dimensions; index += 1) {
    const value = view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
    if (!Number.isFinite(value)) throw new InvalidSemanticVectorError("Semantic vector contains a non-finite value");
    squaredNorm += value * value;
    write?.(index, value);
  }
  const norm = Math.sqrt(squaredNorm);
  if (norm === 0 || Math.abs(norm - 1) > 0.001) {
    throw new InvalidSemanticVectorError(`Semantic vector is not L2-normalized: norm=${norm}`);
  }
}

export function dotProduct(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) throw new InvalidSemanticVectorError("Cannot compare vectors with different dimensions");
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += (left[index] ?? 0) * (right[index] ?? 0);
  return score;
}
