import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADDRESSES } from "@holdout/core";
import { LaneReader, PRINCIPAL_RULE } from "../src/read.js";
import { FIXTURE, readFixture } from "./read-fixtures.js";

test("M2 startup verifies the lane's actual factory and preserves read-only startup without an agent key", async t => {
  const home = await mkdtemp(join(tmpdir(), "mcp-read-")); t.after(() => rm(home, { recursive: true, force: true }));
  const fixture = readFixture(), reader = new LaneReader({ lane: FIXTURE.lane, home, dataBase: null, siteBase: null }, { rpc: fixture.rpc });
  await reader.initialize(); assert.equal(reader.key, null);
  assert.deepEqual(reader.identity, { factory: FIXTURE.factory, owner: FIXTURE.owner, agent: FIXTURE.agent, status: 1 });
  assert.ok(fixture.state.calls.includes("isLane"));
  fixture.state.isLane = false; await assert.rejects(reader.initialize(), /unknown-lane/);
});

test("M4 rules, market and lane use the same fixed block and expose chain values with unavailable history", async t => {
  const home = await mkdtemp(join(tmpdir(), "mcp-read-")); t.after(() => rm(home, { recursive: true, force: true }));
  const fixture = readFixture(), reader = new LaneReader({ lane: FIXTURE.lane, home, dataBase: null, siteBase: "https://example.test" }, { rpc: fixture.rpc });
  await reader.initialize();
  const rules = await reader.rules() as any, market = await reader.market() as any, lane = await reader.lane([{ h: "pending", stage: "receipt" }]) as any;
  assert.equal(rules.principal, PRINCIPAL_RULE); assert.equal(rules.maxAge, 90000); assert.equal(rules.actWindow, 1800);
  assert.equal(rules.burnAmount, (100000n * 10n ** 18n).toString());
  assert.deepEqual(rules.gates.map((gate: any) => gate.name), ["NotListed", "TokenPaused", "OracleFlagged", "LaneBlocked", "BadFeed", "StaleFeed", "DiscountToFeed"]);
  assert.equal(rules.assets.length, 2); assert.equal(rules.pools.length, 2); assert.ok(rules.execution.includes("buys only"));
  assert.equal(market.block, 123); assert.equal(market.time, FIXTURE.time); assert.equal(market.blocked, false);
  assert.deepEqual(market.assets.map((asset: any) => [asset.gate, asset.buyCostBps, asset.sellCostBps]), [["open", 0, 0], ["open", 0, 0]]);
  assert.equal(lane.principal, "1000000000"); assert.equal(lane.value, "1000000000"); assert.equal(lane.ledger[ADDRESSES.usdg], "500000000"); assert.equal(lane.weights.NVDA, "0.5"); assert.equal(lane.weights.AAPL, "0");
  assert.equal(lane.returnedUsdg, "123"); assert.equal(lane.finalUsdg, "456"); assert.equal(lane.agentEthBalance, "1000000000000000"); assert.equal(lane.decisions, "unavailable");
  assert.deepEqual(lane.pending, [{ h: "pending", stage: "receipt" }]);
  assert.equal(lane.closeUrl, `https://example.test/#close?lane=${FIXTURE.lane}`);
  fixture.state.status = 2; assert.equal((await reader.lane() as any).status, "closing");
  fixture.state.status = 3; assert.equal((await reader.lane() as any).status, "closed");
});

test("M4 market gates and indexed lane history remain explicit when the data listener is unavailable", async t => {
  const home = await mkdtemp(join(tmpdir(), "mcp-read-")); t.after(() => rm(home, { recursive: true, force: true }));
  const fixture = readFixture(); fixture.state.paused.add(fixture.assets[0].token); fixture.state.oraclePaused.add(fixture.assets[1].token); fixture.state.blocked = true;
  let unavailable = false;
  const reader = new LaneReader({ lane: FIXTURE.lane, home, dataBase: "http://127.0.0.1:18888", siteBase: null }, { rpc: fixture.rpc,
    fetch: async () => { if (unavailable) throw new Error("indexer offline"); return new Response(JSON.stringify({ lanes: [{ address: FIXTURE.lane, decisions: [{ h: "known", state: "held", record: true }] }] })); } });
  await reader.initialize(); const market = await reader.market() as any;
  assert.equal(market.blocked, true); assert.deepEqual(market.assets.map((asset: any) => asset.gate), ["TokenPaused", "OracleFlagged"]);
  assert.deepEqual((await reader.lane() as any).decisions, [{ h: "known", state: "held", record: true }]);
  unavailable = true; assert.equal((await reader.lane() as any).decisions, "unavailable");
});

test("principal rules are general while lane reads retain their own fixed opening amount", async t => {
  const home = await mkdtemp(join(tmpdir(), "mcp-principal-")); t.after(() => rm(home, { recursive: true, force: true }));
  for (const principal of [1n, 37500000n, 10n ** 24n]) {
    const fixture = readFixture(); fixture.state.principal = principal;
    const reader = new LaneReader({ lane: FIXTURE.lane, home, dataBase: null, siteBase: null }, { rpc: fixture.rpc });
    await reader.initialize();
    const rules = await reader.rules() as any, before = await reader.lane() as any;
    assert.equal(rules.principal, "The opener chooses the USDG principal. It must be greater than zero and stays fixed after opening.");
    assert.equal(before.principal, principal.toString());
    fixture.state.value = 1200000000n; fixture.ledger[ADDRESSES.usdg] = 700000000n;
    const after = await reader.lane() as any;
    assert.equal(after.principal, principal.toString()); assert.equal(after.value, "1200000000");
  }
});
