import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, inspectHouseRecord } from "@holdout/core";
import { normalizeWeights, parseDecision } from "../src/parse.js";
import { buildPrompt, shortenReason, SYSTEM } from "../src/prompt.js";
import { loadListing, validateConfig } from "../src/config.js";
import { publicConfig, publicConfigBytes } from "../src/public-config.js";
import { snapshot } from "./decision-fixtures.js";

test("H2 weights accept decimal strings, normalize exactly, and satisfy house parsing", () => {
  assert.deepEqual(normalizeWeights({ aaa: "0.123456999", BBB: -3, USDG: 1, OUT: 7, CCC: {}, DDD: "NaN" }, ["AAA", "BBB", "CCC", "DDD"]), { AAA: "0.123456" });
  assert.deepEqual(normalizeWeights({ AAA: "2", BBB: 1 }, ["AAA", "BBB"]), { AAA: "0.666666", BBB: "0.333333" });
  assert.deepEqual(normalizeWeights({ AAA: "1e-6", BBB: ".000000999", CCC: "1.00000000000000001" }, ["AAA", "BBB", "CCC"]), { CCC: "0.999998" });
  const parsed = parseDecision('first {"weights":{"AAA":1}}\nfinal {"weights":{"bbb":".25","aaa":".5"},"reason":"  exact\\nreason  "} done', ["AAA", "BBB"]);
  assert.deepEqual(parsed, { weights: { AAA: "0.5", BBB: "0.25" }, reason: "  exact\nreason  " });
  assert.deepEqual(inspectHouseRecord({ decision: parsed }), parsed);
  assert.deepEqual(parseDecision('{"weights":{},"reason":4}', ["AAA"]), { weights: {}, reason: "" });
  assert.equal(parseDecision("unclosed {", ["AAA"]), null);
  assert.equal(parseDecision('{"weights":[]}', ["AAA"]), null);
});

test("H3 prompt bytes match a fixed fixture and depend only on lane data", () => {
  const data = snapshot(); data.ledger[data.assets[0].token] = "1250000000000000000"; data.value = "1125000000";
  data.assets[1].gate = "TokenPaused"; data.assets[1].buyCostBps = null; data.assets[2].sellCostBps = -15;
  data.history = [{ date: "2026-11-12", weights: { BBB: "0.1", AAA: "0.5" }, reason: "Keep the current mix." }];
  const prompt = buildPrompt(data, { openedTime: 1794308400, principal: "1000000000" });
  assert.equal(prompt.system, SYSTEM);
  assert.equal(prompt.user, readFileSync(new URL("../../test/fixtures/prompt.txt", import.meta.url), "utf8"));
  for (let laneIndex = 0; laneIndex < 5; laneIndex++) assert.deepEqual(buildPrompt(structuredClone(data), { openedTime: 1794308400, principal: "1000000000" }), prompt);
  assert.ok(!prompt.user.includes("review")); assert.ok(!prompt.user.includes("claude-")); assert.ok(!prompt.user.includes("gpt-"));
  assert.equal(shortenReason("🧠".repeat(401)), "🧠".repeat(400) + "…");
});




test("monthly budget defaults only in paper mode and send requires a positive decimal", () => {
  const raw = JSON.parse(readFileSync(new URL("../../config/mainnet.example.json", import.meta.url), "utf8"));
  delete raw.budget;
  assert.equal(validateConfig(raw).budget.monthlyUsd, "30");
  const send = { ...raw, mode: "send", factory: "0x" + "1".repeat(40) };
  assert.throws(() => validateConfig(send));
  for (const monthlyUsd of ["0", "0.0", "-1", "NaN", "1e3", 100, "0.0000000001"]) assert.throws(() => validateConfig({ ...send, budget: { monthlyUsd } }));
  assert.equal(validateConfig({ ...send, budget: { monthlyUsd: "1000000" } }).budget.monthlyUsd, "1000000");
});
