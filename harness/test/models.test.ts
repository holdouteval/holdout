import assert from "node:assert/strict";
import test from "node:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runModelAttempt, recoverAttempt, classifyAttempt, retryBudget, MAX_RESPONSE_BYTES } from "../src/models.js";
import { extractSse } from "../src/sse.js";
import { anthropicFrames, openaiFrames, fakeProvider, frame, stream, temporary } from "./model-support.js";

test("Anthropic SDK sends exact parameters and preserves all three large text deltas", async t => {
  const root = await temporary(t), texts = ["a".repeat(90000), "b".repeat(90000), "c".repeat(90000)];
  const fake = await fakeProvider(t, response => stream(response, anthropicFrames(texts, { details: { metadata: "retained" } })));
  let syncedChunks = 0;
  const result = await runModelAttempt({ provider: "anthropic", model: "claude-fable-5-2", system: "system input", user: "user input",
    rawPath: join(root, "anthropic.raw"), apiKey: "anthropic-test-key", baseURL: fake.baseURL,
    onChunk: async progress => { assert.equal((await stat(join(root, "anthropic.raw"))).size, progress.persistedBytes); syncedChunks++; },
  });
  assert.deepEqual(fake.requests[0].body, { model: "claude-fable-5-2", max_tokens: 64000, system: "system input", messages: [{ role: "user", content: "user input" }], output_config: { effort: "high" }, stream: true });
  assert.equal(fake.requests.length, 1);
  assert.equal(result.error, null);
  assert.equal(result.completed, true);
  assert.equal(classifyAttempt(result), "success");
  assert.equal(result.text, texts.join(""));
  assert.equal(result.sdkText, result.text);
  assert.equal(result.tail, "");
  assert.equal(result.model, "claude-fable-5-2");
  assert.equal(result.id, "message-test");
  assert.deepEqual(result.stop, { reason: "end_turn", details: { metadata: "retained" } });
  assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 29 });
  assert.equal(result.bytesRead, (await readFile(join(root, "anthropic.raw"))).length);
  assert.ok(syncedChunks > 0);
});

test("OpenAI SDK sends exact parameters and accepts dated model names with full usage", async t => {
  const root = await temporary(t), usage = { input_tokens: 9, output_tokens: 21, total_tokens: 30, output_tokens_details: { reasoning_tokens: 14 }, custom_ratio: 0.125 };
  const fake = await fakeProvider(t, response => stream(response, openaiFrames(["one", "two"], { usage })));
  const result = await runModelAttempt({ provider: "openai", model: "gpt-6.1-sol", system: "system input", user: "user input", rawPath: join(root, "openai.raw"), apiKey: "openai-test-key", baseURL: fake.baseURL });
  assert.deepEqual(fake.requests[0].body, { model: "gpt-6.1-sol", instructions: "system input", input: "user input", max_output_tokens: 64000, reasoning: { effort: "high" }, stream: true });
  assert.equal(result.error, null);
  assert.equal(result.completed, true);
  assert.equal(result.model, "gpt-6.1-sol-2026-11-01");
  assert.equal(result.text, "onetwo");
  assert.equal(result.sdkText, result.text);
  assert.deepEqual(result.stop, { status: "completed", incompleteDetails: null });
  assert.deepEqual(result.usage, { ...usage, custom_ratio: "0.125" });
});

test("completed model mismatches are recorded and retried without accepting a decision", async t => {
  const root = await temporary(t), fake = await fakeProvider(t, response => stream(response, openaiFrames(["answer"], { model: "different-model" })));
  const result = await runModelAttempt({ provider: "openai", model: "gpt-6.1-sol", system: "", user: "", rawPath: join(root, "mismatch.raw"), apiKey: "mismatch-test-key", baseURL: fake.baseURL });
  assert.equal(result.completed, true);
  assert.equal(result.error, "model-mismatch");
  assert.equal(classifyAttempt(result), "retry");
  assert.equal(result.retryable, true);
});

test("SDK retries stay disabled for both 404 and 429, with terminal model absence", async t => {
  const root = await temporary(t), fake = await fakeProvider(t, (response, request) => {
    response.writeHead(request.body.model === "missing-model" ? 404 : 429, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { type: "test_error", message: "provider rejected request" } }));
  });
  const missing = await runModelAttempt({ provider: "anthropic", model: "missing-model", system: "", user: "", rawPath: join(root, "missing.raw"), apiKey: "retry-anthropic-key", baseURL: fake.baseURL });
  const limited = await runModelAttempt({ provider: "openai", model: "rate-limited", system: "", user: "", rawPath: join(root, "limited.raw"), apiKey: "retry-openai-key", baseURL: fake.baseURL });
  const claudeLimited = await runModelAttempt({ provider: "anthropic", model: "rate-limited", system: "", user: "", rawPath: join(root, "limited-claude.raw"), apiKey: "retry-anthropic-key", baseURL: fake.baseURL });
  assert.equal(fake.requests.length, 3);
  assert.equal(missing.error, "model-unavailable");
  assert.equal(classifyAttempt(missing), "model-unavailable");
  assert.equal(classifyAttempt(limited), "retry");
  assert.equal(limited.httpStatus, 429);
  assert.equal(claudeLimited.httpStatus, 429);
  assert.ok(missing.bytesRead > 0 && limited.bytesRead > 0);
});

