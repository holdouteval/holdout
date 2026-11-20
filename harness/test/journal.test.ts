import test from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalize, registerSecret, sha256Hex } from "@holdout/core";
import { atomicBytes, atomicJson, lanePath, listJournals, newJournal, readJson, sessionPath, storeRecord } from "../src/journal.js";
import { lane } from "./decision-fixtures.js";

test("atomic JSON survives concurrent reads, preserves permissions and redacts secrets", async t => {
  const directory = await mkdtemp(join(tmpdir(), "harness-journal-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json"), secret = "journal-test-secret-7521"; registerSecret(secret);
  assert.equal(await readJson(path), null);
  await atomicJson(path, { sequence: 0, payload: "0".repeat(10000), amount: 1n, secret });
  let running = true, reads = 0;
  const reader = (async () => { while (running) {
    const value = await readJson<{ sequence: number; payload: string; amount: string; secret: string }>(path); assert.ok(value);
    assert.equal(value.payload, String(value.sequence).repeat(10000)); assert.equal(value.amount, "1"); assert.equal(value.secret, "[secret]"); reads++;
  } })();
  try { for (let sequence = 1; sequence <= 12; sequence++) await atomicJson(path, { sequence, payload: String(sequence).repeat(10000), amount: 1n, secret }); }
  finally { running = false; await reader; }
  assert.ok(reads > 0); assert.equal((await readJson<{ sequence: number }>(path))!.sequence, 12);
  assert.equal((await stat(path)).mode & 0o777, 0o600); assert.deepEqual(await readdir(directory), ["state.json"]);
  const binary = join(directory, "nested", "bytes"); await atomicBytes(binary, Uint8Array.of(0, 127, 255));
  assert.deepEqual(await readFile(binary), Buffer.from([0, 127, 255]));
});

test("immutable records accept identical bytes and reject replacement content", async t => {
  const directory = await mkdtemp(join(tmpdir(), "harness-record-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = canonicalize({ schema: "test/1", value: "original" }), h = sha256Hex(bytes);
  const path = await storeRecord(directory, h, bytes);
  assert.equal(await storeRecord(directory, h, bytes), path); assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(storeRecord(directory, h, canonicalize({ schema: "test/1", value: "changed" })), /content conflict/);
  assert.deepEqual(await readFile(path), Buffer.from(bytes));
  await assert.rejects(storeRecord(directory, "../invalid", bytes), /invalid record hash/);
});

test("journal paths reject traversal and loading retains persisted session state", async t => {
  const directory = await mkdtemp(join(tmpdir(), "harness-sessions-")); t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(lanePath(lane.lane), lane.lane); assert.throws(() => lanePath(lane.lane.toUpperCase()), /invalid lane/);
  assert.throws(() => sessionPath(directory, "../2026-11-16", lane.lane), /invalid session/);
  assert.deepEqual(await listJournals(directory), []);
  const journal = newJournal(lane, { date: "2026-11-16", key: "2026-11-16", time: 1794837600, mode: "send", now: 1794837601 });
  await atomicJson(sessionPath(directory, journal.key, lane.lane), journal);
  await mkdir(join(directory, "sessions", "ignored"));
  const loaded = await listJournals(directory); assert.deepEqual(loaded, [journal]);
  assert.equal(loaded[0].stage, "snapshot"); assert.equal(loaded[0].attempts.length, 0);
});

type LockMessage = { event: string; at: number; error?: string };
function child(directory: string, address: string) {
  const process = fork(fileURLToPath(new URL("./lock-child.js", import.meta.url)), [directory, address], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const messages: LockMessage[] = [], exits: Promise<{ code: number | null; signal: NodeJS.Signals | null }> = new Promise(resolve => process.once("exit", (code, signal) => resolve({ code, signal })));
  process.on("message", message => messages.push(message as LockMessage));
  const event = async (name: string, timeout = 30_000): Promise<LockMessage> => {
    const existing = messages.find(message => message.event === name); if (existing) return existing;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error("child did not report " + name)); }, timeout);
      const listener = (value: unknown) => { const message = value as LockMessage; if (message.event === name) { cleanup(); resolve(message); } else if (message.event === "failed") { cleanup(); reject(new Error(message.error)); } };
      const cleanup = () => { clearTimeout(timer); process.off("message", listener); };
      process.on("message", listener);
    });
  };
  return { process, messages, event, exits };
}
async function terminate(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  await new Promise<void>(resolve => { process.once("exit", () => resolve()); process.kill("SIGKILL"); });
}

test("two processes contend for a kernel lane lock and SIGKILL releases it within thirty seconds", { timeout: 35_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "harness-lock-"));
  const holder = child(directory, lane.lane); let contender: ReturnType<typeof child> | undefined;
  t.after(async () => { await terminate(holder.process); if (contender) await terminate(contender.process); await rm(directory, { recursive: true, force: true }); });
  const acquired = await holder.event("acquired"); contender = child(directory, lane.lane); await contender.event("waiting");
  await delay(200); assert.equal(contender.messages.some(message => message.event === "acquired"), false);
  assert.equal(holder.messages.some(message => message.event === "released"), false);
  const killedAt = Date.now(); holder.process.kill("SIGKILL"); assert.equal((await holder.exits).signal, "SIGKILL");
  const following = await contender.event("acquired"); assert.ok(following.at >= killedAt); assert.ok(following.at - killedAt < 30000);
  assert.ok(following.at >= acquired.at); contender.process.send("release"); await contender.event("released"); assert.equal((await contender.exits).code, 0);
});
