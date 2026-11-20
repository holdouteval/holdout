import { ADDRESSES } from "@holdout/core";
import type { Snapshot } from "./types.js";

export const SYSTEM = "You are the decision step of a public trading lane. You manage one lane with real stakes. Use only the data in the user message. Do not ask questions. Reply with one JSON object only.";
export const EXECUTION_RULE = "After your reply the lane sells first, then buys, in one transaction on the listed pools. Each order must fill completely and return at least its quote minus 0.5%, or the whole transaction reverts. A buy whose gate is not \"open\" is not placed; that amount stays in USDG. Differences under 1 USDG are not traded.";

export function shortenReason(reason: string): string {
  const points = Array.from(reason); return points.length > 400 ? points.slice(0, 400).join("") + "…" : reason;
}
function fixed(value: bigint, decimals: number, places = 2, group = false): string {
  const negative = value < 0n; if (negative) value = -value;
  const unit = 10n ** BigInt(decimals), placesUnit = 10n ** BigInt(places);
  const rounded = (value * placesUnit + unit / 2n) / unit;
  let whole = (rounded / placesUnit).toString();
  if (group) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (negative ? "-" : "") + whole + (places ? "." + (rounded % placesUnit).toString().padStart(places, "0") : "");
}
const day = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);
const cost = (bps: number | null) => bps === null ? "n/a" : fixed(BigInt(bps), 2, 2) + "%";

export function buildPrompt(snapshot: Snapshot, options: { openedTime: number; principal: string }): { system: string; user: string } {
  const iso = new Date(snapshot.time * 1000).toISOString(), principal = BigInt(options.principal), value = BigInt(snapshot.value);
  const cash = BigInt(snapshot.ledger[ADDRESSES.usdg] ?? "0"), count = snapshot.assets.length;
  const lines = [
    `Time: ${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC, 30 minutes after the US regular-session open.`,
    `Lane: opened ${day(options.openedTime)} with ${fixed(principal, 6, 2, true)} USDG. No deposits after opening. Long only, no leverage.`,
    `Assets: USDG (cash) and the ${count} Robinhood Chain stock tokens below. Prices are Chainlink feed values in USD (corporate actions already included).`,
    `Each session you set target weights for any of the ${count} tokens; the rest stays in USDG. Weights are 0..1 and must sum to at most 1. ${EXECUTION_RULE} Your weights stay as positions (they drift with prices) until your next decision at the same time next session.`,
    "",
  ];
  const change = principal > 0n ? (value - principal) * 10000n / principal : 0n;
  lines.push(`Lane now: value ${fixed(value, 6, 2, true)} USDG (${change >= 0n ? "+" : ""}${fixed(change, 2)}% since opening); cash ${fixed(cash, 6, 2, true)} USDG.`);
  const held = snapshot.assets.filter(a => BigInt(snapshot.ledger[a.token] ?? "0") > 0n);
  lines.push(held.length ? "Holdings: " + held.map(a => {
    const quantity = BigInt(snapshot.ledger[a.token]), valued = quantity * BigInt(a.answer) / 10n ** 20n;
    return `${a.symbol} ${fixed(quantity, 18, 6)} (=${fixed(valued, 6, 2, true)} USDG)`;
  }).join("; ") : "Holdings: none");
  if (snapshot.history.length) {
    lines.push("Your last decisions (most recent first):");
    for (const history of snapshot.history) {
      const weights = Object.entries(history.weights).sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0], "en"))
        .map(([symbol, amount]) => `${symbol} ${Number(amount).toFixed(2)}`).join(", ") || "all USDG";
      lines.push(`- ${history.date}: ${weights}. Reason: ${shortenReason(history.reason)}`);
    }
  }
  lines.push("");
  const dates = snapshot.assets[0]?.closes.map(([date]) => date) ?? [];
  lines.push(["token", "buy cost", "sell cost", "gate", "feed age", "now", ...dates.map(d => d.slice(5) + " close")].join(" | "));
  for (const asset of snapshot.assets) {
    lines.push([asset.symbol, cost(asset.buyCostBps), cost(asset.sellCostBps), asset.gate,
      fixed(BigInt(asset.age), 0, 0) === "0" ? "0.00h" : fixed(BigInt(asset.age) * 100n / 3600n, 2) + "h",
      asset.answer > 0 ? fixed(BigInt(asset.answer), 8) : "n/a",
      ...asset.closes.map(([, answer]) => answer === null ? "n/a" : fixed(BigInt(answer), 8))].join(" | "));
  }
  lines.push("", 'Reply with only: {"weights": {"SYM": weight, ...}, "reason": "one or two sentences"}');
  return { system: SYSTEM, user: lines.join("\n") };
}
