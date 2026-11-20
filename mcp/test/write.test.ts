import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { ADDRESSES, canonicalize, sha256Hex, validateRecord, NonceConflictError } from "@holdout/core";
import { readJournal, recordPath, withAgentLock, AgentBusy } from "../src/journal.js";
import { DecisionEngine } from "../src/engine.js";
import { FIXTURE } from "./read-fixtures.js";
import { input, writeFixture } from "./write-support.js";

test("M6 real shared orders and guarded sender execute, canonically publish, and replay one decision", async t => {
  const f = await writeFixture(t);
  const first = await f.engine.decide(input());
  assert.equal(first.state, "executed", JSON.stringify(first)); assert.equal(first.error, null);
  assert.equal(first.legs.length, 1); assert.equal(first.legs[0].symbol, "NVDA"); assert.equal((first.upload as any).state, "verified");
  const journal = await readJournal(f.home, FIXTURE.lane), entry = journal.entries[0];
  assert.equal(entry.stage, "verified"); assert.equal(entry.receipt!.status, 1); assert.ok(entry.signedAt); assert.ok(entry.broadcastAttemptedAt); assert.ok(entry.sentAt);
  assert.equal(f.chain.writeState.sealEvents.filter(e => e.h === first.h).length, 1);
  const bytes = await readFile(recordPath(f.home, FIXTURE.lane, first.h!)), record = JSON.parse(bytes.toString());
  assert.deepEqual(bytes, Buffer.from(canonicalize(record))); assert.equal(sha256Hex(bytes), first.h); validateRecord(record);
  assert.equal(record.orders.legsHash, f.chain.writeState.seals.get(first.h!)!.legsHash); assert.equal(record.blocked, false);
  assert.equal(Object.hasOwn(record, "requestId"), false); assert.equal(record.source.name, "holdout-mcp");
  const count = f.chain.writeState.raw.length, replay = await f.engine.decide(input());
  assert.equal(replay.replayed, true); assert.equal(replay.h, first.h); assert.equal(f.chain.writeState.raw.length, count);
  const conflict = await f.engine.decide({ ...input(), weights: { NVDA: "0.3" } });
  assert.equal(conflict.state, "refused"); assert.equal(conflict.error!.code, "request-id-conflict"); assert.equal(f.chain.writeState.raw.length, count);
});

test("M6 decisions allocate from each lane ledger with no factory-wide principal", async t => {
  for (const principal of [37500000n, 100000000n]) await t.test(principal.toString(), async child => {
    const f = await writeFixture(child); f.chain.state.principal = principal; f.chain.state.value = principal;
    f.chain.ledger[ADDRESSES.usdg] = principal;
    const result = await f.engine.decide(input());
    assert.equal(result.state, "executed", JSON.stringify(result)); assert.equal(result.legs.length, 1);
    assert.equal(result.legs[0].amountIn, (principal / 4n).toString());
    assert.equal(f.chain.writeState.sealEvents.filter(event => event.h === result.h).length, 1);
  });
});

test("M6 blocked lane and paused buys retain cash and seal without a trade", async t => {
  for (const blocked of [false, true]) await t.test(blocked ? "blocked registry" : "paused stock", async child => {
    const f = await writeFixture(child); f.chain.state.blocked = blocked;
    if (!blocked) f.chain.state.paused.add(f.chain.assets[0].token);
    const result = await f.engine.decide(input()); assert.equal(result.state, "held", JSON.stringify(result));
    assert.equal(result.legs.length, 0); assert.equal(result.dropped.length, blocked ? 0 : 1);
    const record = JSON.parse(await readFile(recordPath(f.home, FIXTURE.lane, result.h!), "utf8"));
    assert.equal(record.blocked, blocked); assert.equal(record.orders.legsHash, "0x" + "0".repeat(64));
    assert.equal(f.chain.writeState.simulations, 0);
  });
});

test("M6 seal has the exact empty orders envelope and retains all supplied text", async t => {
  const f = await writeFixture(t), { weights: _, ...value } = input();
  const result = await f.engine.seal(value); assert.equal(result.state, "held");
  const record = JSON.parse(await readFile(recordPath(f.home, FIXTURE.lane, result.h!), "utf8"));
  assert.equal(record.decision, null); assert.equal(record.orders.quoteBlock, null);
  assert.equal(record.orders.simulation.result, "unavailable"); assert.equal(record.input, value.input); assert.equal(record.output, value.output);
});

test("M6 simulation failure creates no journal item and no signature", async t => {
  const f = await writeFixture(t); f.chain.writeState.simulationError = true;
  const result = await f.engine.decide(input()); assert.equal(result.state, "refused"); assert.equal(result.error!.code, "simulation-reverted");
  assert.equal(result.error!.name, "MinOut"); assert.equal((await readJournal(f.home, FIXTURE.lane)).entries.length, 0);
  assert.equal(f.chain.writeState.prepares, 0); assert.equal(f.chain.writeState.raw.length, 0);
});

