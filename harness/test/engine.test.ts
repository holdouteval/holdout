import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { atomicJson, listJournals, sessionPath } from "../src/journal.js";
import { HarnessEngine } from "../src/engine.js";
import { runModelAttempt } from "../src/models.js";
import { readProviderKeys } from "../src/secrets.js";
import { ADDRESSES } from "@holdout/core";
import { buildOrders, MAX } from "../src/orders.js";
import { anthropicFrames } from "./model-support.js";
import { DATE, TIME, LANE, engine, environment, hooks, launch, loadRecord } from "./engine-support.js";

for (const point of ["after-record", "after-sign", "after-broadcast"]) {
  test(`actual SIGKILL at ${point} resumes immutable records and applies each chain effect once`, { timeout: 15000 }, async t => {
    const env = await environment(t);
    const first = launch(env.configPath, "run", { fault: `${point}:${LANE}` });
    t.after(() => first.child.kill("SIGKILL"));
    assert.equal((await first.result).signal, "SIGKILL");
    const [before] = await listJournals(env.config.dataDir);
    assert.ok(before.record);
    const bytes = await readFile(before.record.path), calls = env.state.modelCalls;
    const signed = before.transactions[0]?.signed;
    if (point === "after-record") assert.deepEqual(env.canonicalEffects(), { seals: 0, trades: 0 });
    if (point === "after-sign") { assert.ok(signed); assert.equal(env.state.broadcasts.length, 0); }
    if (point === "after-broadcast") { assert.ok(signed); assert.deepEqual(env.canonicalEffects(), { seals: 1, trades: 1 }); }
    const resumed = launch(env.configPath, "resume"); t.after(() => resumed.child.kill("SIGKILL"));
    const result = await resumed.result;
    assert.equal(result.code, 0, result.stderr);
    const [after] = await listJournals(env.config.dataDir);
    assert.equal(after.final, true);
    assert.equal(after.record!.h, before.record.h);
    assert.deepEqual(await readFile(after.record!.path), bytes);
    assert.equal(env.state.modelCalls, calls);
    assert.equal(env.state.ordersCalls, 1);
    assert.deepEqual(env.canonicalEffects(), { seals: 1, trades: 1 });
    assert.ok(env.state.posts.every(post => post.hadReceipt));
    if (signed) assert.ok(env.state.broadcasts.every(raw => raw === signed.rawTransaction));
    assert.equal(after.transactions.length, 1);
    assert.ok(after.transactions[0].receipt);
  });
}

for (const point of ["after-sign", "after-broadcast"]) {
  test(`an authorized review trade resumes after actual SIGKILL at ${point}`, { timeout: 15000 }, async t => {
    const env = await environment(t, { review: true }), runtime = engine(env.config); t.after(() => runtime.close());
    const pending = await runtime.runLane(env.config.lanes[0], { date: DATE, key: DATE, time: TIME, block: 101 });
    const first = launch(env.configPath, "send", { fault: `${point}:${LANE}`, h: pending.record!.h });
    t.after(() => first.child.kill("SIGKILL")); assert.equal((await first.result).signal, "SIGKILL");
    const [before] = await listJournals(env.config.dataDir), raw = before.transactions.find(tx => tx.kind === "trade")!.signed.rawTransaction;
    const resumed = launch(env.configPath, "resume"); t.after(() => resumed.child.kill("SIGKILL"));
    const result = await resumed.result; assert.equal(result.code, 0, result.stderr);
    const [after] = await listJournals(env.config.dataDir);
    assert.equal(after.final, true); assert.equal(after.review!.state, "sent"); assert.equal(after.record!.h, pending.record!.h);
    assert.equal(after.transactions.find(tx => tx.kind === "trade")!.signed.rawTransaction, raw);
    assert.equal(env.state.modelCalls, 1); assert.deepEqual(env.canonicalEffects(), { seals: 1, trades: 1 });
    assert.equal(after.transactions.length, 2); assert.ok(after.transactions.every(tx => tx.receipt));
  });
}

