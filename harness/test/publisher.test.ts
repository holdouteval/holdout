import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize, sha256Hex } from "@holdout/core";
import { atomicJson, newJournal, readJson, storeRecord, type Journal } from "../src/journal.js";
import { publish } from "../src/publisher.js";
import type { HarnessConfig } from "../src/types.js";
import { lane } from "./decision-fixtures.js";

interface Call { url: string; method: string; body: Buffer | null }
interface Reply { status: number; body?: string | Uint8Array; headers?: Record<string, string> }
async function fixture(t: TestContext, handler: (call: Call) => Reply) {
  const directory = await mkdtemp(join(tmpdir(), "harness-publish-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = canonicalize({ schema: "publication.test/1", lane: lane.lane, value: "original" }), h = sha256Hex(bytes);
  const path = join(directory, "journal.json");
  let journal = newJournal(lane, { date: "2026-11-16", key: "2026-11-16", time: 1794837600, mode: "send", now: 1000 });
  journal.record = { h, path: await storeRecord(directory, h, bytes) };
  journal.transactions.push({ kind: "seal", signedAt: 1000, signed: { rawTransaction: "0x02", hash: h, nonce: "0", gas: "42000", maxFeePerGas: "2", maxPriorityFeePerGas: "0", from: lane.agent, to: lane.lane, data: "0x", value: "0" },
    receipt: { transactionHash: h, blockNumber: 123, blockHash: "0x" + "a".repeat(64), status: 1, gasUsed: "21000" } });
  const config: HarnessConfig = { mode: "send", budget: { monthlyUsd: "30" }, rpc: {}, dataDir: directory, publicBase: "https://public.example.invalid", adminBase: "http://127.0.0.1:8788", factory: null, lanes: [lane], models: {}, prices: {}, listingFile: "unused", cutoffsFile: "unused", paperMaxAge: 90000 };
  const calls: Call[] = []; let clock = 1000, saves = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const call = { url: String(input), method: init?.method ?? "GET", body: init?.body ? Buffer.from(init.body as Uint8Array) : null };
    calls.push(call); const reply = handler(call);
    return new Response(reply.body === undefined ? null : Buffer.from(reply.body), { status: reply.status, headers: reply.headers });
  };
  const save = async () => { saves++; await atomicJson(path, journal); };
  await save();
  return { config, bytes: Buffer.from(bytes), h, calls, get journal() { return journal; }, get saves() { return saves; }, now: () => clock,
    at: (value: number) => { clock = value; }, run: () => publish(config, journal, { now: () => clock, fetch: fetcher, save }),
    restart: async () => { journal = (await readJson<Journal>(path))!; assert.ok(journal); }, save };
}
function execution(journal: Journal): void {
  journal.execution = { schema: "holdout.execution/1", h: journal.record!.h, lane: journal.lane, outcome: "reverted", error: { name: "QuoteMoved", args: ["0", "995000", "1100000"] }, stage: "quote", tx: null };
}

test("record publication posts unchanged bytes to admin and verifies through the public listener", async t => {
  let bytes: Buffer;
  const f = await fixture(t, call => call.method === "POST" ? { status: 201 } : { status: 200, body: bytes }); bytes = f.bytes;
  await f.run();
  assert.deepEqual(f.calls.map(call => [call.method, call.url]), [["POST", f.config.adminBase + "/r"], ["GET", f.config.publicBase + `/r/${f.h}.json`]]);
  assert.deepEqual(f.calls[0].body, f.bytes); assert.equal(f.journal.recordPublication.verifiedAt, 1000); assert.equal(f.journal.stage, "verified");
  const count = f.calls.length; await f.restart(); await f.run(); assert.equal(f.calls.length, count);
});

test("paper, review-pending and unconfirmed journals never upload", async t => {
  const f = await fixture(t, () => ({ status: 500 }));
  f.journal.mode = "paper"; await f.run(); assert.equal(f.calls.length, 0);
  f.journal.mode = "send"; f.journal.review = { state: "pending", time: 1000 }; await f.run(); assert.equal(f.calls.length, 0);
  delete f.journal.review; delete f.journal.transactions[0].receipt; await f.run(); assert.equal(f.calls.length, 0);
  f.journal.transactions = []; await f.run(); assert.equal(f.calls.length, 0);
});

test("record 409 not-sealed follows Retry-After and resumes the persisted state", async t => {
  let posts = 0, bytes: Buffer;
  const f = await fixture(t, call => call.method === "GET" ? { status: 200, body: bytes }
    : ++posts === 1 ? { status: 409, body: '{"error":"not-sealed"}', headers: { "retry-after": "7" } } : { status: 201 }); bytes = f.bytes;
  await f.run(); assert.equal(f.journal.recordPublication.nextAttempt, 1007); assert.equal(f.calls.length, 1);
  await f.restart(); f.at(1006); await f.run(); assert.equal(f.calls.length, 1);
  f.at(1007); await f.run(); assert.equal(posts, 2); assert.equal(f.journal.recordPublication.verifiedAt, 1007);
  assert.deepEqual(f.calls.filter(call => call.method === "POST").map(call => call.body), [f.bytes, f.bytes]);
});

test("202 waits five minutes between checks and reposts after sixty minutes of 404 across restart", async t => {
  let visible = false, bytes: Buffer;
  const f = await fixture(t, call => call.method === "POST" ? { status: 202 } : visible ? { status: 200, body: bytes } : { status: 404 }); bytes = f.bytes;
  await f.run(); assert.equal(f.calls.length, 1); assert.equal(f.journal.recordPublication.acceptedAt, 1000);
  await f.restart(); f.at(1299); await f.run(); assert.equal(f.calls.length, 1);
  f.at(1300); await f.run(); assert.equal(f.calls.length, 2); assert.equal(f.journal.recordPublication.lastCheck, 1300);
  f.at(1599); await f.run(); assert.equal(f.calls.length, 2);
  f.at(1600); await f.run(); assert.equal(f.calls.length, 3);
  f.at(4300); await f.run(); assert.equal(f.calls.filter(call => call.method === "POST").length, 1);
  f.at(4599); await f.run(); assert.equal(f.calls.length, 4);
  await f.restart(); f.at(4600); await f.run(); assert.equal(f.calls.filter(call => call.method === "POST").length, 2);
  assert.equal(f.journal.recordPublication.acceptedAt, 4600); assert.equal(f.journal.recordPublication.status, 202);
  assert.deepEqual(f.calls.filter(call => call.method === "POST").map(call => call.body), [f.bytes, f.bytes]);
  visible = true; await f.restart(); f.at(4899); await f.run(); assert.equal(f.journal.recordPublication.verifiedAt, undefined);
  f.at(4900); await f.run(); assert.equal(f.journal.recordPublication.verifiedAt, 4900); assert.equal(f.journal.stage, "verified");
});

test("execution not-sealed retries after restart and 202 verification compares JSON values", async t => {
  let posts = 0, body = "";
  const f = await fixture(t, call => call.method === "GET" ? { status: 200, body }
    : ++posts === 1 ? { status: 409, body: '{"error":"not-sealed"}', headers: { "retry-after": "30" } } : { status: 202 });
  f.journal.recordPublication.verifiedAt = 1000; execution(f.journal);
  body = JSON.stringify(Object.fromEntries(Object.entries(f.journal.execution!).reverse()), null, 2);
  await f.run(); assert.equal(f.journal.executionPublication.nextAttempt, 1030);
  assert.equal(f.calls[0].url, f.config.adminBase + `/x/${f.h}`);
  assert.deepEqual(JSON.parse(f.calls[0].body!.toString()), f.journal.execution);
  await f.restart(); f.at(1029); await f.run(); assert.equal(posts, 1);
  f.at(1030); await f.run(); assert.equal(posts, 2); assert.equal(f.journal.executionPublication.acceptedAt, 1030);
  await f.restart(); f.at(1329); await f.run(); assert.equal(f.calls.length, 2);
  f.at(1330); await f.run(); assert.equal(f.calls[2].url, f.config.publicBase + `/x/${f.h}.json`);
  assert.equal(f.journal.executionPublication.verifiedAt, 1330); assert.equal(f.journal.executionPublication.error, undefined); assert.equal(f.journal.stage, "verified");
});

test("execution content-conflict is terminal and is not confused with delayed seal visibility", async t => {
  const f = await fixture(t, () => ({ status: 409, body: '{"error":"content-conflict"}', headers: { "retry-after": "30" } }));
  f.journal.recordPublication.verifiedAt = 1000; execution(f.journal);
  await f.run(); assert.equal(f.journal.executionPublication.error, "content-conflict"); assert.equal(f.journal.executionPublication.nextAttempt, undefined);
  await f.restart(); f.at(10000); await f.run(); assert.equal(f.calls.length, 1);
});

test("record verification requires exact bytes and other client errors stop retries", async t => {
  let bytes: Buffer;
  const mismatch = await fixture(t, call => call.method === "POST" ? { status: 201 } : { status: 200, body: Buffer.concat([bytes, Buffer.from("\n")]) }); bytes = mismatch.bytes;
  await mismatch.run(); assert.equal(mismatch.journal.recordPublication.error, "published-content-mismatch");
  await mismatch.restart(); mismatch.at(10000); await mismatch.run(); assert.equal(mismatch.calls.length, 2);
  const rejected = await fixture(t, () => ({ status: 415, body: '{"error":"content-type"}' }));
  await rejected.run(); assert.equal(rejected.journal.recordPublication.error, "publication-http-415");
  await rejected.restart(); rejected.at(10000); await rejected.run(); assert.equal(rejected.calls.length, 1);
});