test("M6 prepare quote and estimate refusals close not-sent and allow the same request to retry", async t => {
  for (const quote of [false, true]) await t.test(quote ? "before-estimate quote" : "estimate revert", async child => {
    const f = await writeFixture(child); f.chain.writeState.estimateError = !quote; f.chain.writeState.beforeEstimateMove = quote;
    const result = await f.engine.decide(input()); assert.equal(result.state, "refused");
    assert.equal(result.error!.code, quote ? "quote-moved" : "estimate-reverted");
    const journal = await readJournal(f.home, FIXTURE.lane); assert.equal(journal.entries[0].stage, "not-sent"); assert.equal(journal.entries[0].signed, undefined);
    assert.equal(f.chain.writeState.raw.length, 0); assert.equal(f.chain.writeState.nonce, 0n);
    f.chain.writeState.estimateError = false; f.chain.writeState.beforeEstimateMove = false; f.chain.writeState.multiplier = 10000n;
    const retry = await f.engine.decide(input()); assert.equal(retry.state, "executed", JSON.stringify(retry));
    assert.equal((await readJournal(f.home, FIXTURE.lane)).entries.length, 2);
  });
});

test("M6 first-broadcast quote recheck closes a stored signature without using its nonce", async t => {
  const f = await writeFixture(t); f.chain.writeState.afterEstimateMove = true;
  const result = await f.engine.decide(input()); assert.equal(result.state, "refused"); assert.equal(result.error!.code, "quote-moved");
  const entry = (await readJournal(f.home, FIXTURE.lane)).entries[0]; assert.equal(entry.stage, "not-sent"); assert.ok(entry.signed);
  assert.equal(entry.broadcastAttemptedAt, undefined); assert.equal(f.chain.writeState.raw.length, 0); assert.equal(f.chain.writeState.nonce, 0n);
});

test("M6 status zero is failed without publishing and can be retried under the same request ID", async t => {
  const f = await writeFixture(t); f.chain.writeState.chainFailure = true;
  const result = await f.engine.decide(input()); assert.equal(result.state, "failed", JSON.stringify(result));
  assert.equal(result.error!.code, "chain-reverted"); assert.equal(f.posts.length, 0); assert.equal(f.chain.writeState.sealEvents.length, 0);
  assert.equal((await readJournal(f.home, FIXTURE.lane)).entries[0].stage, "failed");
  f.chain.writeState.chainFailure = false;
  const retry = await f.engine.decide(input()); assert.equal(retry.state, "executed"); assert.equal(f.chain.writeState.sealEvents.length, 1);
});

test("M9 an original mined during nonce checks consumes its own receipt instead of failing", async t => {
  const f = await writeFixture(t), broadcast = f.options.sender.broadcast.bind(f.options.sender);
  f.options.sender.broadcast = async signed => { await broadcast(signed); throw new NonceConflictError("nonce changed while reading"); };
  const result = await f.engine.decide(input()); assert.equal(result.state, "executed", JSON.stringify(result));
  assert.equal((await readJournal(f.home, FIXTURE.lane)).entries[0].stage, "verified"); assert.equal(f.chain.writeState.sealEvents.length, 1);
});

test("M9 a transient nonce-conflict recheck failure preserves sent and recovers later", async t => {
  const f = await writeFixture(t), broadcast = f.options.sender.broadcast.bind(f.options.sender), request = f.options.sender.request.bind(f.options.sender);
  f.options.sender.broadcast = async signed => { await broadcast(signed); throw new NonceConflictError("nonce changed while reading"); };
  f.options.sender.request = async (method, params) => { if (method === "eth_getTransactionCount") throw new Error("transient read failure"); return request(method, params); };
  const result = await f.engine.decide(input()); assert.equal(result.state, "pending"); assert.equal((await readJournal(f.home, FIXTURE.lane)).entries[0].stage, "sent");
  f.options.sender.request = request; await f.engine.start();
  await until(async () => (await readJournal(f.home, FIXTURE.lane)).entries[0].stage === "verified");
  assert.equal(f.chain.writeState.sealEvents.length, 1); assert.equal(f.chain.writeState.prepares, 1);
});

