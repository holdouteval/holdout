import { decodeErrorResult } from "viem";
import { FACTORY_ABI, LANE_ABI } from "./abi.js";
import { sanitize } from "./rpc.js";

export interface DecodedRevert { name: string; args: unknown[] }
const secrets = new Set<string>();

export function registerSecret(value: string): void { if (value) secrets.add(value); }
export function secretValues(): readonly string[] { return [...secrets]; }
export function redactSecrets(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = value;
  else if (value instanceof Error) text = value.message;
  else { try { text = JSON.stringify(value, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry); } catch { text = "operation failed"; } }
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = String(text).split(secret).join("[secret]");
  return String(text);
}
export function safeError(value: unknown): string { return redactSecrets(sanitize(redactSecrets(value))); }

function normalized(value: unknown): unknown {
  if (typeof value === "bigint" || typeof value === "number" && Number.isInteger(value)) return value.toString();
  if (typeof value === "string" && /^0x[0-9a-f]*$/i.test(value)) return value.toLowerCase();
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalized(entry)]));
  return value;
}
export function decodeRevert(data: string): DecodedRevert {
  const raw = /^0x(?:[0-9a-f]{2})*$/i.test(data) ? data.toLowerCase() : "0x";
  try {
    const result = decodeErrorResult({ abi: [...LANE_ABI, ...FACTORY_ABI], data: raw as `0x${string}` });
    return { name: result.errorName, args: (result.args ?? []).map(normalized) };
  } catch { return { name: "Reverted", args: [raw] }; }
}

/** Extract explicit EVM data without treating text or transport diagnostics as a revert. */
export function revertData(error: unknown): `0x${string}` | null {
  const seen = new Set<object>();
  const visit = (value: unknown): `0x${string}` | null => {
    if (typeof value === "string") {
      if (/^0x(?:[0-9a-f]{2})*$/i.test(value)) return value.toLowerCase() as `0x${string}`;
      if (value.startsWith("{")) { try { return visit(JSON.parse(value)); } catch {} }
      return null;
    }
    if (!value || typeof value !== "object" || seen.has(value)) return null;
    seen.add(value);
    const record = value as Record<string, unknown>;
    for (const key of ["data", "returnData", "return", "result", "error", "originalError", "cause", "info", "body"]) {
      const found = visit(record[key]); if (found !== null) return found;
    }
    return null;
  };
  return visit(error);
}
