import { ADDRESSES, readFactory, readLaneState, readMarkets, readHeader, quoteExactInput, assess, type OrderListing } from "@holdout/core";
import { loadListing } from "./config.js";
import { shortenReason } from "./prompt.js";
import type { HarnessConfig, HistoryDecision, LaneConfig, Listing, ReadRpc, SnapshotAsset, SnapshotResult } from "./types.js";

type Row = [number, number, number, number, string, number, number, number | null];
const date = (time: number) => new Date(time * 1000).toISOString().slice(0, 10);
export function newYorkDate(time: number): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(time * 1000));
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function recentHistory(decisions: any[]): HistoryDecision[] {
  return decisions.filter(d => d && d.house && typeof d.house.reason === "string" && d.house.weights && typeof d.sealed?.time === "number")
    .sort((a, b) => b.sealed.time - a.sealed.time || b.sealed.block - a.sealed.block)
    .slice(0, 3).map(d => ({ date: newYorkDate(d.sealed.time), weights: { ...d.house.weights }, reason: shortenReason(d.house.reason) }));
}
export function closingAnswer(day: unknown, symbol: string, close: number): number | null {
  const feed = (day as any)?.feeds?.[symbol]; if (!feed || !Array.isArray(feed.rounds)) return null;
  const rows: Row[] = [feed.carry, ...feed.rounds].filter(r => Array.isArray(r) && r.length === 8 && Number.isSafeInteger(r[0])
    && Number.isSafeInteger(r[1]) && (r[7] === null || Number.isSafeInteger(r[7])) && (r[7] ?? r[0]) <= close);
  rows.sort((a, b) => (a[7] ?? a[0]) - (b[7] ?? b[0]) || a[3] - b[3] || a[5] - b[5]);
  return rows.at(-1)?.[1] ?? null;
}

export interface SnapshotOptions {
  rpc: ReadRpc; config: HarnessConfig; lane: LaneConfig; block: number;
  history?: HistoryDecision[]; ledger?: Record<string, string>; openedTime?: number; fetch?: typeof globalThis.fetch;
  read?: {
    factory?: typeof readFactory; lane?: typeof readLaneState; markets?: typeof readMarkets;
    header?: typeof readHeader; quote?: typeof quoteExactInput;
  };
}
export async function collectSnapshot(options: SnapshotOptions): Promise<SnapshotResult> {
  const { rpc, config, lane, block } = options, read = options.read ?? {};
  const header = await (read.header ?? readHeader)(rpc, block);
  let listed: OrderListing, paperPrincipal: string | null = null, accessRegistry: string = ADDRESSES.accessRegistry;
  if (config.factory === null) {
    const configured = loadListing(config.listingFile, config.paperMaxAge);
    listed = configured; paperPrincipal = configured.principal;
  }
  else {
    const factory = await (read.factory ?? readFactory)(rpc, config.factory, block);
    accessRegistry = factory.accessRegistry;
    listed = { maxAge: factory.maxAge, actWindow: factory.actWindow,
      assets: factory.assets.map(a => {
        if (!a.symbol) throw new Error("listed token has no known symbol");
        return { assetId: a.assetId, symbol: a.symbol, token: a.token, feed: a.feed, pools: factory.pools.filter(p => p.token === a.token) };
      }) };
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  const get = async (path: string, optional = false): Promise<any> => {
    const response = await fetcher(config.publicBase + path);
    if (optional && response.status === 404) return null;
    if (!response.ok) throw new Error("indexed snapshot data unavailable");
    return response.json();
  };
  const [status, indexedLanes] = await Promise.all([get("/d/status.json"), get("/d/lanes.json")]);
  const indexed = indexedLanes.lanes?.find((l: any) => l.address === lane.lane);
  if (config.factory !== null && !indexed) throw new Error("lane is not indexed");
  const laneState = config.factory === null ? null : await (read.lane ?? readLaneState)(rpc, lane.lane, [ADDRESSES.usdg, ...listed.assets.map(a => a.token)], block);
  const listing: Listing = { ...listed, principal: laneState ? laneState.principal.toString() : paperPrincipal! };
  const ledger: Record<string, string> = laneState ? Object.fromEntries(Object.entries(laneState.ledger).map(([token, amount]) => [token.toLowerCase(), amount.toString()]))
    : { [ADDRESSES.usdg]: listing.principal, ...options.ledger };
  const recent = (status.sessions?.recent ?? []).filter((session: any) => Array.isArray(session) && session.length === 3 && session[2] <= header.time)
    .sort((a: number[], b: number[]) => b[2] - a[2]).slice(0, 10) as [number, number, number][];
  const tapes = new Map<string, any>();
  for (const [, , close] of recent) { const label = date(close); if (!tapes.has(label)) tapes.set(label, await get(`/d/tape/${label}.json`, true)); }
  const market = await assess({ rpc, listing, lane: lane.lane, block, accessRegistry, time: header.time, read });
  const assets: SnapshotAsset[] = market.assets.map(asset => ({
    symbol: asset.symbol, token: asset.token, feed: asset.feed, roundId: asset.roundId, answer: asset.answer,
    updatedAt: asset.updatedAt, age: asset.age, gate: asset.gate, buyCostBps: asset.buyCostBps, sellCostBps: asset.sellCostBps,
    closes: recent.map(([, , close]) => [newYorkDate(close), closingAnswer(tapes.get(date(close)), asset.symbol, close)]),
  }));
  let value = BigInt(ledger[ADDRESSES.usdg] ?? "0");
  for (const asset of assets) value += BigInt(ledger[asset.token] ?? "0") * BigInt(asset.answer) / 10n ** 20n;
  const history = options.history ? options.history.slice(0, 3).map(h => ({ ...h, weights: { ...h.weights }, reason: shortenReason(h.reason) })) : recentHistory(indexed?.decisions ?? []);
  return { snapshot: { block, time: header.time, value: value.toString(), ledger, blocked: market.blocked, assets, history },
    listing, openedTime: indexed?.opened?.time ?? options.openedTime ?? header.time, status: laneState?.status ?? 1, principal: listing.principal };
}
