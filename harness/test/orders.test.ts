import test from "node:test";
import assert from "node:assert/strict";
import { ADDRESSES, LANE_ABI, encodeFunctionData, legsHash } from "@holdout/core";
import { encodeErrorResult } from "viem";
import { buildOrders, checkExecutionQuotes, MAX, SIM, ZERO_HASH } from "../src/orders.js";
import { lane, listing, rpc, snapshot } from "./decision-fixtures.js";
import type { OrderLeg } from "../src/types.js";

test("H1 sells precede buys; zero weight exits MAX including dust; best pool and minOut are fixed", async () => {
  const assets = listing(), state = snapshot(assets), a = assets.assets;
  a[0].pools.push({ ...a[0].pools[0], index: 3, key: { ...a[0].pools[0].key, fee: 200 } });
  state.ledger = { [ADDRESSES.usdg]: "500000000", [a[0].token]: "4995000000000000000", [a[1].token]: "5000000000000000" };
  const calls: [bigint, number][] = [];
  const orders = await buildOrders({ rpc, listing: assets, snapshot: state, lane: lane.lane, agent: lane.agent, quoteBlock: 123,
    decision: { weights: { CCC: "1" }, reason: "" }, virtual: true,
    quote: async (_rpc, key, _direction, amount, block) => { calls.push([amount, Number(block)]); return key.fee === 200 ? 500000000n : key.currency0 === a[1].token && amount === 5000000000000000n ? 500000n : 499000000n; } });
  assert.deepEqual(orders.legs.map(l => [l.symbol, l.buy]), [["AAA", false], ["BBB", false], ["CCC", true]]);
  assert.equal(orders.legs[0].amountIn, MAX.toString()); assert.equal(orders.legs[1].amountIn, MAX.toString());
  assert.equal(orders.legs[0].pool, 3); assert.equal(orders.legs[0].minOut, "497500000");
  assert.equal(orders.legs[2].amountIn, "997997500"); assert.equal(orders.legsHash, legsHash(orders.legs));
  assert.ok(calls.every(([, block]) => block === 123)); assert.equal(orders.simulation.result, "unavailable");
});

test("H1 proportional budgets, one USDG threshold, gates, failed pools, blocked and empty lanes", async () => {
  const assets = listing(), state = snapshot(assets); state.ledger[ADDRESSES.usdg] = "3000000"; state.value = "10000000";
  const orders = await buildOrders({ rpc, listing: assets, snapshot: state, lane: lane.lane, agent: lane.agent, quoteBlock: 123,
    decision: { weights: { AAA: "0.5", BBB: "0.25", CCC: "0.000001" }, reason: "" }, virtual: true, quote: async () => 1000000n });
  assert.deepEqual(orders.legs.map(l => l.amountIn), ["2000000", "1000000"]);
  state.assets[0].gate = "TokenPaused";
  const failed = await buildOrders({ rpc, listing: assets, snapshot: state, lane: lane.lane, agent: lane.agent, quoteBlock: 123,
    decision: { weights: { AAA: "0.5", BBB: "0.25" }, reason: "" }, virtual: true, quote: async () => { throw new Error("no quote"); } });
  assert.deepEqual(failed.dropped.map(d => d.error.name), ["TokenPaused", "QuoteUnavailable"]); assert.equal(failed.legsHash, ZERO_HASH);
  state.blocked = true;
  assert.deepEqual((await buildOrders({ rpc, listing: assets, snapshot: state, lane: lane.lane, agent: lane.agent, quoteBlock: 123, decision: { weights: { AAA: "1" }, reason: "" }, quote: async () => { throw new Error("must not quote"); } })).legs, []);
  const empty = snapshot(assets);
  assert.equal((await buildOrders({ rpc, listing: assets, snapshot: empty, lane: lane.lane, agent: lane.agent, quoteBlock: 123, decision: { weights: {}, reason: "" } })).legsHash, ZERO_HASH);
});

test("H1 nonzero weights sell the exact floor quantity only at the one USDG threshold", async () => {
  const assets = listing(), state = snapshot(assets), token = assets.assets[0].token;
  state.ledger = { [ADDRESSES.usdg]: "0", [token]: "1000000000000000000" }; state.value = "100000000";
  const base = { rpc, listing: assets, snapshot: state, lane: lane.lane, agent: lane.agent, quoteBlock: 123, virtual: true, quote: async () => 1000000n };
  const threshold = await buildOrders({ ...base, decision: { weights: { AAA: "0.99" }, reason: "" } });
  assert.equal(threshold.legs[0].amountIn, "10000000000000000");
  assert.deepEqual((await buildOrders({ ...base, decision: { weights: { AAA: "0.990001" }, reason: "" } })).legs, []);
  state.ledger[ADDRESSES.usdg] = "1999999"; state.ledger[token] = "0";
  const scaled = await buildOrders({ ...base, decision: { weights: { AAA: "0.5", BBB: "0.5" }, reason: "" } });
  assert.deepEqual(scaled.legs, []);
  state.ledger[token] = "1";
  const unquoted = await buildOrders({ ...base, decision: { weights: {}, reason: "" }, quote: async () => { throw new Error("offline"); } });
  assert.equal(unquoted.dropped[0].leg.amountIn, MAX.toString()); assert.equal(unquoted.dropped[0].error.name, "QuoteUnavailable");
});

