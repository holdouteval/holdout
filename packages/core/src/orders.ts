import { encodeFunctionData, keccak256, toHex } from "viem";
import { ADDRESSES } from "./chain.js";
import { LANE_ABI } from "./abi.js";
import { decodeRevert, revertData } from "./errors.js";
import { legsHash } from "./legs.js";
import { quoteExactInput } from "./quote.js";
import { readLaneState, type PoolKey, type ReadRpc } from "./lane.js";
import { weightMicros } from "./weights.js";

export type OrderGate = "open" | "TokenPaused" | "OracleFlagged" | "LaneBlocked" | "BadFeed" | "StaleFeed" | "DiscountToFeed";
export interface OrderPool { index: number; token: string; key: PoolKey; poolId: string }
export interface OrderAsset { assetId: number; symbol: string; token: string; feed: string; pools: OrderPool[] }
export interface OrderListing { maxAge: number; actWindow: number; assets: OrderAsset[] }
export interface OrderSnapshot {
  ledger: Record<string, string>; value: string; blocked: boolean;
  assets: { token: string; answer: number; gate: string }[];
}
export interface OrderDecision { weights: Record<string, string>; reason?: string }
export interface ExecutionError { name: string; args: unknown[] }
export interface OrderLeg { symbol: string; pool: number; buy: boolean; amountIn: string; minOut: string; quoteOut: string }
export interface DroppedLeg { leg: OrderLeg; error: ExecutionError }
export interface Orders {
  quoteBlock: number | null; legs: OrderLeg[]; dropped: DroppedLeg[]; legsHash: string;
  simulation: { result: "passed" | "failed" | "unavailable"; error: ExecutionError | null };
}
type ListedAsset = OrderAsset;
type ListedPool = OrderPool;
type Listing = OrderListing;
type Snapshot = OrderSnapshot;
type Decision = OrderDecision;

