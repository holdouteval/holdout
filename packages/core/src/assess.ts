import { ADDRESSES } from "./chain.js";
import { readMarkets, safeInteger, type ReadRpc } from "./lane.js";
import { quoteExactInput } from "./quote.js";
import type { OrderGate, OrderListing } from "./orders.js";

export interface AssessedAsset {
  symbol: string; token: string; feed: string; roundId: string; answer: number; updatedAt: number; age: number;
  paused: boolean; oraclePaused: boolean; gate: OrderGate; buyCostBps: number | null; sellCostBps: number | null;
}
export interface AssessOptions {
  rpc: ReadRpc; listing: OrderListing; lane: string; block: number; accessRegistry: string; time: number; maxAge?: number;
  read?: { markets?: typeof readMarkets; quote?: typeof quoteExactInput };
}
export async function assess(options: AssessOptions): Promise<{ blocked: boolean; assets: AssessedAsset[] }> {
  const { rpc, block, accessRegistry } = options, read = options.read ?? {}, lane = { lane: options.lane }, header = { time: options.time };
  const listing = options.maxAge === undefined ? options.listing : { ...options.listing, maxAge: options.maxAge };
  const market = await (read.markets ?? readMarkets)(rpc, listing.assets.map(a => ({ ...a, assetOf: a.assetId + 1 })), lane.lane, block, accessRegistry);
  const assets: AssessedAsset[] = [];
  const amount = 250_000_000n, quote = read.quote ?? quoteExactInput;
  for (let i = 0; i < listing.assets.length; i++) {
    const asset = listing.assets[i], state = market.assets[i];
    if (state.token !== asset.token) throw new Error("market listing order mismatch");
    const answer = safeInteger(state.answer), updatedAt = state.updatedAt, age = Math.max(0, header.time - updatedAt);
    let buy: bigint | null = null, sell: bigint | null = null;
    for (const pool of asset.pools) {
      try { const out = await quote(rpc, pool.key, pool.key.currency0 === ADDRESSES.usdg, amount, block); if (out > 0n && (buy === null || out > buy)) buy = out; } catch { /* A failed pool does not mask another listed pool. */ }
      if (state.answer > 0n) {
        const quantity = amount * 10n ** 20n / state.answer;
        try { const out = await quote(rpc, pool.key, pool.key.currency0 === asset.token, quantity, block); if (out > 0n && (sell === null || out > sell)) sell = out; } catch { /* An unavailable sell cost is shown as n/a. */ }
      }
    }
    const valued = buy !== null && state.answer > 0n ? buy * state.answer / 10n ** 20n : null;
    const buyCostBps = valued !== null && valued > 0n ? safeInteger((amount - valued) * 10000n / valued) : null;
    const sellCostBps = sell !== null ? safeInteger((amount - sell) * 10000n / amount) : null;
    const gate = state.paused ? "TokenPaused" : state.oraclePaused ? "OracleFlagged" : market.blocked ? "LaneBlocked"
      : state.answer <= 0n || updatedAt === 0 ? "BadFeed" : age > listing.maxAge ? "StaleFeed" : valued !== null && valued > amount ? "DiscountToFeed" : "open";
    assets.push({ symbol: asset.symbol, token: asset.token, feed: asset.feed, roundId: state.roundId.toString(), answer, updatedAt, age,
      paused: state.paused, oraclePaused: state.oraclePaused, gate, buyCostBps, sellCostBps });
  }
  return { blocked: market.blocked, assets };
}
