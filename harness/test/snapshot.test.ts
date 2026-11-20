import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADDRESSES } from "@holdout/core";
import { validateConfig } from "../src/config.js";
import { closingAnswer, collectSnapshot, recentHistory } from "../src/snapshot.js";
import { buildPrompt } from "../src/prompt.js";
import { lane, listing, rpc } from "./decision-fixtures.js";

test("fixed S snapshot uses real listing, ledger, best costs, ordered gates and effective close activation", async () => {
  const config = validateConfig(JSON.parse(readFileSync(new URL("../../config/mainnet.example.json", import.meta.url), "utf8")));
  config.factory = "0x" + "3".repeat(40);
  const assets = listing(6), now = Date.parse("2026-11-30T15:00:00Z") / 1000, close = Date.parse("2026-11-27T18:00:00Z") / 1000;
  const calls: [string, unknown][] = [], hash = "0x" + "0".repeat(64), a = assets.assets;
  a[0].pools.push({ ...a[0].pools[0], index: 6, key: { ...a[0].pools[0].key, fee: 200 } });
  const oldReason = "🧠".repeat(500), rows = {
    carry: [close - 100000, 9900000000, 0, 1, hash, 0, 1, null],
    rounds: [[close + 300, 10000000000, 0, 2, hash, 0, 2, close - 60], [close - 300, 10100000000, 0, 3, hash, 0, 3, close + 60]],
  };
  const paths: string[] = [];
  const fetcher: typeof fetch = async input => {
    const path = new URL(String(input)).pathname; paths.push(path);
    const body = path === "/d/status.json" ? { sessions: { recent: [[close - 14400, close - 12600, close], [now - 1800, now, now + 21600]] } }
      : path === "/d/lanes.json" ? { lanes: [{ address: lane.lane, opened: { time: now - 100000 }, decisions: [
        { house: { weights: { AAA: "0.5" }, reason: oldReason }, sealed: { time: Date.parse("2026-11-28T00:05:00Z") / 1000, block: 10 } },
      ] }] } : { feeds: Object.fromEntries(a.map(asset => [asset.symbol, rows])) };
    return new Response(JSON.stringify(body));
  };
  const result = await collectSnapshot({ rpc, config, lane, block: 123, fetch: fetcher, read: {
    header: async (_rpc, block) => { calls.push(["header", block]); return { block: 123, time: now, hash }; },
    factory: async (_rpc, _factory, block) => { calls.push(["factory", block]); return { assets: a.map(asset => ({ ...asset, assetOf: asset.assetId + 1 })), pools: a.flatMap(asset => asset.pools), maxAge: 90000, actWindow: 1800, usdg: ADDRESSES.usdg, accessRegistry: ADDRESSES.accessRegistry }; },
    lane: async (_rpc, _lane, _tokens, block) => { calls.push(["lane", block]); return { principal: 1000000000n, ledger: { [ADDRESSES.usdg]: 500000000n, [a[0].token]: 5000000000000000000n }, status: 1, owner: lane.agent, agent: lane.agent, seals: {} }; },
    markets: async (_rpc, _assets, _lane, block) => { calls.push(["markets", block]); return { blocked: false, assets: a.map((asset, index) => ({ ...asset, assetOf: asset.assetId + 1, paused: index === 0, oraclePaused: index <= 1, roundId: 1n, answer: index === 2 ? 0n : 10000000000n, updatedAt: index === 3 ? now - 90001 : now - 100 })) }; },
    quote: async (_rpc, key, zeroForOne, _amount, block) => { calls.push(["quote", block]); const index = a.findIndex(asset => asset.token === key.currency0 || asset.token === key.currency1); if (index === 5) throw new Error("pool offline"); return zeroForOne ? 249000000n : index === 4 ? 3000000000000000000n : key.fee === 200 ? 2600000000000000000n : 2500000000000000000n; },
  } });
  assert.ok(calls.every(([, block]) => block === 123));
  assert.equal(result.snapshot.value, "1000000000"); assert.equal(result.status, 1); assert.equal(result.openedTime, now - 100000);
  assert.deepEqual(result.snapshot.assets.map(asset => asset.gate), ["TokenPaused", "OracleFlagged", "BadFeed", "StaleFeed", "DiscountToFeed", "open"]);
  assert.equal(result.snapshot.assets[0].buyCostBps, -384); assert.equal(result.snapshot.assets[0].sellCostBps, 40);
  assert.equal(result.snapshot.assets[5].buyCostBps, null); assert.equal(result.snapshot.assets[5].sellCostBps, null);
  assert.deepEqual(result.snapshot.assets[0].closes, [["2026-11-27", 10000000000]]);
  assert.deepEqual(paths.filter(path => path.startsWith("/d/tape/")), ["/d/tape/2026-11-27.json"]);
  assert.equal(result.snapshot.history[0].date, "2026-11-27"); assert.equal(result.snapshot.history[0].reason, "🧠".repeat(400) + "…");
});