export const MAX = (1n << 256n) - 1n;
export const ZERO_HASH = "0x" + "0".repeat(64);
export const SIM = keccak256(toHex("holdout.harness.simulation"));
const UNIT = 10n ** 20n, MIN = 1_000_000n;
const buyErrors = new Set(["NotListed", "TokenPaused", "OracleFlagged", "BadFeed", "StaleFeed", "DiscountToFeed"]);
export function emptyOrders(quoteBlock: number | null = null): Orders {
  return { quoteBlock, legs: [], dropped: [], legsHash: ZERO_HASH, simulation: { result: "unavailable", error: null } };
}
type Quote = typeof quoteExactInput;
export interface BuildOrdersOptions {
  rpc: ReadRpc; snapshot: Snapshot; listing: Listing; lane: string; agent: string; quoteBlock: number; decision: Decision; virtual?: boolean;
  quote?: Quote; simulate?: (legs: OrderLeg[]) => Promise<ExecutionError | null>;
}
function missing(asset: ListedAsset, buy: boolean, amount: bigint): OrderLeg {
  return { symbol: asset.symbol, pool: asset.pools[0].index, buy, amountIn: amount.toString(), minOut: "0", quoteOut: "0" };
}
async function best(rpc: ReadRpc, asset: ListedAsset, buy: boolean, amount: bigint, recordedAmount: bigint, block: number, quote: Quote): Promise<OrderLeg | null> {
  let choice: { pool: ListedPool; out: bigint } | null = null;
  for (const pool of asset.pools) {
    try {
      const out = await quote(rpc, pool.key, pool.key.currency0 === (buy ? ADDRESSES.usdg : asset.token), amount, block);
      if (out > 0n && (!choice || out > choice.out)) choice = { pool, out };
    } catch { /* Another listed pool may still quote the entire amount. */ }
  }
  return choice && { symbol: asset.symbol, pool: choice.pool.index, buy, amountIn: recordedAmount.toString(), minOut: (choice.out * 995n / 1000n).toString(), quoteOut: choice.out.toString() };
}
async function simulateTrade(options: BuildOrdersOptions, legs: OrderLeg[]): Promise<ExecutionError | null> {
  const data = encodeFunctionData({ abi: LANE_ABI, functionName: "trade", args: [SIM, legs.map(l => ({ pool: BigInt(l.pool), buy: l.buy, amountIn: BigInt(l.amountIn), minOut: BigInt(l.minOut) }))] });
  try { await options.rpc.request("eth_call", [{ from: options.agent, to: options.lane, data }, "0x" + options.quoteBlock.toString(16)]); return null; }
  catch (error) { const data = revertData(error); if (data !== null) return decodeRevert(data); throw error; }
}
export async function buildOrders(options: BuildOrdersOptions): Promise<Orders> {
  const { rpc, snapshot, listing, quoteBlock, decision } = options, result = emptyOrders(quoteBlock);
  if (snapshot.blocked) return result;
  const quote = options.quote ?? quoteExactInput, wants: { asset: ListedAsset; amount: bigint; gate: string }[] = [];
  const dropped: DroppedLeg[] = result.dropped;
  let budget = BigInt(snapshot.ledger[ADDRESSES.usdg] ?? "0");
  for (const asset of listing.assets) {
    const state = snapshot.assets.find(a => a.token === asset.token); if (!state) throw new Error("snapshot listing mismatch");
    const quantity = BigInt(snapshot.ledger[asset.token] ?? "0"), value = quantity * BigInt(state.answer) / UNIT;
    const weight = weightMicros(decision.weights[asset.symbol] ?? "0"), target = BigInt(snapshot.value) * weight / 1_000_000n;
    if (quantity > 0n && (weight === 0n || value > target && value - target >= MIN)) {
      const amount = weight === 0n ? MAX : quantity * (value - target) / value;
      const leg = await best(rpc, asset, false, amount === MAX ? quantity : amount, amount, quoteBlock, quote);
      if (leg) { result.legs.push(leg); budget += BigInt(leg.minOut); }
      else dropped.push({ leg: missing(asset, false, amount), error: { name: "QuoteUnavailable", args: [] } });
    }
    if (target - value >= MIN) wants.push({ asset, amount: target - value, gate: state.gate });
  }
  const wanted = wants.reduce((sum, w) => sum + w.amount, 0n);
  for (const want of wants) {
    const amount = wanted > budget ? want.amount * budget / wanted : want.amount;
    if (amount < MIN) continue;
    if (want.gate !== "open") {
      dropped.push({ leg: missing(want.asset, true, amount), error: { name: want.gate, args: [want.asset.token] } }); continue;
    }
    const leg = await best(rpc, want.asset, true, amount, amount, quoteBlock, quote);
    if (leg) result.legs.push(leg);
    else dropped.push({ leg: missing(want.asset, true, amount), error: { name: "QuoteUnavailable", args: [] } });
  }
  if (!options.virtual) {
    const simulate = options.simulate ?? ((legs: OrderLeg[]) => simulateTrade(options, legs));
    for (let retries = result.legs.length; ; retries--) {
      if (!result.legs.length) { result.simulation = { result: "passed", error: null }; break; }
      const error = await simulate(result.legs);
      if (!error) { result.simulation = { result: "passed", error: null }; break; }
      const token = typeof error.args[0] === "string" ? error.args[0].toLowerCase() : null;
      const remove = result.legs.filter(l => l.buy && (error.name === "LaneBlocked" || buyErrors.has(error.name) && listing.assets.find(a => a.symbol === l.symbol)?.token === token));
      if (!remove.length || retries <= 0) { result.simulation = { result: "failed", error }; break; }
      result.legs = result.legs.filter(l => !remove.includes(l));
      for (const leg of remove) dropped.push({ leg, error });
    }
  }
  result.legsHash = result.legs.length ? legsHash(result.legs) : ZERO_HASH;
  return result;
}
export interface ExecutionQuoteOptions {
  rpc: ReadRpc; listing: Listing; lane: string; legs: OrderLeg[]; block: number;
  quote?: Quote; readLane?: typeof readLaneState;
}
export async function checkExecutionQuotes(options: ExecutionQuoteOptions): Promise<ExecutionError | null> {
  const { rpc, listing, lane, legs, block } = options, quote = options.quote ?? quoteExactInput;
  const tokens = legs.filter(l => BigInt(l.amountIn) === MAX).map(l => listing.assets.find(a => a.symbol === l.symbol)?.token);
  if (tokens.some(t => !t)) throw new Error("sealed listing mismatch");
  const tracked = tokens.length ? (await (options.readLane ?? readLaneState)(rpc, lane, tokens as string[], block)).ledger : {};
  for (let index = 0; index < legs.length; index++) {
    const leg = legs[index], asset = listing.assets.find(a => a.symbol === leg.symbol), pool = asset?.pools.find(p => p.index === leg.pool);
    if (!asset || !pool) throw new Error("sealed listing mismatch");
    const amount = BigInt(leg.amountIn) === MAX ? tracked[asset.token] : BigInt(leg.amountIn);
    if (amount <= 0n) return { name: "QuoteUnavailable", args: [index.toString()] };
    let out: bigint;
    try { out = await quote(rpc, pool.key, pool.key.currency0 === (leg.buy ? ADDRESSES.usdg : asset.token), amount, block); }
    catch (error) {
      // Only a quoter revert ends the execution; read failures stay retryable with the same sealed orders.
      if (revertData(error) === null) throw error;
      return { name: "QuoteUnavailable", args: [index.toString()] };
    }
    if (BigInt(leg.minOut) < out * 995n / 1000n) return { name: "QuoteMoved", args: [index.toString(), leg.minOut, out.toString()] };
  }
  return null;
}
