import assert from "node:assert/strict";
import test from "node:test";
import { homedir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerSecret } from "@holdout/core";
import { createMcpServer, type ToolEngine } from "../src/server.js";
import type { DecisionResult } from "../src/types.js";
import { PRINCIPAL_RULE } from "../src/read.js";

const empty = (state: DecisionResult["state"] = "held"): DecisionResult => ({ state, h: null, tx: null, legs: [], dropped: [], simulation: null, upload: null, recordUrl: null, error: null });
test("M3 official SDK client receives exactly five tools and their typed input schemas", async t => {
  const seen: unknown[] = [];
  const engine: ToolEngine = { async decide(input) { seen.push(input); return empty("executed"); }, async seal(input) { seen.push(input); return empty(); }, async pending() { return [{ stage: "uploaded" }]; } };
  const reader = { async rules() { return { principal: PRINCIPAL_RULE }; }, async market() { return { blocked: false }; }, async lane(pending?: unknown[]) { return { pending }; } };
  const server = createMcpServer(reader, engine), client = new Client({ name: "fixture-client", version: "0.0.0" }), [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport); await client.connect(clientTransport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ["holdout_rules", "holdout_market", "holdout_lane", "holdout_decide", "holdout_seal"].sort());
  const decide = tools.find(tool => tool.name === "holdout_decide")!, schema = decide.inputSchema as any;
  assert.deepEqual(schema.required.slice().sort(), ["requestId", "weights", "model", "input", "output"].sort());
  assert.equal(schema.additionalProperties, false); assert.equal(schema.properties.weights.type, "object");
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text: string }[]; assert.equal(content.length, 1); assert.equal(content[0].type, "text"); return { result, value: JSON.parse(content[0].text) };
  };
  assert.equal((await call("holdout_rules")).value.principal, PRINCIPAL_RULE);
  assert.equal((await call("holdout_market")).value.blocked, false);
  assert.deepEqual((await call("holdout_lane")).value.pending, [{ stage: "uploaded" }]);
  const decision = { requestId: "request:1", weights: { NVDA: "0.25" }, model: "fixture-model", input: "complete input", output: "complete output" };
  assert.equal((await call("holdout_decide", decision)).value.state, "executed");
  assert.deepEqual(seen[0], decision);
  const badWeight = await call("holdout_decide", { ...decision, weights: { NVDA: true } });
  assert.equal(badWeight.result.isError, true); assert.equal(badWeight.value.error.code, "invalid-weights");
  const { requestId, ...missingId } = decision;
  const badId = await call("holdout_decide", missingId);
  assert.equal(badId.result.isError, true); assert.equal(badId.value.error.code, "invalid-request-id");
  const { weights, ...seal } = decision; assert.equal((await call("holdout_seal", seal)).value.state, "held");
  assert.equal((await call("holdout_seal", { ...seal, model: "🧠".repeat(200) })).result.isError, undefined);
  assert.equal((await call("holdout_seal", { ...seal, model: "🧠".repeat(201) })).result.isError, true);
});

test("M11 write refusal states are MCP errors and M12 exceptions and results redact registered secrets", async t => {
  const secret = "0x" + "ab".repeat(32); registerSecret(secret); registerSecret(secret.slice(2));
  let state: DecisionResult["state"] = "refused", throws = false;
  const logs: string[] = [], engine: ToolEngine = {
    async decide() { if (throws) throw new Error("unavailable " + homedir() + "/sensitive " + secret); return { ...empty(state), error: { code: "agent-key-missing", message: secret } }; },
    async seal() { return empty(state); }, async pending() { return []; },
  };
  const server = createMcpServer({ async rules() { return {}; }, async market() { return {}; }, async lane() { return {}; } }, engine, message => logs.push(message));
  const client = new Client({ name: "fixture-client", version: "0.0.0" }), [left, right] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); }); await server.connect(right); await client.connect(left);
  for (const value of ["refused", "failed", "busy", "not-sent"] as const) {
    state = value; const result = await client.callTool({ name: "holdout_decide", arguments: { requestId: "r-1", weights: {}, model: "fixture", input: "input", output: "output" } });
    assert.equal(result.isError, true); assert.equal(JSON.stringify(result).includes(secret), false); assert.equal(JSON.stringify(result).includes(secret.slice(2)), false);
  }
  throws = true;
  const result = await client.callTool({ name: "holdout_decide", arguments: { requestId: "r-1", weights: {}, model: "fixture", input: "input", output: "output" } });
  assert.equal(result.isError, true); assert.equal(JSON.stringify(result).includes(secret), false); assert.equal(logs.join("").includes(secret), false);
  assert.equal(JSON.stringify(result).includes(homedir()), false); assert.equal(logs.join("").includes(homedir()), false);
  assert.equal(JSON.parse((result.content as any)[0].text).error.code, "rpc-unavailable");
});