test("M11 no key, wrong key, missing data, closing and closed lanes refuse before signing", async t => {
  for (const choice of ["missing-key", "wrong-key", "missing-data", "closing", "closed"]) await t.test(choice, async child => {
    const f = await writeFixture(child);
    if (choice === "missing-key") f.options.key = null;
    if (choice === "wrong-key") f.options.key = { path: f.options.key!.path, address: "0x" + "9".repeat(40) };
    if (choice === "missing-data") f.options.config.dataBase = null;
    if (choice === "closing") f.chain.state.status = 2;
    if (choice === "closed") f.chain.state.status = 3;
    const result = await f.engine.decide(input()); assert.equal(result.state, "refused");
    assert.equal(result.error!.code, ({ "missing-key": "agent-key-missing", "wrong-key": "agent-key-mismatch", "missing-data": "data-base-missing", closing: "lane-not-open", closed: "lane-not-open" })[choice]);
    assert.equal(f.chain.writeState.prepares, 0); assert.equal(f.chain.writeState.raw.length, 0); assert.equal((await readJournal(f.home, FIXTURE.lane)).entries.length, 0);
  });
});

test("M11 insufficient gas discards the prepared signature without persistence or broadcast", async t => {
  const f = await writeFixture(t); f.chain.writeState.gasBalance = 0n;
  const result = await f.engine.decide(input()); assert.equal(result.state, "refused"); assert.equal(result.error!.code, "agent-gas");
  const entry = (await readJournal(f.home, FIXTURE.lane)).entries[0]; assert.equal(entry.stage, "not-sent"); assert.equal(entry.signed, undefined);
  assert.equal(f.chain.writeState.estimates, 1); assert.equal(f.chain.writeState.raw.length, 0);
});

test("M7 oversized or invalid Unicode text is rejected before any durable decision or signature", async t => {
  for (const [output, code] of [["x".repeat(262144), "record-too-large"], ["\ud800", "invalid-text"]]) await t.test(code, async child => {
    const f = await writeFixture(child); const result = await f.engine.decide({ ...input(), output });
    assert.equal(result.state, "refused"); assert.equal(result.error!.code, code);
    assert.equal((await readJournal(f.home, FIXTURE.lane)).entries.length, 0); assert.equal(f.chain.writeState.prepares, 0);
  });
});

test("M12 registered key text is removed from records, journals, and results", async t => {
  const f = await writeFixture(t), value = { ...input(), model: f.key, input: f.key, output: f.key.slice(2) };
  const result = await f.engine.decide(value); assert.equal(result.state, "executed");
  const journal = await readFile(f.home + "/lanes/" + FIXTURE.lane + "/journal.json", "utf8");
  const record = await readFile(recordPath(f.home, FIXTURE.lane, result.h!), "utf8");
  for (const visible of [journal, record, JSON.stringify(result)]) { assert.equal(visible.includes(f.key), false); assert.equal(visible.includes(f.key.slice(2)), false); }
  assert.ok(record.includes("[secret]"));
});

test("M12 transport error logs redact registered keys and home paths", async t => {
  const f = await writeFixture(t), logs: string[] = []; f.options.logger = message => logs.push(message);
  f.options.sender.broadcast = async () => { throw new Error(f.key + " " + homedir() + "/private-file"); };
  const result = await f.engine.decide(input()); assert.equal(result.state, "pending"); assert.equal(logs.length, 1);
  for (const visible of [...logs, JSON.stringify(result), JSON.stringify(await readJournal(f.home, FIXTURE.lane))]) {
    assert.equal(visible.includes(f.key), false); assert.equal(visible.includes(homedir()), false);
  }
});

test("M14 two concurrent calls cannot produce two chain effects", async t => {
  const f = await writeFixture(t), second = new DecisionEngine(f.options); t.after(() => second.stop());
  const results = await Promise.all([f.engine.decide(input()), second.decide(input())]);
  assert.deepEqual(results.map(r => r.state).sort(), ["busy", "executed"]);
  assert.equal(f.chain.writeState.sealEvents.length, 1); assert.equal(f.chain.writeState.nonce, 1n);
});

const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(read: () => Promise<boolean>, timeout = 5000) {
  const start = Date.now(); while (!await read()) { if (Date.now() - start > timeout) throw new Error("condition timeout"); await pause(20); }
}
test("M14 a delayed prior receipt returns replayed pending, conflicts, or busy without new signing", async t => {
  for (const choice of ["same", "different-digest", "different-id"]) await t.test(choice, async child => {
    const f = await writeFixture(child, { responseMs: 300 }); f.chain.writeState.automine = false;
    const pending = await f.engine.decide(input()); assert.equal(pending.state, "pending", JSON.stringify(pending));
    f.chain.writeState.receiptError = true;
    await until(async () => { try { await withAgentLock(f.home, f.options.identity.agent, async () => {}); return true; } catch (error) { if (error instanceof AgentBusy) return false; throw error; } });
    f.chain.writeState.receiptError = false;
    const engine = new DecisionEngine({ ...f.options, responseMs: 100 }); child.after(() => engine.stop());
    const next = choice === "different-id" ? input("other-id") : choice === "different-digest" ? { ...input(), weights: { NVDA: "0.3" } } : input();
    const count = f.chain.writeState.prepares, replay = await engine.decide(next);
    if (choice === "same") { assert.equal(replay.state, "pending"); assert.equal(replay.replayed, true); assert.equal(replay.h, pending.h); }
    else if (choice === "different-digest") { assert.equal(replay.state, "refused"); assert.equal(replay.error!.code, "request-id-conflict"); }
    else assert.equal(replay.state, "busy");
    assert.equal(f.chain.writeState.prepares, count); f.chain.mine();
    await until(async () => (await readJournal(f.home, FIXTURE.lane)).entries[0].stage === "verified");
    assert.equal(f.chain.writeState.sealEvents.length, 1);
  });
});

