import { normalizeWeights } from "@holdout/core";

/** Reject invalid targets before applying the shared millionth precision. */
export function strictWeights(raw: unknown, symbols: readonly string[]): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid-weights");
  const allowed = new Set(symbols.map(symbol => symbol.toUpperCase()));
  const values: { numerator: bigint; scale: number }[] = [];
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(raw)) {
    const symbol = key.toUpperCase();
    if (symbol === "USDG" || !allowed.has(symbol) || seen.has(symbol)) throw new Error("invalid-weights");
    seen.add(symbol);
    if (typeof value !== "number" && typeof value !== "string") throw new Error("invalid-weights");
    const source = String(value).trim();
    const match = /^(?:\+)?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(source);
    if (!match || !Number.isFinite(Number(source)) || Number(source) < 0 || Number(source) > 1) throw new Error("invalid-weights");
    const fraction = match[2] ?? match[3] ?? "";
    let scale = fraction.length - Number(match[4] ?? 0);
    let digits = ((match[1] ?? "0") + fraction).replace(/^0+/, "") || "0";
    if (scale < 0) { digits += "0".repeat(-scale); scale = 0; }
    values.push({ numerator: BigInt(digits), scale });
  }
  const scale = Math.max(0, ...values.map(value => value.scale));
  const sum = values.reduce((total, value) => total + value.numerator * 10n ** BigInt(scale - value.scale), 0n);
  if (sum > 10n ** BigInt(scale)) throw new Error("invalid-weights");
  return normalizeWeights(raw, symbols);
}