test("close carry and recent history have explicit missing values and preserve latest seal ordering", () => {
  const row = [10, 20, 0, 1, "0x", 1, 1, null];
  assert.equal(closingAnswer({ feeds: { AAA: { carry: row, rounds: [] } } }, "AAA", 10), 20);
  assert.equal(closingAnswer({ feeds: { AAA: { carry: row, rounds: [] } } }, "AAA", 9), null);
  assert.equal(closingAnswer({}, "AAA", 10), null);
  const history = recentHistory([1, 2, 3, 4].map(i => ({ sealed: { time: 1000 + i, block: i }, house: { weights: {}, reason: String(i) } })));
  assert.deepEqual(history.map(h => h.reason), ["4", "3", "2"]);
});

test("live snapshot and prompt use each lane's opening principal instead of a shared factory or indexed value", async () => {
  const config = validateConfig(JSON.parse(readFileSync(new URL("../../config/mainnet.example.json", import.meta.url), "utf8")));
  config.factory = "0x" + "3".repeat(40);
  const now = 1796050800;
  for (const principal of [37500000n, 200000000n]) {
    const value = principal * 11n / 10n;
    const result = await collectSnapshot({ rpc, config, lane, block: 321, fetch: async input => new Response(JSON.stringify(
      new URL(String(input)).pathname === "/d/status.json" ? { sessions: { recent: [] } }
        : { lanes: [{ address: lane.lane, principal: "1000000000", opened: { time: now - 86400 }, decisions: [] }] }
    )), read: {
      header: async (_rpc, block) => { assert.equal(block, 321); return { block: 321, time: now, hash: "0x" + "1".repeat(64) }; },
      factory: async (_rpc, _factory, block) => { assert.equal(block, 321); return { assets: [], pools: [], maxAge: 90000, actWindow: 1800, usdg: ADDRESSES.usdg, accessRegistry: ADDRESSES.accessRegistry }; },
      lane: async (_rpc, address, _tokens, block) => { assert.equal(address, lane.lane); assert.equal(block, 321); return { principal, ledger: { [ADDRESSES.usdg]: value }, status: 1, owner: lane.agent, agent: lane.agent, seals: {} }; },
      markets: async () => ({ blocked: false, assets: [] }),
    } });
    assert.equal(result.principal, principal.toString()); assert.equal(result.listing.principal, principal.toString());
    assert.equal(result.snapshot.value, value.toString()); assert.equal(result.snapshot.ledger[ADDRESSES.usdg], value.toString());
    const prompt = buildPrompt(result.snapshot, result);
    assert.ok(prompt.user.includes(principal === 37500000n ? "with 37.50 USDG" : "with 200.00 USDG"));
    assert.ok(prompt.user.includes("+10.00% since opening"));
  }
});

test("paper snapshots retain the configured virtual principal when their ledger changes", async t => {
  const directory = await mkdtemp(join(tmpdir(), "harness-principal-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const config = validateConfig(JSON.parse(readFileSync(new URL("../../config/mainnet.example.json", import.meta.url), "utf8")));
  config.factory = null; config.listingFile = join(directory, "listing.json");
  await writeFile(config.listingFile, JSON.stringify({ principal: "37500000", actWindow: 1800, assets: [] }));
  const options = { rpc, config, lane, block: 321, fetch: async () => new Response(JSON.stringify({ lanes: [], sessions: { recent: [] } })), read: {
    header: async () => ({ block: 321, time: 1796050800, hash: "0x" + "1".repeat(64) }),
    factory: async () => { throw new Error("paper must not read a factory"); },
    lane: async () => { throw new Error("paper must not read a lane"); },
    markets: async () => ({ blocked: false, assets: [] }),
  } };
  const initial = await collectSnapshot(options), later = await collectSnapshot({ ...options, ledger: { [ADDRESSES.usdg]: "41250000" } });
  assert.equal(initial.principal, "37500000"); assert.equal(initial.snapshot.ledger[ADDRESSES.usdg], "37500000");
  assert.equal(later.principal, "37500000"); assert.equal(later.listing.principal, "37500000"); assert.equal(later.snapshot.value, "41250000");
  assert.ok(buildPrompt(later.snapshot, later).user.includes("+10.00% since opening"));
});
