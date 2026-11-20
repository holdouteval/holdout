import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeAgent, findAgentKey } from "../src/keys.js";

test("M1 init creates a private exclusive key with an opening link and never returns key material", async t => {
  const home = await mkdtemp(join(tmpdir(), "mcp-init-")); t.after(() => rm(home, { recursive: true, force: true }));
  const result = await initializeAgent(home, "agent", "https://example.test/"), key = (await readFile(result.keyFile, "utf8")).trim();
  assert.equal((await stat(result.keyFile)).mode & 0o7777, 0o600); assert.equal((await stat(join(home, "agents"))).mode & 0o7777, 0o700);
  assert.equal((await stat(home)).mode & 0o7777, 0o700); assert.match(result.address, /^0x[0-9a-f]{40}$/);
  assert.equal(result.openUrl, `https://example.test/#open?agent=${result.address}`); assert.equal(result.note, undefined);
  assert.equal(JSON.stringify(result).includes(key), false); assert.equal(JSON.stringify(result).includes(key.slice(2)), false);
  await assert.rejects(initializeAgent(home, "agent", null), /agent-key-exists/); assert.equal((await readFile(result.keyFile, "utf8")).trim(), key);
  const second = await initializeAgent(home, "other", null); assert.equal(second.openUrl, null); assert.ok(second.note);
  for (const name of ["", "Bad", "a/b", "a_b", "x".repeat(33)]) await assert.rejects(initializeAgent(home, name, null), /invalid-agent-name/);
});

test("M2 key discovery selects matching agents, preserves an explicit mismatch and skips unsafe files", async t => {
  const home = await mkdtemp(join(tmpdir(), "mcp-init-")); t.after(() => rm(home, { recursive: true, force: true }));
  const one = await initializeAgent(home, "one", null), two = await initializeAgent(home, "two", null), warnings: string[] = [];
  assert.deepEqual(await findAgentKey(home, two.address), { path: two.keyFile, address: two.address });
  assert.deepEqual(await findAgentKey(home, one.address, two.keyFile), { path: two.keyFile, address: two.address });
  await chmod(two.keyFile, 0o644); assert.equal(await findAgentKey(home, two.address, undefined, message => warnings.push(message)), null);
  assert.ok(warnings.some(message => message.includes("mode 600")));
  await writeFile(join(home, "agents", "bad.key"), "invalid key value\n", { mode: 0o600 });
  assert.equal(await findAgentKey(home, two.address, join(home, "agents", "bad.key"), message => warnings.push(message)), null);
  assert.equal(await findAgentKey(home, two.address, join(home, "agents", "missing.key"), message => warnings.push(message)), null);
  assert.ok(warnings.every(message => !message.includes(home) && !message.includes("invalid key value")));
});