test("refusal is terminal and output limits remain retryable", async t => {
  const root = await temporary(t), fake = await fakeProvider(t, (response, request) => {
    if (request.body.instructions === "refuse") stream(response, openaiFrames([], { refusal: true }));
    else stream(response, openaiFrames(["partial answer"], { status: "incomplete" }));
  });
  const refusal = await runModelAttempt({ provider: "openai", model: "gpt-6.1-sol", system: "refuse", user: "", rawPath: join(root, "refuse.raw"), apiKey: "status-test-key", baseURL: fake.baseURL });
  const limited = await runModelAttempt({ provider: "openai", model: "gpt-6.1-sol", system: "limit", user: "", rawPath: join(root, "max.raw"), apiKey: "status-test-key", baseURL: fake.baseURL });
  assert.equal(refusal.error, "refusal");
  assert.equal(classifyAttempt(refusal), "refusal");
  assert.equal(limited.completed, false);
  assert.equal(limited.error, "max_tokens");
  assert.equal(classifyAttempt(limited), "retry");
  assert.deepEqual(limited.stop, { status: "incomplete", incompleteDetails: { reason: "max_output_tokens" } });
  assert.ok(limited.usage);
});

test("body counting stops at exactly 512 KiB, closes the connection and retains its entire suffix", async t => {
  const root = await temporary(t);
  let disconnected = false, writes = 0;
  const first = frame({ type: "response.output_text.delta", delta: "retained" });
  const fake = await fakeProvider(t, async response => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.once("close", () => { disconnected = true; });
    response.write(first);
    for (let index = 0; index < 30 && !response.destroyed; index++) { response.write("x".repeat(70000)); writes++; await delay(5); }
    if (!response.destroyed) response.end();
  });
  const path = join(root, "bounded.raw"), result = await runModelAttempt({ provider: "openai", model: "gpt-6.1-sol", system: "", user: "", rawPath: path, apiKey: "bound-test-key", baseURL: fake.baseURL });
  const raw = await readFile(path);
  await delay(20);
  assert.equal(result.bytesRead, MAX_RESPONSE_BYTES);
  assert.equal(raw.length, MAX_RESPONSE_BYTES);
  assert.equal(result.completed, false);
  assert.equal(result.stop, "harness-byte-limit");
  assert.equal(result.error, "harness-byte-limit");
  assert.equal(result.text, "retained");
  assert.deepEqual(Buffer.from(result.tail, "base64"), raw.subarray(Buffer.byteLength(first)));
  assert.equal(disconnected, true);
  assert.ok(writes < 30);
  assert.equal(extractSse(raw, "openai").text, result.text);
  assert.equal(recoverAttempt(raw, "openai").tail, result.tail);
});

test("timeout and dropped connections preserve received text without completing a response", async t => {
  const root = await temporary(t), fake = await fakeProvider(t, async (response, request) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(frame({ type: "response.output_text.delta", delta: "received" }));
    if (request.body.instructions === "drop") { await delay(20); response.destroy(); }
  });
  const timeout = await runModelAttempt({ provider: "openai", model: "gpt-6.1-sol", system: "timeout", user: "", rawPath: join(root, "timeout.raw"), apiKey: "timeout-test-key", baseURL: fake.baseURL, timeoutMs: 100 });
  const dropped = await runModelAttempt({ provider: "openai", model: "gpt-6.1-sol", system: "drop", user: "", rawPath: join(root, "drop.raw"), apiKey: "timeout-test-key", baseURL: fake.baseURL });
  assert.equal(timeout.error, "model-timeout");
  for (const outcome of [timeout, dropped]) {
    assert.equal(outcome.completed, false);
    assert.equal(outcome.text, "received");
    assert.equal(outcome.usage, null);
    assert.equal(classifyAttempt(outcome), "retry");
  }
});

test("provider key echoes split across transport chunks cannot enter raw journals or records", async t => {
  const root = await temporary(t), key = "echoed-model-key-sentinel", fake = await fakeProvider(t, async response => {
    const raw = openaiFrames([`before:${key}:after`]).join(""), at = raw.indexOf(key) + 5;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(raw.slice(0, at)); await delay(10); response.end(raw.slice(at));
  });
  const path = join(root, "secret.raw"), result = await runModelAttempt({ provider: "openai", model: "gpt-6.1-sol", system: "", user: "", rawPath: path, apiKey: key, baseURL: fake.baseURL });
  assert.equal(result.error, null);
  assert.equal(result.text, "before:[secret]:after");
  assert.equal(result.sdkText, result.text);
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal((await readFile(path, "utf8")).includes(key), false);
  assert.equal(result.bytesRead, Buffer.byteLength(openaiFrames([`before:${key}:after`]).join("")));
});

test("retry accounting enforces both budgets and the five specified delays", () => {
  const attempts = [{ bytesRead: 0 }, { bytesRead: 0 }, { bytesRead: 0 }, { bytesRead: 0 }, { bytesRead: 0 }, { bytesRead: 0 }];
  assert.deepEqual(attempts.slice(0, 5).map((_, index) => retryBudget(attempts.slice(0, index + 1)).delayMs), [2000, 4000, 8000, 16000, 32000]);
  assert.equal(retryBudget(attempts).available, false);
  assert.equal(retryBudget([{ bytesRead: 1 }, { bytesRead: 2 }, { bytesRead: 3 }]).available, false);
  assert.equal(retryBudget([{ bytesRead: 0 }, { bytesRead: 0 }, { bytesRead: 1 }, { bytesRead: 2 }]).available, true);
});
