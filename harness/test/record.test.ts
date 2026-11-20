import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize, parseCanonical, registerSecret, sha256Hex } from "@holdout/core";
import { createRecord, failureRecord, inputBytes, MAX_INPUT_BYTES, MAX_RECORD_BYTES, RecordTooLarge } from "../src/record.js";
import { buildPrompt, shortenReason } from "../src/prompt.js";
import { extractSse } from "../src/sse.js";
import type { AttemptRecord, RecordError } from "../src/types.js";
import { lane, snapshot } from "./decision-fixtures.js";

const meta = { lane, time: 1794582000, date: "2026-11-13", harness: { version: "0.0.0", commit: null } };
function attempt(raw: Uint8Array): AttemptRecord {
  const parsed = extractSse(raw, "openai");
  return { text: parsed.text, tail: parsed.tail, bytesRead: raw.length, completed: parsed.completed, stop: null, usage: null, model: "gpt-6-astra", id: null, error: null };
}
function paddedRaw(text: string, length = 524288): Uint8Array {
  const frame = Buffer.from("data: " + JSON.stringify({ type: "response.output_text.delta", delta: text }) + "\n\n");
  assert.ok(frame.length < length); return Buffer.concat([frame, Buffer.alloc(length - frame.length, 97)]);
}

test("H4 exact record schema, canonical hash, immutable clone, and all five small failures", () => {
  const decision = { weights: { AAA: "1" }, reason: "keep this entire reason\n  " }, data = snapshot();
  const prompt = buildPrompt(data, { openedTime: 0, principal: "1000000000" });
  const record = createRecord({ ...meta, snapshot: data, request: { ...prompt, params: { effort: "high", maxOutputTokens: 64000 } }, decision });
  assert.deepEqual(Object.keys(record.value).sort(), ["schema", "chainId", "lane", "kind", "time", "model", "review", "harness", "session", "snapshot", "request", "response", "decision", "orders", "error"].sort());
  assert.deepEqual(parseCanonical(record.bytes), record.value); assert.equal(record.h, sha256Hex(record.bytes));
  decision.reason = "mutated"; assert.equal(record.value.decision!.reason, "keep this entire reason\n  ");
  assert.throws(() => { record.value.decision!.reason = "mutated"; });
  for (const error of ["parse-failed", "model-unavailable", "refusal", "harness-missed", "input-too-large"] as RecordError[]) {
    const failure = failureRecord({ ...meta, error });
    assert.equal(failure.value.error, error); assert.equal(failure.value.snapshot, null); assert.equal(failure.value.request, null);
    assert.equal(failure.value.response, null); assert.equal(failure.value.decision, null); assert.ok(failure.bytes.length < 1000);
  }
});



test("H4 shortened large history stays below input bound; oversize cannot silently truncate a record", () => {
  const data = snapshot(); data.history = [0, 1, 2].map(i => ({ date: `2026-11-${10 + i}`, weights: { AAA: "1" }, reason: shortenReason("🧠".repeat(524288)) }));
  const request = { ...buildPrompt(data, { openedTime: 0, principal: "1000000000" }), params: { effort: "high", maxOutputTokens: 64000 } };
  assert.ok(inputBytes(data, request) < MAX_INPUT_BYTES);
  const tooLarge = { ...request, user: "x".repeat(MAX_INPUT_BYTES) };
  assert.ok(inputBytes(data, tooLarge) > MAX_INPUT_BYTES);
  assert.throws(() => createRecord({ ...meta, decision: { weights: {}, reason: "x".repeat(MAX_RECORD_BYTES) } }), RecordTooLarge);
  const secret = "fake-record-secret-84d0"; registerSecret(secret);
  const record = createRecord({ ...meta, decision: { weights: {}, reason: `retain spaces  ${secret}\nend` } });
  assert.equal(record.value.decision!.reason, "retain spaces  [secret]\nend"); assert.ok(!Buffer.from(record.bytes).includes(secret));
  assert.equal(canonicalize(record.value).length, record.bytes.length);
});