test("a signed automatic trade never accepted before its deadline becomes a late failure on recovery", { timeout: 15000 }, async t => {
  const env = await environment(t), first = launch(env.configPath, "run", { fault: `after-sign:${LANE}` });
  t.after(() => first.child.kill("SIGKILL")); assert.equal((await first.result).signal, "SIGKILL");
  const [before] = await listJournals(env.config.dataDir); env.state.now = TIME + 1801;
  const resumed = launch(env.configPath, "resume"); t.after(() => resumed.child.kill("SIGKILL"));
  const result = await resumed.result; assert.equal(result.code, 0, result.stderr);
  const [after] = await listJournals(env.config.dataDir);
  assert.equal(after.record!.h, before.record!.h); assert.equal(after.execution!.stage, "late"); assert.equal(after.execution!.error.name, "HarnessLate");
  assert.equal(after.transactions[0].abandoned, true); assert.equal(after.final, true);
  assert.deepEqual(env.canonicalEffects(), { seals: 1, trades: 0 }); assert.equal(env.state.modelCalls, 1);
});

test("a persisted status-zero receipt reconstructs its execution failure after a crash before that marker", async t => {
  const env = await environment(t), runtime = engine(env.config); t.after(() => runtime.close()); env.state.tradeRevert = true;
  const journal = await runtime.runLane(env.config.lanes[0], { date: DATE, key: DATE, time: TIME, block: 101 });
  const seal = journal.transactions.find(tx => tx.kind === "seal")!;
  delete env.state.transactions[seal.signed.hash]; delete env.state.seals[journal.record!.h]; env.state.events.length = 0;
  journal.transactions = journal.transactions.filter(tx => tx.kind === "trade"); delete journal.execution; journal.final = false;
  journal.recordPublication = {}; journal.executionPublication = {}; journal.stage = "receipt:trade";
  await atomicJson(sessionPath(env.config.dataDir, journal.key, journal.lane), journal);
  const [recovered] = await runtime.resume();
  assert.equal(recovered.execution!.stage, "chain"); assert.equal(recovered.execution!.error.name, "NotAuthorized");
  assert.equal(recovered.final, true); assert.equal(env.state.modelCalls, 1); assert.equal(env.state.ordersCalls, 1);
  assert.deepEqual(env.canonicalEffects(), { seals: 1, trades: 0 });
});

test("process death while receiving attempt two preserves prior failure and raw text/tail within the three-body budget", { timeout: 15000 }, async t => {
  const env = await environment(t, { review: true, legs: false });
  env.state.scenario = "partial"; env.config.test.partialKill = true; await atomicJson(env.configPath, env.config);
  const first = launch(env.configPath); t.after(() => first.child.kill("SIGKILL"));
  assert.equal((await first.result).signal, "SIGKILL");
  const [interrupted] = await listJournals(env.config.dataDir);
  assert.equal(interrupted.attempts.length, 2);
  assert.equal(interrupted.attempts[0].result!.error, "parse-failed");
  assert.equal(interrupted.attempts[1].finished, undefined);
  const raw = await readFile(interrupted.attempts[1].raw);
  assert.ok(raw.includes(Buffer.from("partial-suffix")));
  const resumed = launch(env.configPath, "resume"); t.after(() => resumed.child.kill("SIGKILL"));
  const result = await resumed.result; assert.equal(result.code, 0, result.stderr);
  const [journal] = await listJournals(env.config.dataDir), record = await loadRecord(journal);
  assert.equal(journal.final, true);
  assert.equal(env.state.modelCalls, 3);
  assert.equal(record.response!.used, 3);
  assert.equal(record.response!.attempts.length, 3);
  assert.equal(record.response!.attempts[0].text, "first parse failure");
  assert.equal(record.response!.attempts[0].error, "parse-failed");
  const second = record.response!.attempts[1];
  assert.equal(second.error, "interrupted"); assert.equal(second.completed, false);
  assert.equal(second.text, "second-onesecond-two");
  assert.equal(second.bytesRead, raw.length);
  assert.equal(Buffer.from(second.tail, "base64").toString(), 'data: {"type":"response.output_text.delta","delta":"partial-suffix');
  assert.deepEqual(await readFile(interrupted.attempts[1].raw), raw);
  assert.ok(record.response!.attempts.every(attempt => attempt.bytesRead > 0));
  assert.deepEqual(env.canonicalEffects(), { seals: 1, trades: 0 });
});

