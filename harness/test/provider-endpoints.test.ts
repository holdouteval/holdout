import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SendClient } from "@holdout/core";
import { HarnessEngine } from "../src/engine.js";
import { loadConfig } from "../src/config.js";
import { runModelAttempt } from "../src/models.js";
import { OFFICIAL_PROVIDER_ENDPOINTS, providerEndpoints } from "../src/provider-endpoints.js";
import type { LaneConfig, Provider } from "../src/types.js";
import { listing, snapshot } from "./decision-fixtures.js";
import { anthropicFrames, openaiFrames, temporary } from "./model-support.js";

const NAMES = ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"] as const;
const TIME = 1794841200, DATE = "2026-11-16", CAPTURED = new Error("provider request captured");
function environment(t: TestContext, values: Partial<Record<typeof NAMES[number], string>>): void {
  const original = Object.fromEntries(NAMES.map(name => [name, process.env[name]]));
  for (const name of NAMES) if (values[name] === undefined) delete process.env[name]; else process.env[name] = values[name];
  t.after(() => { for (const name of NAMES) if (original[name] === undefined) delete process.env[name]; else process.env[name] = original[name]; });
}
async function runtime(t: TestContext, mode: "paper" | "send", local: boolean) {
  const directory = await temporary(t), config = loadConfig(fileURLToPath(new URL("../../config/mainnet.example.json", import.meta.url)));
  config.mode = mode; config.factory = "0x" + "f".repeat(40); config.dataDir = join(directory, "state");
  const warnings: string[] = [], urls: string[] = []; let boundaries = 0;
  const sender = { async assertBoundary() { boundaries++; return { local, chainId: 4663 as const }; } } as SendClient;
  const indexedFetch: typeof fetch = async () => new Response(JSON.stringify({ lanes: [] }), { headers: { "content-type": "application/json" } });
  const engine = new HarnessEngine(config, { sender, fetch: indexedFetch, logger: message => warnings.push(message),
    header: async () => ({ block: 101, time: TIME, hash: "0x" + "1".repeat(64) }),
    snapshot: async () => { const assets = listing(1), value = snapshot(assets); value.time = TIME;
      return { snapshot: value, listing: assets, openedTime: TIME - 86400, status: 0, principal: assets.principal }; },
    model: async options => {
      const captured: typeof fetch = async input => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url; urls.push(url);
        const events = options.provider === "anthropic" ? anthropicFrames(['{"weights":{},"reason":"captured"}'], { model: options.model })
          : openaiFrames(['{"weights":{},"reason":"captured"}'], { model: options.model });
        return new Response(events.join(""), { headers: { "content-type": "text/event-stream" } });
      };
      const result = await runModelAttempt({ ...options, apiKey: "endpoint-test-key", fetch: captured });
      assert.equal(result.error, null); assert.equal(result.completed, true);
      throw CAPTURED;
    },
  });
  t.after(() => engine.close());
  const request = async (provider: Provider) => {
    const lane: LaneConfig = config.lanes.find(value => config.models[value.model].provider === provider)!;
    await assert.rejects(engine.runLane(lane, { date: DATE, key: DATE, time: TIME, block: 101 }), error => error === CAPTURED);
  };
  return { engine, warnings, urls, request, boundaries: () => boundaries };
}

test("H5 paper mode pins both official SDK endpoints and warns once for environment overrides", async t => {
  environment(t, { ANTHROPIC_BASE_URL: "http://127.0.0.1:18881", OPENAI_BASE_URL: "http://127.0.0.1:18882/v1" });
  const run = await runtime(t, "paper", false);
  await run.engine.initialize(); await run.engine.initialize();
  await run.request("anthropic"); await run.request("openai");
  assert.deepEqual(run.urls, ["https://api.anthropic.com/v1/messages", "https://api.openai.com/v1/responses"]);
  assert.equal(run.boundaries(), 0);
  assert.equal(run.warnings.filter(line => line.includes("provider-endpoint-warning")).length, 1);
  assert.ok(run.warnings.every(line => !line.includes("18881") && !line.includes("18882")));
});

test("H5 an authenticated local sender routes each SDK to its loopback environment endpoint", async t => {
  environment(t, { ANTHROPIC_BASE_URL: "http://127.0.0.1:18881", OPENAI_BASE_URL: "http://127.0.0.1:18882/v1" });
  const run = await runtime(t, "send", true);
  await run.engine.initialize(); await run.engine.initialize();
  await run.request("anthropic"); await run.request("openai");
  assert.deepEqual(run.urls, ["http://127.0.0.1:18881/v1/messages", "http://127.0.0.1:18882/v1/responses"]);
  assert.equal(run.boundaries(), 1);
  assert.equal(run.warnings.filter(line => line.includes("provider-endpoint-warning")).length, 0);
});

test("H5 local sender startup rejects nonlocal, non-HTTP, implicit-port and credential-bearing provider URLs", async t => {
  for (const value of ["https://provider.invalid.example/v1", "http://localhost:18882/v1", "http://127.0.0.1/v1",
    "https://127.0.0.1:18882/v1", "http://user:pass@127.0.0.1:18882/v1", "http://127.0.0.1:18882/v1?token=private", ""]) {
    await t.test(value ? "invalid override" : "empty override", async child => {
      environment(child, { ANTHROPIC_BASE_URL: "http://127.0.0.1:18881", OPENAI_BASE_URL: value });
      const run = await runtime(child, "send", true);
      await assert.rejects(run.engine.initialize(), /provider base URL must use IPv4 loopback HTTP with an explicit port/);
      assert.equal(run.boundaries(), 1); assert.deepEqual(run.urls, []); assert.deepEqual(run.warnings, []);
    });
  }
});

test("nonlocal send policy ignores both overrides, and missing local overrides use official endpoints", () => {
  const warnings: string[] = [];
  assert.deepEqual(providerEndpoints({ mode: "send", local: false,
    env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:18881", OPENAI_BASE_URL: "https://provider.invalid.example" }, warn: message => warnings.push(message) }), OFFICIAL_PROVIDER_ENDPOINTS);
  assert.equal(warnings.length, 1);
  assert.deepEqual(providerEndpoints({ mode: "send", local: true, env: {} }), OFFICIAL_PROVIDER_ENDPOINTS);
});

test("standalone SDK attempts explicitly pin official endpoints when no injected endpoint is supplied", async t => {
  environment(t, { ANTHROPIC_BASE_URL: "http://127.0.0.1:18881", OPENAI_BASE_URL: "http://127.0.0.1:18882/v1" });
  const directory = await temporary(t), urls: string[] = [];
  for (const provider of ["anthropic", "openai"] as const) {
    const model = provider === "anthropic" ? "claude-haiku-5-5" : "gpt-6-astra";
    const captured: typeof fetch = async input => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response((provider === "anthropic" ? anthropicFrames(["answer"], { model }) : openaiFrames(["answer"], { model })).join(""),
        { headers: { "content-type": "text/event-stream" } });
    };
    const result = await runModelAttempt({ provider, model, system: "system", user: "user", rawPath: join(directory, provider + ".raw"), apiKey: "endpoint-test-key", fetch: captured });
    assert.equal(result.error, null); assert.equal(result.completed, true);
  }
  assert.deepEqual(urls, ["https://api.anthropic.com/v1/messages", "https://api.openai.com/v1/responses"]);
});
