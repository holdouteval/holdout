import { ADDRESSES, FACTORY_ABI, LANE_ABI, RpcClient, assess, readContracts, readFactory, readHeader, readLaneState, safeInteger,
  type FactoryView, type OrderListing, type ReadRpc } from "@holdout/core";
import { findAgentKey } from "./keys.js";
import { siteLink } from "./links.js";
import type { AgentKey, LaneIdentity, ServerConfig } from "./types.js";

export const GATES = [
  { name: "NotListed", reason: "Buys use only assets and pools listed by the factory." },
  { name: "TokenPaused", reason: "Buys stop while the issuer pauses token transfers." },
  { name: "OracleFlagged", reason: "Buys stop while the issuer flags the token oracle." },
  { name: "LaneBlocked", reason: "Buys stop when the access registry blocks this lane." },
  { name: "BadFeed", reason: "Buys require a positive feed answer and a nonzero update time." },
  { name: "StaleFeed", reason: "Buys require a feed no older than maxAge seconds." },
  { name: "DiscountToFeed", reason: "Buys cannot add more feed-valued inventory than the USDG paid." },
] as const;
export const EXECUTION = "Sell first, then buy, in one transaction. Every leg must fill completely and return at least 99.5% of its quote; otherwise the whole transaction reverts. Differences below 1 USDG are not traded. A zero weight sells the full tracked quantity. A gated buy stays in USDG. These seven gates apply to buys only.";
export const PRINCIPAL_RULE = "The opener chooses the USDG principal. It must be greater than zero and stays fixed after opening.";
export const RECORD_FIELDS = {
  schema: "holdout.record/1", chainId: "4663", lane: "Lane address", kind: "decision", time: "Snapshot block time in Unix seconds",
  agent: "Agent address", blocked: "Access-registry status at the snapshot block", source: "Package name and version",
  model: "Agent-reported model name", input: "Complete decision inputs", output: "Complete answer",
  decision: "Normalized target weights, or null for a seal", orders: "Quote block, ordered legs, dropped buys, legs hash and simulation",
};
export function statusName(status: number): "open" | "closing" | "closed" {
  if (status === 1) return "open";
  if (status === 2) return "closing";
  if (status === 3) return "closed";
  throw new Error("invalid-lane-status");
}
export function orderListing(factory: FactoryView): OrderListing {
  return { maxAge: factory.maxAge, actWindow: factory.actWindow,
    assets: factory.assets.map(asset => {
      if (!asset.symbol) throw new Error("unknown-listed-symbol");
      return { assetId: asset.assetId, symbol: asset.symbol, token: asset.token, feed: asset.feed, pools: factory.pools.filter(pool => pool.token === asset.token) };
    }) };
}
export interface ReaderOptions {
  rpc?: ReadRpc; fetch?: typeof globalThis.fetch; logger?: (message: string) => void;
  read?: { contracts?: typeof readContracts; factory?: typeof readFactory; header?: typeof readHeader; lane?: typeof readLaneState; assess?: typeof assess };
}
export class LaneReader {
  readonly rpc: ReadRpc;
  identity!: LaneIdentity;
  key: AgentKey | null = null;
  constructor(readonly config: ServerConfig, readonly options: ReaderOptions = {}) {
    this.rpc = options.rpc ?? new RpcClient({ override: config.rpc, envFile: false, logger: options.logger });
  }
  private contracts: typeof readContracts = (rpc, calls, block) => (this.options.read?.contracts ?? readContracts)(rpc, calls, block);
  private header: typeof readHeader = (rpc, block) => (this.options.read?.header ?? readHeader)(rpc, block);
  private factory: typeof readFactory = (rpc, address, block) => (this.options.read?.factory ?? readFactory)(rpc, address, block);
  async initialize(): Promise<void> {
    const head = await this.header(this.rpc);
    const values = await this.contracts(this.rpc, ["factory", "agent", "owner", "status"].map(functionName => ({ target: this.config.lane, abi: LANE_ABI, functionName })), head.block);
    const identity = { factory: String(values[0]).toLowerCase(), agent: String(values[1]).toLowerCase(), owner: String(values[2]).toLowerCase(), status: safeInteger(values[3]) };
    for (const value of [identity.factory, identity.agent, identity.owner]) if (!/^0x[0-9a-f]{40}$/.test(value)) throw new Error("invalid-lane-identity");
    statusName(identity.status);
    const [isLane] = await this.contracts(this.rpc, [{ target: identity.factory, abi: FACTORY_ABI, functionName: "isLane", args: [this.config.lane] }], head.block);
    if (isLane !== true) throw new Error("unknown-lane");
    this.identity = identity;
    this.key = await findAgentKey(this.config.home, identity.agent, this.config.keyFile, this.options.logger);
  }
  async rules(): Promise<unknown> {
    const head = await this.header(this.rpc), factory = await this.factory(this.rpc, this.identity.factory, head.block);
    const [burnAmount, owner, agent, status] = await this.contracts(this.rpc, [
      { target: this.identity.factory, abi: FACTORY_ABI, functionName: "burnAmount" },
      ...["owner", "agent", "status"].map(functionName => ({ target: this.config.lane, abi: LANE_ABI, functionName })),
    ], head.block);
    return { chainId: 4663, lane: this.config.lane, owner: String(owner).toLowerCase(), agent: String(agent).toLowerCase(), status: statusName(safeInteger(status)),
      factory: this.identity.factory, principal: PRINCIPAL_RULE, maxAge: factory.maxAge, actWindow: factory.actWindow, burnAmount: String(burnAmount),
      assets: factory.assets.map(asset => ({ symbol: asset.symbol, token: asset.token, feed: asset.feed })),
      pools: factory.pools.map(pool => ({ index: pool.index, token: pool.token, fee: pool.key.fee, tickSpacing: pool.key.tickSpacing, hooks: pool.key.hooks })),
      gates: GATES, execution: EXECUTION, record: RECORD_FIELDS, closeUrl: siteLink(this.config.siteBase, "close", this.config.lane) };
  }
  async market(): Promise<unknown> {
    const head = await this.header(this.rpc), factory = await this.factory(this.rpc, this.identity.factory, head.block);
    const market = await (this.options.read?.assess ?? assess)({ rpc: this.rpc, listing: orderListing(factory), lane: this.config.lane, block: head.block,
      accessRegistry: factory.accessRegistry, maxAge: factory.maxAge, time: head.time });
    return { block: head.block, time: head.time, blocked: market.blocked, assets: market.assets.map(asset => ({ symbol: asset.symbol, token: asset.token,
      answer: asset.answer, updatedAt: asset.updatedAt, age: asset.age, roundId: asset.roundId, gate: asset.gate, buyCostBps: asset.buyCostBps, sellCostBps: asset.sellCostBps })) };
  }
  async lane(pending: unknown[] = []): Promise<unknown> {
    const head = await this.header(this.rpc), factory = await this.factory(this.rpc, this.identity.factory, head.block);
    const state = await (this.options.read?.lane ?? readLaneState)(this.rpc, this.config.lane, [ADDRESSES.usdg, ...factory.assets.map(asset => asset.token)], head.block);
    const [value, returnedUsdg, finalUsdg] = await this.contracts(this.rpc, ["value", "returnedUsdg", "finalUsdg"].map(functionName => ({ target: this.config.lane, abi: LANE_ABI, functionName })), head.block);
    const market = await (this.options.read?.assess ?? assess)({ rpc: this.rpc, listing: orderListing(factory), lane: this.config.lane, block: head.block,
      accessRegistry: factory.accessRegistry, maxAge: factory.maxAge, time: head.time });
    const total = BigInt(value as bigint), weights: Record<string, string> = {};
    for (const asset of market.assets) {
      const inventory = (state.ledger[asset.token] ?? 0n) * BigInt(asset.answer) / 10n ** 20n;
      const micros = total > 0n && inventory > 0n ? inventory * 1_000_000n / total : 0n;
      weights[asset.symbol] = micros === 1_000_000n ? "1" : micros === 0n ? "0" : (micros / 1_000_000n).toString() + "." + (micros % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
    }
    const balance = await this.rpc.request<string>("eth_getBalance", [state.agent, "0x" + head.block.toString(16)]);
    let decisions: unknown = "unavailable";
    if (this.config.dataBase !== null) {
      try {
        const response = await (this.options.fetch ?? globalThis.fetch)(this.config.dataBase + "/d/lanes.json", { signal: AbortSignal.timeout(10_000) });
        if (response.ok) {
          const indexed = await response.json() as { lanes?: { address: string; decisions?: unknown[] }[] };
          const found = indexed.lanes?.find(lane => lane.address.toLowerCase() === this.config.lane);
          if (found && Array.isArray(found.decisions)) decisions = found.decisions;
        }
      } catch { /* Chain reads remain available while the indexer is unavailable. */ }
    }
    return { lane: this.config.lane, owner: state.owner, agent: state.agent, principal: state.principal.toString(), status: statusName(state.status), block: head.block, time: head.time,
      ledger: Object.fromEntries(Object.entries(state.ledger).map(([token, quantity]) => [token, quantity.toString()])), value: total.toString(), weights,
      returnedUsdg: String(returnedUsdg), finalUsdg: String(finalUsdg), agentEthBalance: BigInt(balance).toString(), decisions, pending,
      closeUrl: siteLink(this.config.siteBase, "close", this.config.lane) };
  }
}
