import type { ReadRpc, SendClient } from "@holdout/core";

export interface ServerConfig {
  lane: string;
  home: string;
  dataBase: string | null;
  siteBase: string | null;
  rpc?: string;
  keyFile?: string;
}
export interface LaneIdentity { factory: string; agent: string; owner: string; status: number }
export interface AgentKey { path: string; address: string }
export interface DecisionInput { requestId: string; weights: Record<string, number | string>; model: string; input: string; output: string }
export type SealInput = Omit<DecisionInput, "weights">;
export interface ToolError { code: string; name?: string; args?: unknown[]; message?: string }
export interface DecisionResult {
  state: "executed" | "held" | "pending" | "failed" | "refused" | "busy" | "not-sent";
  h: string | null; tx: string | null;
  legs: { symbol: string; buy: boolean; amountIn: string; minOut: string; quoteOut: string }[];
  dropped: unknown[]; simulation: unknown; upload: unknown; recordUrl: string | null;
  error: ToolError | null; replayed?: true;
}
export interface DecisionEngineOptions {
  config: ServerConfig; identity: LaneIdentity; key: AgentKey | null; rpc: ReadRpc; sender: SendClient;
  now?: () => number; sleep?: (milliseconds: number) => Promise<void>; fetch?: typeof globalThis.fetch;
  logger?: (message: string) => void;
}
