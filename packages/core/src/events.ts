import { decodeEventLog, type Abi, type Hex } from "viem";
import { FACTORY_ABI, LANE_ABI, AGGREGATOR_ABI } from "./abi.js";

export interface RpcLog {
  address: string;
  blockNumber: string;
  logIndex: string;
  transactionHash: string;
  topics: string[];
  data: string;
  blockHash?: string;
  transactionIndex?: string;
  removed?: boolean;
}

export interface DecodedEvent {
  name: string;
  args: Record<string, unknown>;
  block: number;
  logIndex: number;
  tx: string;
  address: string;
}

function safeIndex(value: string): number {
  const n = Number(BigInt(value));
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("unsafe event position");
  return n;
}

function lowercase(value: unknown): unknown {
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return value.toLowerCase();
  if (Array.isArray(value)) return value.map(lowercase);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, lowercase(v)]));
  return value;
}

const EVENTS: Abi = [...FACTORY_ABI, ...LANE_ABI, ...AGGREGATOR_ABI].filter((entry) => entry.type === "event");

export function decodeEvent(log: RpcLog): DecodedEvent | null {
  if (log.removed) return null;
  let decoded: { eventName: string; args?: unknown };
  try {
    decoded = decodeEventLog({ abi: EVENTS, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]], strict: true });
  } catch { return null; }
  return {
    name: decoded.eventName, args: lowercase(decoded.args ?? {}) as Record<string, unknown>,
    block: safeIndex(log.blockNumber), logIndex: safeIndex(log.logIndex),
    tx: log.transactionHash.toLowerCase(), address: log.address.toLowerCase(),
  };
}