test("M9 thirty-second pump recovers receipt RPC failure without restart or another write", async t => {
  const f = await writeFixture(t, { responseMs: 300 }); f.chain.writeState.automine = false;
  await f.engine.start();
  await pause(50);
  const pending = await f.engine.decide(input()); assert.equal(pending.state, "pending", JSON.stringify(pending));
  f.chain.writeState.receiptError = true;
  await pause(1200); f.chain.mine(); f.chain.writeState.receiptError = false;
  await until(async () => (await readJournal(f.home, FIXTURE.lane)).entries[0].stage === "verified", 32000);
  assert.equal(f.chain.writeState.sealEvents.length, 1); assert.equal(f.chain.writeState.prepares, 1);
});

test("M6 deadline before broadcast prevents any later unattempted transaction", async t => {
  const f = await writeFixture(t, { responseMs: 500 }); let calls = 0;
  f.options.read = { quotes: async () => { if (++calls > 1) await pause(1000); return null; } };
  const result = await f.engine.decide(input()); assert.equal(result.state, "refused"); assert.equal(result.error!.code, "rpc-unavailable");
  await pause(1100);
  const journal = await readJournal(f.home, FIXTURE.lane); assert.equal(journal.entries[0].stage, "not-sent");
  assert.equal(journal.entries[0].broadcastAttemptedAt, undefined); assert.equal(f.chain.writeState.raw.length, 0);
});

test("M6 temporary preparation errors use bounded exponential delays before succeeding", async t => {
  let clock = Date.now(); const delays: number[] = [];
  const f = await writeFixture(t, { now: () => clock, sleep: async milliseconds => { delays.push(milliseconds); clock += milliseconds; } });
  const prepare = f.options.sender.prepare.bind(f.options.sender); let calls = 0;
  f.options.sender.prepare = async intent => ++calls <= 2 ? { reverted: false, temporary: true, error: "temporary" } : prepare(intent);
  const result = await f.engine.decide(input()); assert.equal(result.state, "executed"); assert.deepEqual(delays, [2000, 4000]);
  assert.equal(f.chain.writeState.sealEvents.length, 1);
});

test("M6 a successful first preparation after thirty seconds remains inside the whole-call deadline", async t => {
  let clock = Date.now(), first = true;
  const f = await writeFixture(t, { now: () => clock });
  const { readHeader } = await import("@holdout/core");
  f.options.read = { header: async (rpc, block) => {
    if (first) { first = false; clock += 32000; }
    return readHeader(rpc, block);
  } };
  const result = await f.engine.decide(input()); assert.equal(result.state, "executed", JSON.stringify(result));
  assert.equal(f.chain.writeState.prepares, 1);
});

test("M6 deadline returns a known receipt outcome while publication or error replay continues", async t => {
  for (const failed of [false, true]) await t.test(failed ? "failed receipt" : "successful receipt", async child => {
    const f = await writeFixture(child, { responseMs: 1000 });
    if (failed) {
      f.chain.writeState.chainFailure = true;
      const request = f.options.rpc.request.bind(f.options.rpc);
      f.options.rpc.request = async <T>(method: string, params: unknown[]): Promise<T> => {
        if (method === "eth_call" && f.chain.writeState.receipts.size && (params[0] as { to: string }).to === FIXTURE.lane) await pause(1500);
        return request<T>(method, params);
      };
    } else {
      const fetcher = f.options.fetch!;
      f.options.fetch = async (url, options) => { if (options?.method === "POST") await pause(1500); return fetcher(url, options); };
    }
    const result = await f.engine.decide(input()); assert.equal(result.state, failed ? "failed" : "executed");
    if (failed) assert.equal(result.error!.code, "chain-reverted");
    await until(async () => (await readJournal(f.home, FIXTURE.lane)).entries[0].stage === (failed ? "failed" : "verified"));
  });
});
