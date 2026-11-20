import { readFileSync } from "node:fs";
import { ADDRESSES } from "@holdout/core";
import { validateConfig } from "../src/config.js";
import { collectSnapshot } from "../src/snapshot.js";
import { createRecord } from "../src/record.js";
import { buildPrompt } from "../src/prompt.js";
import { lane, listing, rpc } from "./decision-fixtures.js";

export async function snapshotRecordFixture(blocked = false) {
  const config = validateConfig(JSON.parse(readFileSync(new URL("../../config/mainnet.example.json", import.meta.url), "utf8")));
  config.factory = "0x" + "3".repeat(40);
  const assets = listing(6), now = 1796050800, close = 1795802400, hash = "0x" + "0".repeat(64);
  assets.assets[0].pools.push({ ...assets.assets[0].pools[0], index: 6, key: { ...assets.assets[0].pools[0].key, fee: 200 } });
  const result = await collectSnapshot({ rpc, config, lane, block: 123, fetch: async input => {
    const path = new URL(String(input)).pathname;
    const body = path === "/d/status.json" ? { sessions: { recent: [[close - 14400, close - 12600, close]] } }
      : path === "/d/lanes.json" ? { lanes: [{ address: lane.lane, opened: { time: now - 100000 }, decisions: [] }] }
      : { feeds: Object.fromEntries(assets.assets.map(asset => [asset.symbol, { carry: [close - 1, 9900000000, 0, 1, hash, 0, 1, null], rounds: [] }])) };
    return new Response(JSON.stringify(body));
  }, read: {
    header: async () => ({ block: 123, time: now, hash }),
    factory: async () => ({ assets: assets.assets.map(asset => ({ ...asset, assetOf: asset.assetId + 1 })), pools: assets.assets.flatMap(asset => asset.pools), maxAge: 90000, actWindow: 1800, usdg: ADDRESSES.usdg, accessRegistry: ADDRESSES.accessRegistry }),
    lane: async () => ({ principal: 1000000000n, ledger: { [ADDRESSES.usdg]: 500000000n, [assets.assets[0].token]: 5000000000000000000n }, status: 1, owner: lane.agent, agent: lane.agent, seals: {} }),
    markets: async () => ({ blocked, assets: assets.assets.map((asset, index) => ({ ...asset, assetOf: asset.assetId + 1, paused: index === 0, oraclePaused: index <= 1, roundId: 1n, answer: index === 2 ? 0n : 10000000000n, updatedAt: index === 3 ? now - 90001 : now - 100 })) }),
    quote: async (_rpc, key, zeroForOne) => {
      const index = assets.assets.findIndex(asset => asset.token === key.currency0 || asset.token === key.currency1);
      if (index === 5) throw new Error("pool offline");
      return zeroForOne ? 249000000n : index === 4 ? 3000000000000000000n : key.fee === 200 ? 2600000000000000000n : 2500000000000000000n;
    },
  } });
  const prompt = buildPrompt(result.snapshot, result);
  return createRecord({ lane, time: now, date: "2026-11-30", harness: { version: "0.0.0", commit: null },
    snapshot: result.snapshot, request: { ...prompt, params: { provider: "anthropic", model: lane.model, effort: "high", maxOutputTokens: 64000, stream: true } },
    response: { used: 1, attempts: [] }, decision: { weights: {}, reason: "fixture decision" } });
}
