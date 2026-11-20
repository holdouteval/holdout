import { encodeFunctionData, decodeFunctionResult, type Abi } from "viem";
import { FACTORY_ABI, LANE_ABI, MULTICALL_ABI, STOCK_ABI, PROXY_ABI, ACCESS_ABI } from "./abi.js";
import { ADDRESSES, FEEDS } from "./chain.js";

export interface ReadRpc { request<T = unknown>(method: string, params: unknown[]): Promise<T> }
export type ReadBlock = number | `0x${string}`;
export interface ContractRead { target: string; abi: Abi; functionName: string; args?: readonly unknown[] }
export interface PoolKey { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }
export interface ListedAsset { assetId: number; symbol: string | null; token: string; feed: string; assetOf: number }
export interface ListedPool { index: number; token: string; key: PoolKey; poolId: string }
export interface FactoryView {
  assets: ListedAsset[]; pools: ListedPool[]; maxAge: number; actWindow: number;
  usdg: string; accessRegistry: string;
}
export interface SealView { at: number; acted: boolean; legsHash: string }
export interface LaneView { ledger: Record<string, bigint>; principal: bigint; status: number; agent: string; owner: string; seals: Record<string, SealView> }
export interface MarketAsset extends ListedAsset { paused: boolean; oraclePaused: boolean; roundId: bigint; answer: bigint; updatedAt: number }
export interface MarketView { blocked: boolean; assets: MarketAsset[] }
export const blockTag = (block: ReadBlock): `0x${string}` => typeof block === "number" ? `0x${block.toString(16)}` : block;
export function safeInteger(value: unknown): number {
  const integer = Number(value);
  if (!Number.isSafeInteger(integer)) throw new Error("integer exceeds the supported range");
  return integer;
}
const lower = (value: unknown): string => String(value).toLowerCase();

export async function readContracts(rpc: ReadRpc, calls: readonly ContractRead[], block: ReadBlock): Promise<unknown[]> {
  const values: unknown[] = [];
  for (let offset = 0; offset < calls.length; offset += 100) {
    const group = calls.slice(offset, offset + 100);
    const data = encodeFunctionData({ abi: MULTICALL_ABI, functionName: "aggregate3", args: [group.map(call => ({
      target: call.target as `0x${string}`, allowFailure: true,
      callData: encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args ?? [] } as any),
    }))] });
    const result = await rpc.request<`0x${string}`>("eth_call", [{ to: ADDRESSES.multicall3, data }, blockTag(block)]);
    const decoded = decodeFunctionResult({ abi: MULTICALL_ABI, functionName: "aggregate3", data: result });
    if (decoded.length !== group.length) throw new Error("multicall result length mismatch");
    for (let i = 0; i < group.length; i++) {
      if (!decoded[i].success) throw new Error(`contract read failed: ${group[i].functionName}`);
      values.push(decodeFunctionResult({ abi: group[i].abi, functionName: group[i].functionName, data: decoded[i].returnData }));
    }
  }
  return values;
}

export async function readFactory(rpc: ReadRpc, factory: string, block: ReadBlock): Promise<FactoryView> {
  const names = ["assetCount", "poolCount", "maxAge", "actWindow", "usdg", "accessRegistry"];
  const root = await readContracts(rpc, names.map(functionName => ({ target: factory, abi: FACTORY_ABI, functionName })), block);
  const assetCount = safeInteger(root[0]), poolCount = safeInteger(root[1]);
  const calls: ContractRead[] = [
    ...Array.from({ length: assetCount }, (_, index) => ({ target: factory, abi: FACTORY_ABI, functionName: "assetAt", args: [BigInt(index)] })),
    ...Array.from({ length: poolCount }, (_, index) => ({ target: factory, abi: FACTORY_ABI, functionName: "poolAt", args: [BigInt(index)] })),
  ];
  const listing = await readContracts(rpc, calls, block);
  const assets: ListedAsset[] = listing.slice(0, assetCount).map((value, assetId) => {
    const asset = value as { token: string; feed: string };
    const token = lower(asset.token), feed = lower(asset.feed);
    return { assetId, symbol: FEEDS.find(entry => entry.token === token)?.symbol ?? null, token, feed, assetOf: 0 };
  });
  const ids = await readContracts(rpc, assets.map(asset => ({ target: factory, abi: FACTORY_ABI, functionName: "assetOf", args: [asset.token] })), block);
  for (let i = 0; i < assets.length; i++) assets[i].assetOf = safeInteger(ids[i]);
  const pools: ListedPool[] = listing.slice(assetCount).map((value, index) => {
    const pool = value as { token: string; key: PoolKey; poolId: string };
    return { index, token: lower(pool.token), poolId: lower(pool.poolId), key: { currency0: lower(pool.key.currency0), currency1: lower(pool.key.currency1),
      fee: safeInteger(pool.key.fee), tickSpacing: safeInteger(pool.key.tickSpacing), hooks: lower(pool.key.hooks) } };
  });
  return { assets, pools, maxAge: safeInteger(root[2]), actWindow: safeInteger(root[3]), usdg: lower(root[4]), accessRegistry: lower(root[5]) };
}

export async function readLaneState(rpc: ReadRpc, lane: string, tokens: readonly string[], block: ReadBlock, hashes: readonly string[] = []): Promise<LaneView> {
  const unique = [...new Set(tokens.map(lower))];
  const calls: ContractRead[] = unique.map(token => ({ target: lane, abi: LANE_ABI, functionName: "tracked", args: [token] }));
  calls.push(...["status", "agent", "owner", "principal"].map(functionName => ({ target: lane, abi: LANE_ABI, functionName })));
  calls.push(...hashes.map(h => ({ target: lane, abi: LANE_ABI, functionName: "seals", args: [h] })));
  const values = await readContracts(rpc, calls, block), offset = unique.length;
  const seals: Record<string, SealView> = {};
  for (let i = 0; i < hashes.length; i++) {
    const value = values[offset + 4 + i] as readonly [bigint, boolean, string];
    seals[hashes[i].toLowerCase()] = { at: safeInteger(value[0]), acted: value[1], legsHash: lower(value[2]) };
  }
  return { ledger: Object.fromEntries(unique.map((token, index) => [token, BigInt(values[index] as bigint)])), status: safeInteger(values[offset]),
    agent: lower(values[offset + 1]), owner: lower(values[offset + 2]), principal: BigInt(values[offset + 3] as bigint), seals };
}

export async function readMarkets(rpc: ReadRpc, assets: readonly ListedAsset[], lane: string, block: ReadBlock, accessRegistry: string = ADDRESSES.accessRegistry): Promise<MarketView> {
  const calls: ContractRead[] = assets.flatMap(asset => [
    { target: asset.token, abi: STOCK_ABI, functionName: "paused" },
    { target: asset.token, abi: STOCK_ABI, functionName: "oraclePaused" },
    { target: asset.feed, abi: PROXY_ABI, functionName: "latestRoundData" },
  ]);
  calls.push({ target: accessRegistry, abi: ACCESS_ABI, functionName: "isBlocked", args: [lane] });
  const values = await readContracts(rpc, calls, block);
  return { blocked: Boolean(values.at(-1)), assets: assets.map((asset, index) => {
    const round = values[index * 3 + 2] as readonly bigint[];
    return { ...asset, paused: Boolean(values[index * 3]), oraclePaused: Boolean(values[index * 3 + 1]),
      roundId: BigInt(round[0]), answer: BigInt(round[1]), updatedAt: safeInteger(round[3]) };
  }) };
}
