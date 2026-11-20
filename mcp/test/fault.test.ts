import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJournal, saveJournal } from "../src/journal.js";
import { input, writeFixture } from "./write-support.js";
import { FIXTURE } from "./read-fixtures.js";

const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(read: () => boolean | Promise<boolean>, timeout = 10000) {
  const start = Date.now(); while (!await read()) { if (Date.now() - start > timeout) throw new Error("condition timeout"); await pause(20); }
}
function child(fixture: Awaited<ReturnType<typeof writeFixture>>, action: string, fault?: string, request = input()) {
  const { config, identity, key } = fixture.options;
  const environment = { ...process.env }; delete environment.HARNESS_SEND;
  if (fault) environment.HOLDOUT_MCP_FAULT = fault; else delete environment.HOLDOUT_MCP_FAULT;
  const childProcess = spawn(globalThis.process.execPath, [fileURLToPath(new URL("./fault-child.js", import.meta.url)), JSON.stringify({ config, identity, key, action, request })],
    { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", error = "";
  childProcess.stdout.on("data", bytes => { output += bytes; }); childProcess.stderr.on("data", bytes => { error += bytes; });
  const done = new Promise<{ code: number | null; signal: string | null; output: string; error: string }>((resolve, reject) => {
    childProcess.once("error", reject); childProcess.once("close", (code, signal) => resolve({ code, signal, output, error }));
  });
  return { process: childProcess, done, output: () => output };
}

test("M9 actual SIGKILL after-record closes interrupted state and allows the next decision", async t => {
  const f = await writeFixture(t); const killed = await child(f, "decide", "after-record").done;
  assert.equal(killed.signal, "SIGKILL"); assert.equal((await readJournal(f.home, FIXTURE.lane)).entries[0].stage, "record");
  assert.equal(f.chain.writeState.raw.length, 0);
  const recovered = await child(f, "recover").done; assert.equal(recovered.code, 0, recovered.error);
  const old = (await readJournal(f.home, FIXTURE.lane)).entries[0]; assert.equal(old.stage, "not-sent"); assert.equal(old.error!.code, "interrupted");
  const next = await child(f, "decide", undefined, input("next-request")).done; assert.equal(next.code, 0, next.error);
  assert.equal(JSON.parse(next.output).state, "executed"); assert.equal(f.chain.writeState.sealEvents.length, 1);
});

test("M9 actual SIGKILL after-sign resumes its original signature exactly once", async t => {
  const f = await writeFixture(t); const killed = await child(f, "decide", "after-sign").done; assert.equal(killed.signal, "SIGKILL");
  const original = (await readJournal(f.home, FIXTURE.lane)).entries[0]; assert.equal(original.stage, "signed"); assert.equal(original.broadcastAttemptedAt, undefined);
  const recovered = await child(f, "recover").done; assert.equal(recovered.code, 0, recovered.error);
  assert.equal(f.chain.writeState.raw.length, 1); assert.equal(f.chain.writeState.raw[0], original.signed!.rawTransaction);
  assert.equal(f.chain.writeState.sealEvents.length, 1); assert.equal((await readJournal(f.home, FIXTURE.lane)).entries[0].stage, "verified");
});

test("M9 stale never-attempted signatures close without sending", async t => {
  const f = await writeFixture(t); assert.equal((await child(f, "decide", "after-sign").done).signal, "SIGKILL");
  const journal = await readJournal(f.home, FIXTURE.lane); journal.entries[0].signedAt = Date.now() - 121000; await saveJournal(f.home, journal);
  const recovered = await child(f, "recover").done; assert.equal(recovered.code, 0, recovered.error);
  const entry = (await readJournal(f.home, FIXTURE.lane)).entries[0]; assert.equal(entry.stage, "not-sent"); assert.equal(entry.error!.code, "stale"); assert.equal(f.chain.writeState.raw.length, 0);
});

test("M9 actual SIGKILL after-broadcast reuses identical bytes without rechecking moved quotes", async t => {
  const f = await writeFixture(t); f.chain.writeState.automine = false;
  assert.equal((await child(f, "decide", "after-broadcast").done).signal, "SIGKILL");
  assert.equal(f.chain.writeState.raw.length, 1); const original = f.chain.writeState.raw[0];
  f.chain.writeState.multiplier = 12000n;
  const recovering = child(f, "recover"); await until(() => f.chain.writeState.raw.length === 2); f.chain.mine();
  const result = await recovering.done; assert.equal(result.code, 0, result.error);
  assert.equal(f.chain.writeState.raw[1], original); assert.equal(f.chain.writeState.sealEvents.length, 1);
  assert.equal((await readJournal(f.home, FIXTURE.lane)).entries[0].stage, "verified");
});

test("M10 exclusive agent lock is immediate across processes and releases on SIGKILL", async t => {
  const f = await writeFixture(t), holder = child(f, "lock"); t.after(() => holder.process.kill("SIGKILL"));
  await until(() => holder.output().includes('"acquired":true'));
  const start = Date.now(), loser = await child(f, "lock-once").done;
  assert.equal(loser.code, 0); assert.equal(JSON.parse(loser.output).state, "busy"); assert.ok(Date.now() - start < 2500);
  holder.process.kill("SIGKILL"); assert.equal((await holder.done).signal, "SIGKILL");
  const next = await child(f, "lock-once").done; assert.equal(next.code, 0); assert.equal(JSON.parse(next.output).acquired, true);
});

test("M14 simultaneous processes with the same request ID produce one seal", async t => {
  const f = await writeFixture(t), first = child(f, "decide"), second = child(f, "decide");
  const results = await Promise.all([first.done, second.done]); assert.ok(results.every(result => result.code === 0), JSON.stringify(results));
  const values = results.map(result => JSON.parse(result.output));
  assert.equal(values.filter(value => value.state === "executed" && !value.replayed).length, 1);
  assert.ok(values.some(value => value.state === "busy" || value.replayed)); assert.equal(f.chain.writeState.sealEvents.length, 1); assert.equal(f.chain.writeState.nonce, 1n);
});
