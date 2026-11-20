import { canonicalize, redactSecrets, sha256Hex, validateRecord, type Orders } from "@holdout/core";

export const MCP_VERSION = "0.0.0";
export const MAX_AGENT_RECORD_BYTES = 262_144;
export function redactValue(value: unknown): any {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactSecrets(key), redactValue(item)]));
  return value;
}
export interface AgentRecordInput {
  lane: string; agent: string; time: number; blocked: boolean; model: string; input: string; output: string;
  weights: Record<string, string> | null; orders: Orders;
}
export function createAgentRecord(input: AgentRecordInput) {
  const value = redactValue({ schema: "holdout.record/1", chainId: 4663, lane: input.lane, kind: "decision", time: input.time,
    agent: input.agent, blocked: input.blocked, source: { name: "holdout-mcp", version: MCP_VERSION },
    model: input.model, input: input.input, output: input.output,
    decision: input.weights === null ? null : { weights: input.weights }, orders: input.orders });
  validateRecord(value);
  let bytes: Uint8Array;
  try { bytes = canonicalize(value); } catch { throw new Error("invalid-text"); }
  if (bytes.length > MAX_AGENT_RECORD_BYTES) throw new Error("record-too-large");
  return { value, bytes, h: sha256Hex(bytes) };
}
