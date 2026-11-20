import type { ReadRpc } from "./lane.js";
import { safeInteger } from "./lane.js";

export interface ChainHeader { block: number; time: number; hash: string }
export async function readHeader(rpc: ReadRpc, block: number | string = "latest"): Promise<ChainHeader> {
  const tag = typeof block === "number" ? `0x${block.toString(16)}` : block;
  const value = await rpc.request<{ number: string; timestamp: string; hash: string } | null>("eth_getBlockByNumber", [tag, false]);
  if (!value) throw new Error("block header unavailable");
  return { block: safeInteger(BigInt(value.number)), time: safeInteger(BigInt(value.timestamp)), hash: value.hash.toLowerCase() };
}
export interface BlockAtTimeOptions { head?: ChainHeader; sleep?: (ms: number) => Promise<void>; pollMs?: number }
export async function blockAtTime(rpc: ReadRpc, time: number, options: BlockAtTimeOptions = {}): Promise<number> {
  if (!Number.isSafeInteger(time) || time < 0) throw new Error("invalid target time");
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let head = options.head ?? await readHeader(rpc);
  while (head.time < time) { await sleep(options.pollMs ?? 1000); head = await readHeader(rpc); }
  let low = 0, high = head.block;
  if ((await readHeader(rpc, 0)).time >= time) return 0;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if ((await readHeader(rpc, middle)).time >= time) high = middle; else low = middle;
  }
  return high;
}