test("receipt loss in a reorg replays identical signed bytes without another model decision or order build", { timeout: 15000 }, async t => {
  const env = await environment(t); env.state.finalized = 0;
  const first = launch(env.configPath); t.after(() => first.child.kill("SIGKILL"));
  const initialExit = await first.result; assert.equal(initialExit.code, 0, initialExit.stderr);
  const [before] = await listJournals(env.config.dataDir);
  assert.equal(before.final, false); assert.ok(before.transactions[0].receipt);
  const original = before.transactions[0].signed.rawTransaction, oldBlockHash = before.transactions[0].receipt!.blockHash;
  const recordBytes = await readFile(before.record!.path);
  env.reorg(); env.state.finalized = 1000;
  const resumed = launch(env.configPath, "resume"); t.after(() => resumed.child.kill("SIGKILL"));
  const exit = await resumed.result; assert.equal(exit.code, 0, exit.stderr);
  const [after] = await listJournals(env.config.dataDir);
  assert.equal(after.final, true);
  assert.notEqual(after.transactions[0].receipt!.blockHash, oldBlockHash);
  assert.equal(after.record!.h, before.record!.h);
  assert.deepEqual(await readFile(after.record!.path), recordBytes);
  assert.equal(env.state.modelCalls, 1); assert.equal(env.state.ordersCalls, 1);
  assert.deepEqual(env.state.broadcasts, [original, original]);
  assert.deepEqual(env.canonicalEffects(), { seals: 1, trades: 1 });
});

test("oversized input seals a small failure record without calling a provider", async t => {
  const env = await environment(t, { hugeInput: true }), runtime = engine(env.config); t.after(() => runtime.close());
  const journal = await runtime.runLane(env.config.lanes[0], { date: DATE, key: DATE, time: TIME, block: 101 });
  const record = await loadRecord(journal);
  assert.equal(env.state.modelCalls, 0); assert.equal(env.state.ordersCalls, 0);
  assert.equal(record.error, "input-too-large");
  assert.equal(record.snapshot, null); assert.equal(record.request, null); assert.equal(record.response, null); assert.equal(record.decision, null);
  assert.equal(record.orders.legs.length, 0);
  assert.ok((await readFile(journal.record!.path)).length < 16384);
  assert.equal(journal.final, true);
  assert.deepEqual(env.canonicalEffects(), { seals: 1, trades: 0 });
});

test("an unknown indexed seal today blocks a fresh decision before any provider call", async t => {
  const env = await environment(t), runtime = engine(env.config); t.after(() => runtime.close());
  env.state.indexed.push({ h: "0x" + "3".repeat(64), time: TIME + 1 });
  await assert.rejects(runtime.runLane(env.config.lanes[0], { date: DATE, key: DATE, time: TIME, block: 101 }), /session-already-sealed/);
  assert.equal(env.state.modelCalls, 0);
  assert.deepEqual(env.canonicalEffects(), { seals: 0, trades: 0 });
  const [journal] = await listJournals(env.config.dataDir); assert.ok(journal.errors.includes("session-already-sealed"));
});

test("a prior missed-session hash sealed today remains known and does not block today's decision", async t => {
  const env = await environment(t, { legs: false }), runtime = engine(env.config); t.after(() => runtime.close());
  const prior = await runtime.runLane(env.config.lanes[0], { date: "2026-11-13", key: "2026-11-13", time: TIME - 3 * 86400, missed: true });
  assert.equal(env.state.modelCalls, 0); assert.ok(prior.record);
  assert.ok(env.state.seals[prior.record.h].at >= TIME);
  const today = await runtime.runLane(env.config.lanes[0], { date: DATE, key: DATE, time: TIME, block: 101 });
  assert.equal(env.state.modelCalls, 1);
  assert.equal(today.final, true);
  assert.notEqual(today.record!.h, prior.record.h);
  assert.deepEqual(env.canonicalEffects(), { seals: 2, trades: 0 });
});

test("review listing sends the exact sealed legs after an unchanged execution quote", async t => {
  const env = await environment(t, { review: true }), runtime = engine(env.config); t.after(() => runtime.close());
  const pending = await runtime.runLane(env.config.lanes[0], { date: DATE, key: DATE, time: TIME, block: 101 });
  assert.equal(pending.review!.state, "pending"); assert.equal(env.state.posts.length, 0);
  assert.deepEqual(env.canonicalEffects(), { seals: 1, trades: 0 });
  const recordBytes = await readFile(pending.record!.path), list = await runtime.reviews() as any[];
  assert.equal(list.length, 1); assert.equal(list[0].h, pending.record!.h); assert.equal(list[0].remainingSeconds, 1800);
  assert.deepEqual(list[0].weights, { AAA: "0.5" }); assert.equal(list[0].reason, "fixed decision");
  const sent = await runtime.review(pending.record!.h, "send");
  assert.equal(sent.review!.state, "sent"); assert.equal(sent.final, true);
  assert.deepEqual(env.canonicalEffects(), { seals: 1, trades: 1 });
  assert.deepEqual(await readFile(sent.record!.path), recordBytes);
  assert.equal(env.state.modelCalls, 1);
  await assert.rejects(runtime.review(pending.record!.h, "send"), /not pending/);
});

