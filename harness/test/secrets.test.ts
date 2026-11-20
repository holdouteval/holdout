import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { readProviderKeys, registerSecret, redactValue, safeError, safeLog, SecretByteRedactor } from "../src/secrets.js";
import { temporary } from "./model-support.js";

test("provider keys prefer environment values and read only the two named file entries", async t => {
  const root = await temporary(t), file = join(root, ".env");
  await writeFile(file, 'IGNORED_VALUE=excluded-sentinel\nANTHROPIC_API_KEY="file-anthropic-sentinel"\nexport OPENAI_API_KEY=\'file-openai-sentinel\'\n');
  assert.deepEqual(readProviderKeys({ envFile: file, env: { ANTHROPIC_API_KEY: "environment-anthropic-sentinel" } }),
    { anthropic: "environment-anthropic-sentinel", openai: "file-openai-sentinel" });
  assert.deepEqual(redactValue({ value: "environment-anthropic-sentinel/file-openai-sentinel", excluded: "excluded-sentinel" }),
    { value: "[secret]/[secret]", excluded: "excluded-sentinel" });
});

test("streaming secret redaction handles every possible chunk split", () => {
  const key = "stream-secret-λ-sentinel", source = Buffer.from(`before:${key}:after`);
  for (let split = 0; split <= source.length; split++) {
    const redactor = new SecretByteRedactor([key]);
    const output = Buffer.concat([redactor.push(source.subarray(0, split)), redactor.push(source.subarray(split)), redactor.finish()]);
    assert.equal(output.toString(), "before:[secret]:after");
  }
  const short = new SecretByteRedactor([key]);
  const partial = Buffer.from("stream-secr");
  assert.equal(short.push(partial).byteLength, 0);
  assert.equal(Buffer.from(short.finish()).toString(), partial.toString());
});

test("logs and errors remove exact registered keys, fallback URLs and home paths", () => {
  const secret = "private-material-sentinel", fallback = "https://rpc.invalid.example/route?token=sentinel";
  registerSecret(secret);
  const text = `${secret} ${fallback} ${join(homedir(), "private", "failure")}\nnext`;
  for (const result of [safeLog(text), safeError(new Error(text))]) {
    assert.equal(result.includes(secret), false);
    assert.equal(result.includes(fallback), false);
    assert.equal(result.includes(homedir()), false);
  }
  assert.deepEqual(redactValue({ [secret]: [secret, { error: secret }] }), { "[secret]": ["[secret]", { error: "[secret]" }] });
});
