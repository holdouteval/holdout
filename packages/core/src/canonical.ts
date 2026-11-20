import { createHash } from "node:crypto";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function validString(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("unpaired surrogate");
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new Error("unpaired surrogate");
    }
  }
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean": return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new Error("number is not an allowed integer");
      return String(value);
    case "string":
      validString(value);
      return JSON.stringify(value);
    case "object": {
      if (ancestors.has(value)) throw new Error("cyclic value");
      const proto = Object.getPrototypeOf(value);
      if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) throw new Error("non-JSON object");
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          const result: string[] = [];
          for (let i = 0; i < value.length; i++) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
            if (!descriptor) throw new Error("sparse array");
            if (!("value" in descriptor)) throw new Error("accessor property");
            result.push(serialize(descriptor.value, ancestors));
          }
          return "[" + result.join(",") + "]";
        }
        if (Object.getOwnPropertySymbols(value).length) throw new Error("symbol key");
        return "{" + Object.keys(value).sort().map((key) => {
          validString(key);
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor || !("value" in descriptor)) throw new Error("accessor property");
          return JSON.stringify(key) + ":" + serialize(descriptor.value, ancestors);
        }).join(",") + "}";
      } finally { ancestors.delete(value); }
    }
    default: throw new Error("non-JSON value");
  }
}

export function canonicalize(value: unknown): Uint8Array {
  return new TextEncoder().encode(serialize(value, new Set()));
}

export function parseCanonical(bytes: Uint8Array): JsonValue {
  if (!(bytes instanceof Uint8Array)) throw new Error("expected bytes");
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error("BOM is not allowed");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("invalid JSON or UTF-8"); }
  const encoded = canonicalize(value);
  if (encoded.length !== bytes.length || encoded.some((byte, i) => byte !== bytes[i])) throw new Error("non-canonical bytes");
  return value as JsonValue;
}

export function sha256Hex(bytes: Uint8Array): `0x${string}` {
  return "0x" + createHash("sha256").update(bytes).digest("hex") as `0x${string}`;
}