test("review skip publishes without a trade and the expiry daemon path marks auto-skipped", async t => {
  for (const action of ["skip", "expire"] as const) {
    const env = await environment(t, { review: true }), runtime = engine(env.config); t.after(() => runtime.close());
    const pending = await runtime.runLane(env.config.lanes[0], { date: DATE, key: DATE, time: TIME, block: 101 });
    let finished;
    if (action === "skip") finished = await runtime.review(pending.record!.h, "skip");
    else { env.state.now += 1801; [finished] = await runtime.resume(); }
    assert.equal(finished.review!.state, action === "skip" ? "skipped" : "auto-skipped");
    assert.equal(finished.final, true); assert.deepEqual(env.canonicalEffects(), { seals: 1, trades: 0 });
    assert.equal(env.state.posts.filter(post => post.kind === "r").length, 1);
  }
});

test("review rejects the final sixty seconds and follows chain truth over a skipped journal", async t => {
  const env = await environment(t, { review: true }), runtime = engine(env.config); t.after(() => runtime.close());
  env.state.finalized = 0;
  const pending = await runtime.runLane(env.config.lanes[0], { date: DATE, key: DATE, time: TIME, block: 101 });
  env.state.now += 1740;
  await assert.rejects(runtime.review(pending.record!.h, "send"), /less than sixty/);
  env.state.now -= 1740;
  const skipped = await runtime.review(pending.record!.h, "skip"); assert.equal(skipped.review!.state, "skipped"); assert.equal(skipped.final, false);
  env.state.seals[pending.record!.h].acted = true;
  const [truth] = await runtime.resume();
  assert.equal(truth.review!.state, "sent"); assert.equal(truth.review!.chainOverride, true);
  assert.ok(truth.errors.includes("chain-overrides-review"));
  assert.equal(env.state.modelCalls, 1);
});

test("review send refuses already acted chain state and records the override", async t => {
  const env = await environment(t, { review: true }), runtime = engine(env.config); t.after(() => runtime.close());
  const pending = await runtime.runLane(env.config.lanes[0], { date: DATE, key: DATE, time: TIME, block: 101 });
  env.state.seals[pending.record!.h].acted = true;
  await assert.rejects(runtime.review(pending.record!.h, "send"), /already acted on chain/);
  const [journal] = await listJournals(env.config.dataDir);
  assert.equal(journal.review!.state, "sent"); assert.equal(journal.review!.chainOverride, true);
  assert.ok(journal.errors.includes("chain-overrides-review"));
  assert.equal(env.state.broadcasts.length, 1);
});

test("review quote improvement and known estimation revert publish exact execution failures without signing trades", async t => {
  for (const failure of ["quote", "estimate"] as const) {
    const env = await environment(t, { review: true }), runtime = engine(env.config); t.after(() => runtime.close());
    const pending = await runtime.runLane(env.config.lanes[0], { date: DATE, key: DATE, time: TIME, block: 101 });
    if (failure === "quote") env.state.quoteOut = "1100000"; else env.state.estimateError = true;
    const finished = await runtime.review(pending.record!.h, "send");
    assert.equal(finished.execution!.stage, failure);
    assert.equal(finished.execution!.error.name, failure === "quote" ? "QuoteMoved" : "NotAuthorized");
    assert.equal(finished.transactions.filter(tx => tx.kind === "trade").length, 0);
    assert.equal(finished.final, true);
    assert.deepEqual(env.canonicalEffects(), { seals: 1, trades: 0 });
    assert.equal(env.state.executions.size, 1);
    const published = JSON.parse(env.state.executions.get(pending.record!.h)!.toString());
    assert.equal(published.stage, failure); assert.equal(published.h, pending.record!.h);
    if (failure === "quote") assert.equal(env.state.estimates.filter(kind => kind === "trade").length, 0);
  }
});

