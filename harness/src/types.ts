import type { OrderListing, OrderGate as Gate, Orders } from "@holdout/core";
export type { PoolKey, ReadRpc, OrderPool as ListedPool, OrderAsset as ListedAsset,
  OrderGate as Gate, ExecutionError, OrderLeg, DroppedLeg, Orders } from "@holdout/core";
export interface Listing extends OrderListing { principal: string }
export type Review = "auto" | "operator-send-or-skip";
export type Provider = "anthropic" | "openai";
export interface LaneConfig { lane: string; agent: string; model: string; review: Review; keyFile: string }
export interface ModelConfig { provider: Provider; effort: "high"; maxOutputTokens: 64000 }
export interface Price { input: number; output: number }
export interface HarnessConfig {
  mode: "paper" | "send";
  budget: { monthlyUsd: string };
  rpc: { override?: string };
  dataDir: string;
  publicBase: string;
  adminBase: string;
  factory: string | null;
  lanes: LaneConfig[];
  models: Record<string, ModelConfig>;
  prices: Record<string, Price>;
  listingFile: string;
  cutoffsFile: string;
  paperMaxAge: number;
}
export interface HistoryDecision { date: string; weights: Record<string, string>; reason: string }
export interface SnapshotAsset {
  symbol: string; token: string; feed: string; roundId: string; answer: number; updatedAt: number; age: number;
  gate: Gate; buyCostBps: number | null; sellCostBps: number | null; closes: [string, number | null][];
}
export interface Snapshot {
  block: number; time: number; value: string; ledger: Record<string, string>; blocked: boolean;
  assets: SnapshotAsset[]; history: HistoryDecision[];
}
export interface SnapshotResult { snapshot: Snapshot; listing: Listing; openedTime: number; status: number; principal: string }
export interface Decision { weights: Record<string, string>; reason: string }
export interface AttemptRecord {
  text: string; tail: string; bytesRead: number; completed: boolean; stop: unknown | null;
  usage: unknown | null; model: string | null; id: string | null; error: string | null;
}
export interface HarnessResponse { used: number | null; attempts: AttemptRecord[] }
export interface HarnessRequest { system: string; user: string; params: Record<string, unknown> }
export type RecordError = "parse-failed" | "model-unavailable" | "refusal" | "harness-missed" | "input-too-large";
export interface HarnessRecord {
  schema: "holdout.record/1"; chainId: 4663; lane: string; kind: "decision"; time: number;
  model: string; review: Review; harness: { version: string; commit: string | null };
  session: { date: string; decisionTime: number }; snapshot: Snapshot | null;
  request: HarnessRequest | null; response: HarnessResponse | null; decision: Decision | null; orders: Orders;
  error: RecordError | null;
}
