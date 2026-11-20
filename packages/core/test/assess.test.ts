import test from "node:test";
import assert from "node:assert/strict";
import { ADDRESSES, assess } from "../src/index.js";
import { lane, listing, rpc } from "./orders-fixtures.js";

test("C2 assessor preserves the ordered gates, best quotes, costs and source flags", async () => {
  const assets = listing(6), now = 1796050800, a = assets.assets;
  a[0].pools.push({ ...a[0].pools[0], index: 6, key: { ...a[0].pools[0].key, fee: 200 } });
  const calls: (number | string)[] = [];
  const base = { rpc, listing: assets, lane: lane.lane, block: 123, accessRegistry: ADDRESSES.accessRegistry, time: now };
  const read = {
    markets: async (_rpc: unknown, _assets: unknown, address: string, block: unknown, registry?: string) => {
      assert.equal(address, lane.lane); assert.equal(registry, ADDRESSES.accessRegistry); calls.push(block as number);
      return { blocked: false, assets: a.map((asset, index) => ({ ...asset, assetOf: asset.assetId + 1, paused: index === 0, oraclePaused: index <= 1,
        roundId: 1n, answer: index === 2 ? 0n : 10000000000n, updatedAt: index === 3 ? now - 90001 : now - 100 })) };
    },
    quote: async (_rpc: unknown, key: typeof a[number]["pools"][number]["key"], zeroForOne: boolean, _amount: bigint, block: unknown) => {
      calls.push(block as number); const index = a.findIndex(asset => asset.token === key.currency0 || asset.token === key.currency1);
      if (index === 5) throw new Error("pool offline");
      return zeroForOne ? 249000000n : index === 4 ? 3000000000000000000n : key.fee === 200 ? 2600000000000000000n : 2500000000000000000n;
    },
  };
  const result = await assess({ ...base, read });
  assert.equal(result.blocked, false); assert.ok(calls.every(block => block === 123));
  assert.deepEqual(result.assets.map(asset => asset.gate), ["TokenPaused", "OracleFlagged", "BadFeed", "StaleFeed", "DiscountToFeed", "open"]);
  assert.equal(result.assets[0].buyCostBps, -384); assert.equal(result.assets[0].sellCostBps, 40);
  assert.equal(result.assets[5].buyCostBps, null); assert.equal(result.assets[5].sellCostBps, null);
  assert.equal(result.assets[0].paused, true); assert.equal(result.assets[1].oraclePaused, true);
  assert.equal(result.assets[0].roundId, "1"); assert.equal(result.assets[0].age, 100);
  const blocked = await assess({ ...base, read: { ...read, markets: async (...args) => ({ ...await read.markets(...args), blocked: true }) } });
  assert.deepEqual(blocked.assets.map(asset => asset.gate), ["TokenPaused", "OracleFlagged", "LaneBlocked", "LaneBlocked", "LaneBlocked", "LaneBlocked"]);
});
