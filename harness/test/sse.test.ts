import assert from "node:assert/strict";
import test from "node:test";
import { canonicalize } from "@holdout/core";
import { extractSse, canonicalMetadata } from "../src/sse.js";
import { recoverAttempt } from "../src/models.js";
import { frame } from "./model-support.js";

test("complete text frames are joined without thinking signatures or partial bytes", () => {
  const tail = Buffer.from('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"\ub05d');
  const raw = Buffer.concat([Buffer.from(frame({ type: "content_block_delta", delta: { type: "text_delta", text: "first\n" } })
    + frame({ type: "content_block_delta", delta: { type: "signature_delta", signature: "hidden" } })
    + frame({ type: "content_block_delta", delta: { type: "text_delta", text: "\ub2e4\uc74c" } })), tail]);
  const extracted = extractSse(raw, "anthropic");
  assert.equal(extracted.text, "first\n\ub2e4\uc74c");
  assert.deepEqual(Buffer.from(extracted.tail, "base64"), tail);
  assert.equal(extracted.completed, false);
  assert.deepEqual(recoverAttempt(raw, "anthropic"), { text: "first\n\ub2e4\uc74c", tail: tail.toString("base64"), bytesRead: raw.length,
    completed: false, stop: null, usage: null, model: null, id: null, error: "interrupted" });
});

test("SSE accepts CRLF, mixed empty lines and multiline data", () => {
  const raw = Buffer.from('event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta",\r\ndata: "delta":"one"}\r\n\r\n'
    + 'data: {"type":"response.output_text.delta","delta":"two"}\n\r\n'
    + 'data: {"type":"response.completed"}\r\r');
  assert.equal(extractSse(raw, "openai").text, "onetwo");
  assert.equal(extractSse(raw, "openai").completed, true);
  assert.equal(extractSse(raw, "openai").tail, "");
  assert.equal(extractSse(raw, "anthropic").completed, false);
});

test("recovery never promotes raw terminal events to completed attempts", () => {
  const raw = Buffer.from(frame({ type: "response.output_text.delta", delta: "answer" }) + frame({ type: "response.completed" }));
  assert.equal(extractSse(raw, "openai").completed, true);
  assert.deepEqual(recoverAttempt(raw, "openai", { bytesRead: 1000 }), { text: "answer", tail: "", bytesRead: 1000,
    completed: false, stop: null, usage: null, model: null, id: null, error: "interrupted" });
});

test("usage metadata preserves integer counts and safely serializes arbitrary numbers", () => {
  const source = { count: 3, ratio: 0.25, large: 9007199254740992, minusZero: -0, absent: undefined, nested: [1n, Infinity] };
  const result = canonicalMetadata(source);
  assert.deepEqual(result, { count: 3, ratio: "0.25", large: "9007199254740992", minusZero: "0", absent: null, nested: ["1", "Infinity"] });
  assert.doesNotThrow(() => canonicalize(result));
});