test("automatic retry rechecks the sealed quote before attempting another signature", async t => {
  const env = await environment(t); env.state.estimateTemporary = 1;
  const runtime = new HarnessEngine(env.config, { ...hooks(env.config), sleep: async () => { env.state.quoteOut = "1100000"; } });
  t.after(() => runtime.close());
  const result = await runtime.runLane(env.config.lanes[0], { date: DATE, key: DATE, time: TIME, block: 101 });
  assert.equal(result.execution!.stage, "quote"); assert.equal(result.execution!.error.name, "QuoteMoved");
  assert.equal(result.transactions.filter(tx => tx.kind === "trade").length, 0);
  assert.equal(env.state.estimates.filter(kind => kind === "trade").length, 1);
  assert.deepEqual(env.canonicalEffects(), { seals: 1, trades: 0 });
  assert.equal(result.final, true);
});

test("a reorg with an improved quote abandons the original trade and seals its original commitment", async t => {
  const env = await environment(t), runtime = engine(env.config); t.after(() => runtime.close());
  env.state.finalized = 0;
  const before = await runtime.runLane(env.config.lanes[0], { date: DATE, key: DATE, time: TIME, block: 101 });
  const bytes = await readFile(before.record!.path), raw = before.transactions[0].signed.rawTransaction;
  env.reorg(); env.state.quoteOut = "1100000"; env.state.finalized = 1000;
  const [after] = await runtime.resume();
  assert.equal(after.execution!.stage, "quote"); assert.equal(after.execution!.error.name, "QuoteMoved");
  assert.equal(after.transactions[0].abandoned, true);
  assert.equal(env.state.broadcasts.filter(value => value === raw).length, 1);
  assert.equal(after.record!.h, before.record!.h); assert.deepEqual(await readFile(after.record!.path), bytes);
  assert.equal(env.state.seals[after.record!.h].legsHash, (await loadRecord(after)).orders.legsHash);
  assert.equal(env.state.modelCalls, 1); assert.equal(env.state.ordersCalls, 1);
  assert.deepEqual(env.canonicalEffects(), { seals: 1, trades: 0 });
  assert.equal(after.final, true);
});

test("a failed trade receipt publishes its chain error and seals without re-quoting new orders", async t => {
  const env = await environment(t), runtime = engine(env.config); t.after(() => runtime.close()); env.state.tradeRevert = true;
  const journal = await runtime.runLane(env.config.lanes[0], { date: DATE, key: DATE, time: TIME, block: 101 });
  assert.equal(journal.execution!.stage, "chain"); assert.equal(journal.execution!.error.name, "NotAuthorized");
  assert.equal(journal.execution!.tx, journal.transactions.find(tx => tx.kind === "trade")!.signed.hash);
  assert.equal(journal.transactions.find(tx => tx.kind === "trade")!.receipt!.status, 0);
  assert.equal(journal.transactions.find(tx => tx.kind === "seal")!.receipt!.status, 1);
  assert.equal(env.state.modelCalls, 1); assert.equal(env.state.ordersCalls, 1);
  assert.deepEqual(env.canonicalEffects(), { seals: 1, trades: 0 }); assert.equal(journal.final, true);
});

test("manual skip survives delayed publication and later expiry while chain execution still takes precedence", async t => {
  const env = await environment(t, { review: true }), runtime = engine(env.config); t.after(() => runtime.close());
  env.state.publicationStatus = 202;
  const pending = await runtime.runLane(env.config.lanes[0], { date: DATE, key: DATE, time: TIME, block: 101 });
  const skipped = await runtime.review(pending.record!.h, "skip");
  assert.equal(skipped.review!.state, "skipped"); assert.equal(skipped.final, false);
  assert.equal(skipped.recordPublication.status, 202);
  assert.equal(skipped.recordPublication.verifiedAt, undefined);
  env.state.now += 1801;
  const [afterWindow] = await runtime.resume();
  assert.equal(afterWindow.review!.state, "skipped"); assert.equal(afterWindow.final, false);
  assert.deepEqual(env.canonicalEffects(), { seals: 1, trades: 0 });
  env.state.seals[pending.record!.h].acted = true;
  const [chainTruth] = await runtime.resume();
  assert.equal(chainTruth.review!.state, "sent"); assert.equal(chainTruth.review!.chainOverride, true);
  assert.ok(chainTruth.errors.includes("chain-overrides-review"));
  assert.equal(env.state.modelCalls, 1);
});

