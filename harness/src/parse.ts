import { normalizeWeights } from "@holdout/core";
import type { Decision } from "./types.js";
export { normalizeWeights, weightMicros } from "@holdout/core";

/** Find the final valid object suffix containing weights, ignoring surrounding prose. */
export function parseDecision(text: string, symbols: readonly string[]): Decision | null {
  const end = text.lastIndexOf("}"); if (end < 0) return null;
  for (let start = text.indexOf("{"); start >= 0 && start < end; start = text.indexOf("{", start + 1)) {
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "weights")) continue;
      const { weights, reason } = value as Record<string, unknown>;
      if (!weights || typeof weights !== "object" || Array.isArray(weights)) return null;
      return { weights: normalizeWeights(weights, symbols), reason: typeof reason === "string" ? reason : "" };
    } catch { /* A preceding object or prose may precede the valid final object. */ }
  }
  return null;
}
