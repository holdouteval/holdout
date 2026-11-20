import { ADDRESSES } from "../src/chain.js";
import type { OrderListing, OrderSnapshot } from "../src/orders.js";

export const lane = { lane: "0x" + "1".repeat(40), agent: "0x" + "2".repeat(40) };
export const rpc = { async request<T>(): Promise<T> { throw new Error("unexpected RPC"); } };
export function listing(count = 3): OrderListing {
  return { maxAge: 90000, actWindow: 1800, assets: ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG"].slice(0, count).map((symbol, index) => {
    const token = "0x" + (index + 10).toString(16).padStart(40, "0"), [currency0, currency1] = [ADDRESSES.usdg, token].sort();
    return { symbol, token, feed: "0x" + (index + 100).toString(16).padStart(40, "0"), assetId: index,
      pools: [{ index, token, poolId: "0x" + (index + 1).toString(16).padStart(64, "0"), key: { currency0, currency1, fee: 100, tickSpacing: 1, hooks: "0x" + "0".repeat(40) } }] };
  }) };
}
export function snapshot(assets = listing()): OrderSnapshot {
  return { value: "1000000000", ledger: { [ADDRESSES.usdg]: "1000000000" }, blocked: false,
    assets: assets.assets.map(a => ({ token: a.token, answer: 10000000000, gate: "open" })) };
}