test("runtime redacts API echoes and key-bearing diagnostics from journals, raw responses, records and log files", async t => {
  const env = await environment(t), dataDir = await mkdtemp(join(process.cwd(), ".engine-privacy-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  env.config.dataDir = dataDir;
  const anthropic = "runtime-anthropic-key-sentinel", openai = "runtime-openai-key-sentinel";
  const keys = readProviderKeys({ envFile: join(env.root, "absent-env"), env: { ANTHROPIC_API_KEY: anthropic, OPENAI_API_KEY: openai } });
  const keyFile = await readFile(env.config.lanes[0].keyFile, "utf8"), fallback = "https://fallback.invalid.example/private?token=runtime-sentinel";
  const homePath = join(homedir(), "private-runtime", "failure"), diagnostic = `${anthropic} ${openai} ${keyFile} ${fallback} ${homePath}`;
  env.state.reason = `echo ${anthropic} and ${openai}`; env.state.splitMarker = anthropic;
  env.state.estimateTemporary = 1; env.state.estimateDiagnostic = diagnostic;
  let publicationFailed = false;
  const logs: string[] = [], base = hooks(env.config);
  const runtime = new HarnessEngine(env.config, { ...base, now: () => env.state.now, logger: message => logs.push(message),
    model: options => runModelAttempt({ ...options, apiKey: keys.anthropic!, baseURL: env.baseURL + "/provider" }),
    fetch: async (input, init) => {
      if (!publicationFailed && String(input) === env.config.adminBase + "/r" && init?.method === "POST") { publicationFailed = true; throw new Error(diagnostic); }
      return fetch(input, init);
    },
  });
  t.after(() => runtime.close());
  const interrupted = await runtime.runLane(env.config.lanes[0], { date: DATE, key: DATE, time: TIME, block: 101 });
  assert.equal(interrupted.final, false); assert.ok(publicationFailed);
  assert.ok(interrupted.errors.length >= 2);
  assert.ok(interrupted.errors.every(message => message.includes("[secret]") && message.includes("[endpoint]") && message.includes("[path]")));
  env.state.now += 31;
  const [finished] = await runtime.resume(); assert.equal(finished.final, true);
  const record = await loadRecord(finished);
  assert.equal(record.decision!.reason, "echo [secret] and [secret]");
  assert.equal(env.state.modelCalls, 1);
  const serialized = JSON.parse(await readFile(sessionPath(dataDir, DATE, LANE), "utf8"));
  assert.equal(isAbsolute(serialized.record.path), false);
  assert.ok(serialized.attempts.every((attempt: { raw: string }) => !isAbsolute(attempt.raw)));
  assert.equal(isAbsolute(finished.record!.path), true);
  await mkdir(join(dataDir, "out_logs")); await writeFile(join(dataDir, "out_logs", "runtime.log"), logs.join("\n"));
  const files = async (directory: string): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true }), paths: string[] = [];
    for (const entry of entries) paths.push(...entry.isDirectory() ? await files(join(directory, entry.name)) : [join(directory, entry.name)]);
    return paths;
  };
  const persisted = await files(dataDir);
  assert.ok(persisted.some(path => path.endsWith(".raw"))); assert.ok(persisted.some(path => path.includes("records"))); assert.ok(persisted.some(path => path.endsWith("runtime.log")));
  for (const path of persisted) {
    const bytes = await readFile(path);
    for (const value of [anthropic, openai, keyFile, keyFile.replace(/^0x/, ""), fallback, homePath, homedir(), dataDir]) {
      assert.equal(bytes.includes(Buffer.from(value)), false, "private fixture material must not be persisted");
    }
  }
});

