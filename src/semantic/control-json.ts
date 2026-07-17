import { createHash } from "node:crypto";

export type ControlJsonValue =
  | null
  | boolean
  | number
  | string
  | ControlJsonValue[]
  | { [key: string]: ControlJsonValue };

function compareUtf16(left: string, right: string): number {
  const common = Math.min(left.length, right.length);
  for (let index = 0; index < common; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

export function canonicalControlJson(value: ControlJsonValue): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Control JSON only supports finite numbers");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalControlJson).join(",")}]`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Control JSON only supports plain objects");
  }
  return `{${Object.keys(value)
    .sort(compareUtf16)
    .map((key) => `${JSON.stringify(key)}:${canonicalControlJson(value[key]!)}`)
    .join(",")}}`;
}

export function controlDigest(value: ControlJsonValue): string {
  return createHash("sha256").update(canonicalControlJson(value), "utf8").digest("hex");
}
