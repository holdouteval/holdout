import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BudgetLimit, DurableBudget, estimateCost, tokenUsage } from "../src/budget.js";
import { temporary } from "./model-support.js";

test("usage and prices include billed reasoning output without counting it twice", () => {
  const usage = { input_tokens: 1000, output_tokens: 2000, output_tokens_details: { reasoning_tokens: 1500 } };
  assert.equal(estimateCost("gpt-6-astra", usage), "0.11");
  assert.equal(estimateCost("gpt-6.1-sol", usage), "0.022");
  assert.equal(estimateCost("claude-fable-5-2", usage), "0.088");
  assert.equal(estimateCost("claude-opus-5-5", usage), "0.044");
  assert.equal(estimateCost("claude-haiku-5-5", usage), "0.0011");
  assert.equal(tokenUsage(usage).reasoningTokens, 1500);
  assert.equal(tokenUsage({ output_tokens: 216, output_tokens_details: { thinking_tokens: 137 } }).reasoningTokens, 137);
});

test("durable reservations survive restart and settle idempotently from actual usage", async t => {
  const root = await temporary(t), path = join(root, "budget.sqlite");
  let budget = new DurableBudget(path);
  const request = { id: "first", model: "gpt-6.1-sol", inputTokensBound: 1000, maxOutputTokens: 64000 };
  assert.equal(budget.reserve(request).reservedUsd, "0.642");
  budget.reserve(request);
  assert.equal(budget.summary().reservations, 1);
  budget.close();
  budget = new DurableBudget(path);
  t.after(() => budget.close());
  assert.equal(budget.summary().reservedUsd, "0.642");
  budget.settle("first", null);
  budget.settle("first", {});
  budget.settle("first", { input_tokens: 1, output_tokens: -1 });
  assert.equal(budget.summary().reservedUsd, "0.642");
  const usage = { input_tokens: 1000, output_tokens: 2000, output_tokens_details: { reasoning_tokens: 1500 } };
  budget.settle("first", usage);
  budget.settle("first", { output_tokens_details: { reasoning_tokens: 1500 }, output_tokens: 2000, input_tokens: 1000 });
  assert.equal(budget.summary().spentUsd, "0.022");
  assert.equal(budget.summary().unsettled, 0);
  assert.deepEqual(budget.summary().models[request.model], { inputTokens: 1000, outputTokens: 2000, reasoningTokens: 1500, costUsd: "0.022", unknownReservations: 0 });
  assert.throws(() => budget.settle("first", { input_tokens: 2, output_tokens: 3 }), /settlement conflict/);
  assert.throws(() => budget.reserve({ ...request, maxOutputTokens: 1 }), /reservation conflict/);
});

test("all clients sharing the budget are fenced by the durable monthly limit before a call", async t => {
  const path = join(await temporary(t), "budget.sqlite"), first = new DurableBudget(path, { limitUsd: "0.65" }), second = new DurableBudget(path, { limitUsd: "0.65" });
  t.after(() => { first.close(); second.close(); });
  const larger = new DurableBudget(path, { limitUsd: 31 }); larger.close();
  first.reserve({ id: "first", model: "gpt-6.1-sol", inputTokensBound: 1000, maxOutputTokens: 64000 });
  assert.throws(() => second.reserve({ id: "second", model: "gpt-6.1-sol", inputTokensBound: 1000, maxOutputTokens: 64000 }), BudgetLimit);
  assert.equal(second.summary().reservations, 1);
  first.release("first");
  second.reserve({ id: "second", model: "gpt-6.1-sol", inputTokensBound: 1000, maxOutputTokens: 64000 });
  assert.equal(first.summary().committedUsd, "0.642");
});


test("reservations belong to the UTC month in which they were created", async t => {
  let now = Date.parse("2026-11-30T23:59:59Z") / 1000;
  const path = join(await temporary(t), "month.sqlite"), budget = new DurableBudget(path, { limitUsd: "0.65", now: () => now });
  t.after(() => budget.close());
  budget.reserve({ id: "november", model: "gpt-6.1-sol", inputTokensBound: 1000, maxOutputTokens: 64000 });
  assert.equal(budget.summary().month, "2026-11");
  assert.throws(() => budget.reserve({ id: "too-much-november", model: "gpt-6.1-sol", inputTokensBound: 1000, maxOutputTokens: 64000 }), BudgetLimit);
  now++;
  assert.equal(budget.summary().month, "2026-12"); assert.equal(budget.summary().committedUsd, "0");
  budget.reserve({ id: "december", model: "gpt-6.1-sol", inputTokensBound: 1000, maxOutputTokens: 64000 });
  budget.settle("november", { input_tokens: 1000, output_tokens: 2000 });
  assert.equal(budget.summary().spentUsd, "0"); assert.equal(budget.summary().reservedUsd, "0.642");
  now--;
  assert.equal(budget.summary().spentUsd, "0.022"); assert.equal(budget.summary().reservations, 1);
});

test("legacy reservations are assigned once to their migration month", async t => {
  const path = join(await temporary(t), "legacy.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE reservations(id TEXT PRIMARY KEY, model TEXT NOT NULL, input_bound INTEGER NOT NULL, output_bound INTEGER NOT NULL, amount TEXT NOT NULL, settled INTEGER NOT NULL DEFAULT 0, usage TEXT)");
  db.prepare("INSERT INTO reservations VALUES(?,?,?,?,?,?,?)").run("legacy", "gpt-6.1-sol", 1, 1, "2000", 1, '{"input_tokens":1,"output_tokens":0}'); db.close();
  let budget = new DurableBudget(path, { now: () => Date.parse("2026-11-30T23:59:59Z") / 1000 });
  assert.equal(budget.summary().spentUsd, "0.000002"); budget.close();
  budget = new DurableBudget(path, { now: () => Date.parse("2026-12-01T00:00:00Z") / 1000 });
  assert.equal(budget.summary().spentUsd, "0"); budget.close();
  const read = new DatabaseSync(path, { readOnly: true });
  assert.equal(read.prepare("SELECT created_at FROM reservations WHERE id='legacy'").get()!.created_at, Date.parse("2026-11-30T23:59:59Z") / 1000); read.close();
});

test("an explicit rehearsal ledger retains its lifetime cap across months", async t => {
  let now = Date.parse("2026-11-30T23:59:59Z") / 1000;
  const budget = new DurableBudget(join(await temporary(t), "rehearsal.sqlite"), { limitUsd: 100, lifetimeLimitUsd: 30, now: () => now,
    prices: { "gpt-6.1-sol": { input: 1, output: 1 } } });
  t.after(() => budget.close());
  budget.reserve({ id: "first", model: "gpt-6.1-sol", inputTokensBound: 20_000_000, maxOutputTokens: 0 });
  now++;
  assert.equal(budget.summary().committedUsd, "0"); assert.equal(budget.summary().lifetimeCommittedUsd, "20");
  assert.throws(() => budget.reserve({ id: "second", model: "gpt-6.1-sol", inputTokensBound: 20_000_000, maxOutputTokens: 0 }), BudgetLimit);
});
