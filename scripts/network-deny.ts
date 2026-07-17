import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function installNetworkDenyGuard(errorCode = "NETWORK_DENIED_BY_CONTEXTMESH_GATE"): () => void {
  const restores: Array<() => void> = [];
  const deny = (): never => {
    throw new Error(errorCode);
  };
  const replace = (target: Record<string, unknown>, key: string): void => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor || descriptor.configurable === false) return;
    Object.defineProperty(target, key, { ...descriptor, value: deny });
    restores.push(() => Object.defineProperty(target, key, descriptor));
  };
  const globalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  if (globalDescriptor?.configurable) {
    Object.defineProperty(globalThis, "fetch", { ...globalDescriptor, value: deny });
    restores.push(() => Object.defineProperty(globalThis, "fetch", globalDescriptor));
  }
  for (const [moduleName, keys] of [
    ["node:http", ["request", "get"]],
    ["node:https", ["request", "get"]],
    ["node:net", ["connect", "createConnection"]],
    ["node:tls", ["connect"]],
    ["node:dns", ["lookup", "resolve"]],
  ] as const) {
    const module = require(moduleName) as Record<string, unknown>;
    for (const key of keys) replace(module, key);
  }
  return () => {
    for (const restore of restores.reverse()) restore();
  };
}