test("H6 simulation removes encoded buy gate errors and Q LaneBlocked, preserving sells", async () => {
  const assets = listing(), state = snapshot(assets); state.ledger[assets.assets[0].token] = "1000000000000000000";
  const seen: OrderLeg[][] = [], calls: any[] = [];
  const fake = { async request<T>(method: string, params: unknown[]): Promise<T> {
    calls.push([method, params]);
    const legs = calls.length === 1 ? ["BBB", "CCC"] : calls.length === 2 ? ["CCC"] : [];
    if (legs.length === 2) throw { data: encodeErrorResult({ abi: LANE_ABI, errorName: "TokenPaused", args: [assets.assets[1].token] }) };
    if (legs.length === 1) throw { data: encodeErrorResult({ abi: LANE_ABI, errorName: "LaneBlocked" }) };
    return "0x" as T;
  } };
  const orders = await buildOrders({ rpc: fake, listing: assets, snapshot: state, lane: lane.lane, agent: lane.agent, quoteBlock: 200,
    decision: { weights: { BBB: "0.4", CCC: "0.4" }, reason: "" }, quote: async () => 1000000n });
  assert.deepEqual(orders.legs.map(l => [l.symbol, l.buy]), [["AAA", false]]);
  assert.deepEqual(orders.dropped.map(d => d.error.name), ["TokenPaused", "LaneBlocked"]); assert.equal(orders.simulation.result, "passed");
  assert.equal(calls.length, 3); assert.equal(calls[0][0], "eth_call"); assert.equal(calls[0][1][1], "0xc8");
  assert.equal(calls[2][1][0].data, encodeFunctionData({ abi: LANE_ABI, functionName: "trade", args: [SIM, orders.legs.map(l => ({ pool: BigInt(l.pool), buy: l.buy, amountIn: BigInt(l.amountIn), minOut: BigInt(l.minOut) }))] }));
  const stopped = await buildOrders({ rpc, listing: assets, snapshot: state, lane: lane.lane, agent: lane.agent, quoteBlock: 200,
    decision: { weights: { BBB: "0.4" }, reason: "" }, quote: async () => 1000000n, simulate: async legs => { seen.push(structuredClone(legs)); return { name: "MinOut", args: ["0"] }; } });
  assert.equal(stopped.simulation.result, "failed"); assert.equal(stopped.legs.length, 2); assert.equal(seen.length, 1); assert.deepEqual(stopped.dropped, []);
});

test("execution quotes enforce sealed minOut against fresh output and resolve MAX from fresh ledger", async () => {
  const assets = listing(), leg: OrderLeg = { symbol: "AAA", pool: 0, buy: true, amountIn: "5000000", minOut: "995000", quoteOut: "1000000" };
  const options = { rpc, listing: assets, lane: lane.lane, legs: [leg], block: 202 };
  assert.equal(await checkExecutionQuotes({ ...options, quote: async () => 1000000n }), null);
  assert.deepEqual(await checkExecutionQuotes({ ...options, quote: async () => 1100000n }), { name: "QuoteMoved", args: ["0", "995000", "1100000"] });
  assert.equal(await checkExecutionQuotes({ ...options, quote: async () => 900000n }), null);
  const reverted = Object.assign(new Error("execution reverted"), { code: 3, data: encodeErrorResult({ abi: LANE_ABI, errorName: "NotAuthorized" }) });
  assert.equal((await checkExecutionQuotes({ ...options, quote: async () => { throw reverted; } }))?.name, "QuoteUnavailable");
  await assert.rejects(checkExecutionQuotes({ ...options, quote: async () => { throw new Error("all configured RPC endpoints failed"); } }), /all configured RPC endpoints failed/);
  leg.buy = false; leg.amountIn = MAX.toString();
  assert.equal(await checkExecutionQuotes({ ...options, readLane: async (_rpc, _lane, tokens, block) => {
    assert.equal(block, 202); assert.deepEqual(tokens, [assets.assets[0].token]);
    return { principal: 1000000000n, ledger: { [assets.assets[0].token]: 123n }, status: 1, agent: lane.agent, owner: lane.agent, seals: {} };
  }, quote: async (_rpc, _key, _direction, amount, block) => { assert.equal(amount, 123n); assert.equal(block, 202); return 1000000n; } }), null);
});
