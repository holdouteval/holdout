interface Decimal { numerator: bigint; scale: number }
function decimal(value: unknown): Decimal | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const source = String(value).trim();
  if (!source || !Number.isFinite(Number(source))) return null;
  const m = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!m) return null;
  if (m[1] === "-" || Number(source) === 0) return { numerator: 0n, scale: 0 };
  const fraction = m[3] ?? m[4] ?? "", whole = m[2] ?? "0";
  let digits = (whole + fraction).replace(/^0+/, "") || "0";
  let scale = fraction.length - Number(m[5] ?? 0);
  while (scale > 0 && digits.endsWith("0")) { digits = digits.slice(0, -1); scale--; }
  if (scale < 0) { digits += "0".repeat(-scale); scale = 0; }
  return { numerator: BigInt(digits || "0"), scale };
}
export function weightMicros(value: string): bigint {
  const parsed = decimal(value); if (!parsed) throw new Error("invalid decision weight");
  return parsed.numerator * 1_000_000n / 10n ** BigInt(parsed.scale);
}
function weightString(micros: bigint): string {
  if (micros === 1_000_000n) return "1";
  return "0." + micros.toString().padStart(6, "0").replace(/0+$/, "");
}
export function normalizeWeights(raw: unknown, symbols: readonly string[]): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const allowed = new Set(symbols.map(s => s.toUpperCase())), values = new Map<string, Decimal>();
  for (const [key, value] of Object.entries(raw)) {
    const symbol = key.toUpperCase(); if (symbol === "USDG" || !allowed.has(symbol)) continue;
    const n = decimal(value); if (n) values.set(symbol, n);
  }
  const scale = Math.max(0, ...[...values.values()].map(v => v.scale)), denominator = 10n ** BigInt(scale);
  const integers = new Map([...values].map(([symbol, v]) => [symbol, v.numerator * 10n ** BigInt(scale - v.scale)]));
  const total = [...integers.values()].reduce((a, b) => a + b, 0n), divisor = total > denominator ? total : denominator;
  const weights: Record<string, string> = {};
  for (const symbol of symbols) {
    const n = integers.get(symbol.toUpperCase()) ?? 0n, micros = n * 1_000_000n / divisor;
    if (micros > 0n) weights[symbol.toUpperCase()] = weightString(micros);
  }
  return weights;
}

