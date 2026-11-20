import { ADDRESSES } from "@holdout/core";
import type { LaneConfig, Listing, Snapshot } from "../src/types.js";

export const lane: LaneConfig = { lane: "0x" + "1".repeat(40), agent: "0x" + "2".repeat(40), model: "claude-fable-5-2", review: "auto", keyFile: "unused" };
export const rpc = { async request<T>(): Promise<T> { throw new Error("unexpected RPC"); } };
export function listing(count = 3): Listing {
  return { principal: "1000000000", maxAge: 90000, actWindow: 1800, assets: ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG"].slice(0, count).map((symbol, index) => {
    const token = "0x" + (index + 10).toString(16).padStart(40, "0"), [currency0, currency1] = [ADDRESSES.usdg, token].sort();
    return { symbol, token, feed: "0x" + (index + 100).toString(16).padStart(40, "0"), assetId: index,
      pools: [{ index, token, poolId: "0x" + (index + 1).toString(16).padStart(64, "0"), key: { currency0, currency1, fee: 100, tickSpacing: 1, hooks: "0x" + "0".repeat(40) } }] };
  }) };
}
export function snapshot(assets = listing()): Snapshot {
  return { block: 101, time: 1794582000, value: "1000000000", ledger: { [ADDRESSES.usdg]: "1000000000" }, blocked: false,
    assets: assets.assets.map(a => ({ symbol: a.symbol, token: a.token, feed: a.feed, roundId: "18446744073709551617", answer: 10000000000,
      updatedAt: 1794578400, age: 3600, gate: "open", buyCostBps: 10, sellCostBps: 15, closes: [["2026-11-12", 9900000000], ["2026-11-11", null]] })), history: [] };
}
