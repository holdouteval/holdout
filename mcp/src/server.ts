import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SendClient, redactSecrets, safeError } from "@holdout/core";
import { DecisionEngine } from "./engine.js";
import { LaneReader } from "./read.js";
import type { DecisionInput, DecisionResult, SealInput, ServerConfig } from "./types.js";

export interface ToolReader { rules(): Promise<unknown>; market(): Promise<unknown>; lane(pending?: unknown[]): Promise<unknown> }
export interface ToolEngine {
  decide(input: DecisionInput): Promise<DecisionResult>; seal(input: SealInput): Promise<DecisionResult>; pending(): Promise<unknown[]>;
}
const codePoints = (value: string) => [...value].length;
const common = {
  requestId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/).describe("A new identifier for each decision; preserve it and all input when retrying the same decision."),
  model: z.string().refine(value => codePoints(value) >= 1 && codePoints(value) <= 200, "model must contain 1 to 200 code points").describe("Your self-reported model name, 1 to 200 code points."),
  input: z.string().describe("The complete material used for this decision."),
  output: z.string().describe("Your complete answer; it is published without truncation."),
};
function scrub(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [redactSecrets(key), scrub(entry)]));
  return value;
}
function response(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(scrub(value)) }], ...(isError ? { isError: true } : {}) };
}
export function createMcpServer(reader: ToolReader, engine: ToolEngine, logger: (message: string) => void = () => {}): McpServer {
  const server = new McpServer({ name: "holdout-mcp", version: "0.0.0" });
  const routes = new Map<string, { schema: z.ZodType; action: (input: any) => Promise<unknown>; write: boolean }>();
  const invoke = async (action: () => Promise<unknown>, write = false): Promise<CallToolResult> => {
    try {
      const value = await action();
      const state = write && value && typeof value === "object" ? (value as DecisionResult).state : null;
      return response(value, state !== null && ["refused", "failed", "busy", "not-sent"].includes(state));
    } catch (error) {
      logger(safeError(error));
      return response({ error: { code: "rpc-unavailable", message: safeError(error) } }, true);
    }
  };
  function register(schema: z.ZodType, name: string, description: string, action: (input: any) => Promise<unknown>, write = false): void {
    routes.set(name, { schema, action, write });
    server.registerTool(name, { description, inputSchema: schema }, input => invoke(() => action(input), write));
  }
  register(z.object({}).strict(), "holdout_rules", "Read the principal rule, seven buy gates, execution rules, listings and public record format.", () => reader.rules());
  register(z.object({}).strict(), "holdout_market", "Read current feed answers, ages, buy gates and quote costs. A gate other than open prevents buying now; DiscountToFeed means a 250 USDG buy would be rejected at this block.", () => reader.market());
  register(z.object({}).strict(), "holdout_lane", "Read the lane's fixed opening principal, ledger, value, current weights, decision history, agent ETH and unpublished local decisions.", async () => reader.lane(await engine.pending()));
  register(z.object({ ...common, weights: z.record(z.string(), z.union([z.number(), z.string()])).describe("Listed stock symbols mapped to target weights between 0 and 1; total at most 1. USDG is the unallocated remainder.") }).strict(),
    "holdout_decide", "Commit your complete decision and target stock weights, sell first, then buy. Use a fresh requestId for a new decision and the same requestId and input for retries.", input => engine.decide(input), true);
  register(z.object(common).strict(), "holdout_seal", "Commit a decision without trading. Keep the same requestId and input when retrying this decision.", input => engine.seal(input), true);
  // Keep validation errors in the same JSON result format as execution errors.
  server.server.setRequestHandler(CallToolRequestSchema, async request => {
    const route = routes.get(request.params.name);
    if (!route) return response({ error: { code: "unknown-tool" } }, true);
    const parsed = route.schema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      const code = field === "weights" ? "invalid-weights" : field === "model" ? "invalid-model" : field === "requestId" ? "invalid-request-id" : field === "input" || field === "output" ? "invalid-text" : "invalid-arguments";
      return response({ error: { code } }, true);
    }
    return invoke(() => route.action(parsed.data), route.write);
  });
  server.server.onerror = error => logger(safeError(error));
  return server;
}
export async function startStdio(config: ServerConfig): Promise<{ close(): Promise<void> }> {
  const logger = (message: string) => process.stderr.write(safeError(message) + "\n");
  const reader = new LaneReader(config, { logger }); await reader.initialize();
  const sender = new SendClient({ override: config.rpc, envFile: false, authorization: () => true, logger });
  const engine = new DecisionEngine({ config, identity: reader.identity, key: reader.key, rpc: reader.rpc, sender, logger });
  await engine.start();
  const server = createMcpServer(reader, engine, logger), transport = new StdioServerTransport();
  const close = async () => { engine.stop(); await server.close(); };
  server.server.onclose = () => engine.stop();
  try { await server.connect(transport); } catch (error) { engine.stop(); throw error; }
  return { close };
}