test("virtual paper sessions buy, carry holdings, sell MAX and recover applied fills without changing earlier results", async t => {
  const env = await environment(t), config = env.config, base = hooks(config);
  config.mode = "paper"; config.factory = null; config.lanes[0].keyFile = join(env.root, "absent-signer");
  const carried: Record<string, string>[] = [], senderCalls: string[] = [];
  let modelCalls = 0, orderCalls = 0;
  const runtime = new HarnessEngine(config, { ...base,
    sender: new Proxy(base.sender!, { get(_target, property) { senderCalls.push(String(property)); throw new Error("paper mode attempted to use a signer"); } }),
    snapshot: async options => {
      const result = await base.snapshot!(options);
      result.snapshot.block = options.block; result.snapshot.time = env.state.now - 10;
      result.snapshot.ledger = { ...options.ledger! }; result.snapshot.history = options.history ?? [];
      result.openedTime = options.openedTime ?? TIME;
      let value = BigInt(result.snapshot.ledger[ADDRESSES.usdg] ?? "0");
      for (const asset of result.snapshot.assets) value += BigInt(result.snapshot.ledger[asset.token] ?? "0") * BigInt(asset.answer) / 10n ** 20n;
      result.snapshot.value = value.toString(); carried.push({ ...result.snapshot.ledger }); return result;
    },
    orders: async options => {
      orderCalls++;
      return buildOrders({ ...options, quote: async (_rpc, key, zeroForOne, amount) => {
        const buy = (key.currency0 === ADDRESSES.usdg) === zeroForOne, answer = BigInt(options.snapshot.assets[0].answer);
        return buy ? amount * 10n ** 20n / answer : amount * answer / 10n ** 20n;
      } });
    },
    model: options => runModelAttempt({ ...options, apiKey: "paper-workflow-test-key", fetch: async () => {
      modelCalls++;
      const text = JSON.stringify({ weights: { AAA: modelCalls === 1 ? "0.5" : "0" }, reason: modelCalls === 1 ? "buy half" : "sell all" });
      return new Response(anthropicFrames([text], { model: options.model }).join(""), { headers: { "content-type": "text/event-stream" } });
    } }),
  });
  t.after(() => runtime.close());
  const first = await runtime.runLane(config.lanes[0], { date: DATE, key: DATE, time: TIME, block: 101 });
  const token = first.snapshot!.listing.assets[0].token, quantity = "5000000000000000000";
  const firstPath = join(config.dataDir, "paper", DATE, LANE + ".json"), firstPaper = JSON.parse(await readFile(firstPath, "utf8"));
  assert.equal(first.final, true); assert.equal(firstPaper.fills.length, 1);
  assert.equal(firstPaper.fills[0].label, "paper fill"); assert.equal(firstPaper.fills[0].buy, true);
  assert.equal(firstPaper.fills[0].amountIn, "500000000"); assert.equal(firstPaper.fills[0].quoteOut, quantity);
  assert.deepEqual(firstPaper.ledgerAfter, { [ADDRESSES.usdg]: "500000000", [token]: quantity });
  const firstJournalPath = sessionPath(config.dataDir, DATE, LANE), interrupted = JSON.parse(await readFile(firstJournalPath, "utf8"));
  interrupted.final = false; interrupted.stage = "record"; await atomicJson(firstJournalPath, interrupted);
  const nextDate = "2026-11-17"; env.state.now += 86400;
  const second = await runtime.runLane(config.lanes[0], { date: nextDate, key: nextDate, time: TIME + 86400, block: 102 });
  const secondPaper = JSON.parse(await readFile(join(config.dataDir, "paper", nextDate, LANE + ".json"), "utf8"));
  assert.deepEqual(carried[1], firstPaper.ledgerAfter);
  assert.equal((await loadRecord(second)).orders.legs[0].amountIn, MAX.toString());
  assert.equal(secondPaper.fills.length, 1); assert.equal(secondPaper.fills[0].label, "paper fill");
  assert.equal(secondPaper.fills[0].buy, false); assert.equal(secondPaper.fills[0].amountIn, quantity);
  assert.deepEqual(secondPaper.ledgerAfter, { [ADDRESSES.usdg]: "1000000000", [token]: "0" });
  const ledgerPath = join(config.dataDir, "paper", "ledger", config.lanes[0].model + ".json"), ledgerBefore = await readFile(ledgerPath);
  assert.equal(JSON.parse(ledgerBefore.toString()).applied.length, 2);
  const [recovered] = await runtime.resume(); assert.equal(recovered.final, true);
  assert.deepEqual(await readFile(ledgerPath), ledgerBefore);
  assert.equal(modelCalls, 2); assert.equal(orderCalls, 2);
  assert.deepEqual(senderCalls, []); assert.deepEqual(env.state.broadcasts, []); assert.deepEqual(env.state.estimates, []); assert.deepEqual(env.state.posts, []);
  const recoveredPaper = JSON.parse(await readFile(firstPath, "utf8"));
  assert.deepEqual({ fills: recoveredPaper.fills, ledgerAfter: recoveredPaper.ledgerAfter },
    { fills: firstPaper.fills, ledgerAfter: firstPaper.ledgerAfter }, "recovering an applied session must preserve its fills and its own ending ledger");
});
