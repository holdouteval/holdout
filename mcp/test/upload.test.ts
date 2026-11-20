import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emptyOrders } from "@holdout/core";
import { createAgentRecord } from "../src/record.js";
import { advanceUpload } from "../src/upload.js";
import { storeRecord, saveJournal, readJournal, type JournalEntry, type Journal } from "../src/journal.js";
import { FIXTURE } from "./read-fixtures.js";

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "mcp-upload-")); t.after(() => rm(home, { recursive: true, force: true }));
  const record = createAgentRecord({ lane: FIXTURE.lane, agent: FIXTURE.agent, time: FIXTURE.time, blocked: false, model: "agent", input: "observations", output: "hold", weights: null, orders: emptyOrders() });
  await storeRecord(home, FIXTURE.lane, record.h, record.bytes);
  const entry: JournalEntry = { requestId: "upload-1", requestDigest: record.h, h: record.h, kind: "seal", stage: "receipt", recordAt: 1,
    listing: { maxAge: 90000, actWindow: 1800, assets: [] }, orders: emptyOrders(),
    receipt: { transactionHash: "0x" + "1".repeat(64), blockHash: "0x" + "2".repeat(64), blockNumber: 1, status: 1, gasUsed: "1" }, upload: { state: "waiting" },
    result: { state: "held", h: record.h, tx: null, legs: [], dropped: [], simulation: null, upload: null, recordUrl: null, error: null } };
  const journal: Journal = { schema: "holdout.mcp-journal/1", lane: FIXTURE.lane, entries: [entry] };
  let now = 1_800_000_000_000;
  const calls: { method: string; body?: Uint8Array }[] = [], replies: (Response | Error)[] = [];
  const fetcher: typeof fetch = async (_url, options) => {
    calls.push({ method: options?.method ?? "GET", ...(options?.body ? { body: new Uint8Array(options.body as Uint8Array) } : {}) });
    const response = replies.shift(); if (!response) throw new Error("unexpected upload request"); if (response instanceof Error) throw response; return response;
  };
  const options = { home, lane: FIXTURE.lane, dataBase: "http://127.0.0.1:1", now: () => now, fetch: fetcher, save: () => saveJournal(home, journal) };
  return { home, record, entry, journal, options, replies, calls, advance(milliseconds: number) { now += milliseconds; } };
}
const response = (status: number, error?: string, headers?: Record<string, string>) => new Response(JSON.stringify(error ? { error } : {}), { status, headers });

test("M8 successful POST 200/201 verifies exact public bytes and rejects conflicting bytes", async t => {
  for (const status of [200, 201]) await t.test(String(status), async child => {
    const f = await fixture(child); f.replies.push(response(status), new Response(Buffer.from(f.record.bytes)));
    await advanceUpload(f.entry, f.options); assert.equal(f.entry.stage, "verified"); assert.equal(f.entry.upload.state, "verified");
    assert.deepEqual(Buffer.from(f.calls[0].body!), Buffer.from(f.record.bytes)); assert.deepEqual(f.calls.map(c => c.method), ["POST", "GET"]);
  });
  const f = await fixture(t); f.replies.push(response(201), new Response("{}"));
  await advanceUpload(f.entry, f.options); assert.equal(f.entry.upload.state, "error"); assert.equal(f.entry.upload.error, "record-content-conflict");
});

test("M8 202 checks at five minutes and reposts after sixty minutes of public 404", async t => {
  const f = await fixture(t); f.replies.push(response(202)); await advanceUpload(f.entry, f.options);
  assert.equal(f.entry.stage, "uploaded"); f.advance(299999); await advanceUpload(f.entry, f.options); assert.equal(f.calls.length, 1);
  f.advance(1); f.replies.push(response(404)); await advanceUpload(f.entry, f.options); assert.equal(f.calls.length, 2);
  f.advance(3300000); f.replies.push(response(404), response(201), new Response(Buffer.from(f.record.bytes)));
  await advanceUpload(f.entry, f.options); assert.equal(f.entry.stage, "verified"); assert.deepEqual(f.calls.map(c => c.method), ["POST", "GET", "GET", "POST", "GET"]);
});

test("M8 not-sealed honors Retry-After and unknown-lane retries at thirty seconds", async t => {
  for (const [status, error, delay] of [[409, "not-sealed", 7000], [404, "unknown-lane", 30000]] as const) await t.test(error, async child => {
    const f = await fixture(child); f.replies.push(response(status, error, status === 409 ? { "retry-after": "7" } : {}));
    await advanceUpload(f.entry, f.options); assert.equal(f.entry.upload.lastStatus, status); assert.equal(f.entry.upload.lastCode, error);
    f.advance(delay - 1); await advanceUpload(f.entry, f.options); assert.equal(f.calls.length, 1);
    f.advance(1); f.replies.push(response(201), new Response(Buffer.from(f.record.bytes))); await advanceUpload(f.entry, f.options); assert.equal(f.entry.stage, "verified");
  });
});

test("M8 permanent HTTP rejections stop retries and transient failures retry after thirty seconds", async t => {
  for (const status of [400, 404, 413, 415, 422]) await t.test(String(status), async child => {
    const f = await fixture(child); f.replies.push(response(status, "rejected")); await advanceUpload(f.entry, f.options);
    assert.equal(f.entry.upload.state, "error"); f.advance(3600000); await advanceUpload(f.entry, f.options); assert.equal(f.calls.length, 1);
  });
  for (const result of [response(503), new Error("connection lost")]) {
    const f = await fixture(t); f.replies.push(result); await advanceUpload(f.entry, f.options); f.advance(30000);
    f.replies.push(response(201), new Response(Buffer.from(f.record.bytes))); await advanceUpload(f.entry, f.options); assert.equal(f.entry.stage, "verified");
  }
});

test("M8 upload progress survives a journal restart without altering the record bytes", async t => {
  const f = await fixture(t); f.replies.push(response(404, "unknown-lane")); await advanceUpload(f.entry, f.options);
  const recovered = await readJournal(f.home, FIXTURE.lane); assert.equal(recovered.entries[0].upload.lastCode, "unknown-lane");
  f.advance(30000); f.replies.push(response(201), new Response(Buffer.from(f.record.bytes)));
  await advanceUpload(recovered.entries[0], { ...f.options, save: () => saveJournal(f.home, recovered) });
  assert.equal((await readJournal(f.home, FIXTURE.lane)).entries[0].stage, "verified");
});


