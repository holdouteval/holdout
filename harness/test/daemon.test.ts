import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessions } from "@holdout/core";
import { daemon, daemonTick, type DaemonEngine } from "../src/daemon.js";
import { sessionTime } from "../src/engine.js";
import { atomicJson, listJournals, newJournal, readJson, sessionPath, type Journal } from "../src/journal.js";
import type { LaneConfig } from "../src/types.js";

const time = (value: string) => Date.parse(value) / 1000;
class FakeEngine implements DaemonEngine {
  config: { mode: "paper" | "send"; dataDir: string; lanes: LaneConfig[] };
  clock: number;
  events: string[] = []; modelCalls = 0; readonly effects = new Map<string, number>();
  onRun?: () => void;
  constructor(dataDir: string, now: number) {
    this.clock = now;
    this.config = { mode: "send", dataDir, lanes: Array.from({ length: 5 }, (_, index) => ({ lane: "0x" + (index + 1).toString().padStart(40, "0"), agent: "0x" + "a".repeat(40), model: `model-${index}`, review: "auto", keyFile: "unused" })) };
  }
  now = () => this.clock;
  async initialize(): Promise<void> { this.events.push("initialize"); }
  private async seal(journal: Journal): Promise<void> {
    const key = `${journal.date}:${journal.lane}`;
    this.effects.set(key, (this.effects.get(key) ?? 0) + 1);
    journal.record = { h: "0x" + "1".repeat(64), path: "unused" };
    journal.review = { state: "pending", time: this.clock }; journal.stage = "review";
    await atomicJson(sessionPath(this.config.dataDir, journal.date, journal.lane), journal);
  }
  async resume(): Promise<void> {
    this.events.push("resume");
    for (const journal of await listJournals(this.config.dataDir)) {
      if (journal.stage !== "tx:seal") continue;
      this.events.push(`recover:${journal.date}`); await this.seal(journal);
    }
  }
  async run(options: { session: string; missed?: boolean; lane?: string }): Promise<void> {
    const selected = this.config.lanes.filter(lane => !options.lane || options.lane === lane.lane);
    for (const lane of selected) {
      this.events.push(`run:${options.session}:${options.missed ? "missed" : "model"}`);
      const journal = newJournal(lane, { date: options.session, key: options.session, time: sessionTime(options.session), mode: this.config.mode, now: this.clock });
      if (options.missed) journal.recordError = "harness-missed"; else this.modelCalls++;
      if (this.config.mode === "paper" && options.missed) { journal.final = true; journal.stage = "final"; await atomicJson(sessionPath(this.config.dataDir, journal.date, lane.lane), journal); }
      else await this.seal(journal);
      this.onRun?.();
    }
  }
}
async function fixture(context: TestContext, now: number): Promise<FakeEngine> {
  const directory = await mkdtemp(join(tmpdir(), "harness-daemon-"));
  context.after(() => rm(directory, { recursive: true, force: true })); return new FakeEngine(directory, now);
}
async function oneTick(engine: FakeEngine): Promise<void> {
  const controller = new AbortController();
  await daemon(engine, { signal: controller.signal, onTick: () => controller.abort(), sleep: async () => { throw new Error("unexpected sleep"); } });
}
const checkpoint = (engine: FakeEngine) => readJson<{ checkedThrough: string }>(join(engine.config.dataDir, "schedule.json"));

test("H11 actual daemon entry at T+10 runs all lanes once and repeats only unfinished recovery", async context => {
  const engine = await fixture(context, sessionTime("2026-11-16") + 10);
  await oneTick(engine);
  assert.deepEqual(engine.events.slice(0, 2), ["initialize", "resume"]); assert.equal(engine.modelCalls, 5); assert.equal(engine.effects.size, 5);
  assert.equal((await checkpoint(engine))?.checkedThrough, "2026-11-16");
  engine.clock += 60; await oneTick(engine);
  assert.equal(engine.modelCalls, 5); assert.ok([...engine.effects.values()].every(count => count === 1));
  assert.equal(engine.events.filter(event => event === "resume").length, 2);
  const journals = await listJournals(engine.config.dataDir);
  assert.ok(journals.every(journal => journal.time === sessionTime("2026-11-16")));
});

test("H11 actual daemon entry at T+16 minutes seals missing records with zero model calls", async context => {
  const engine = await fixture(context, sessionTime("2026-11-16") + 960);
  await oneTick(engine);
  assert.equal(engine.modelCalls, 0); assert.equal(engine.effects.size, 5);
  assert.ok((await listJournals(engine.config.dataDir)).every(journal => journal.recordError === "harness-missed"));
  assert.equal((await checkpoint(engine))?.checkedThrough, "2026-11-16");
});

test("H11 startup recovers an old transaction before today's scheduling or sleeping", async context => {
  const engine = await fixture(context, time("2026-11-17T14:00:00Z")), lane = engine.config.lanes[0];
  const old = newJournal(lane, { date: "2026-11-16", key: "2026-11-16", time: sessionTime("2026-11-16"), mode: "send", now: engine.clock - 86400 }); old.stage = "tx:seal";
  await atomicJson(sessionPath(engine.config.dataDir, old.date, old.lane), old);
  const controller = new AbortController(); let slept = false;
  await daemon(engine, { signal: controller.signal, sleep: async milliseconds => {
    slept = true; assert.ok(milliseconds <= 60000); assert.ok(engine.events.includes("recover:2026-11-16")); controller.abort();
  } });
  assert.equal(slept, true); assert.deepEqual(engine.events.slice(0, 3), ["initialize", "resume", "recover:2026-11-16"]);
  assert.equal(engine.modelCalls, 0); assert.equal(engine.effects.get(`${old.date}:${old.lane}`), 1);
});

test("H11 Monday 09:59 stop and Tuesday 09:00 restart backfills Monday per lane", async context => {
  const engine = await fixture(context, time("2026-11-16T14:59:00Z"));
  await oneTick(engine); assert.equal((await checkpoint(engine))?.checkedThrough, "2026-11-15");
  engine.clock = time("2026-11-17T14:00:00Z"); await oneTick(engine);
  assert.equal(engine.modelCalls, 0); assert.equal(engine.effects.size, 5); assert.equal((await checkpoint(engine))?.checkedThrough, "2026-11-16");
  assert.ok((await listJournals(engine.config.dataDir)).every(journal => journal.date === "2026-11-16" && journal.recordError === "harness-missed"));
  await oneTick(engine); assert.ok([...engine.effects.values()].every(count => count === 1));
});

test("H11 scheduling waits for T+5, polls in sixty seconds, and stops after the current step", async context => {
  const engine = await fixture(context, sessionTime("2026-11-16") - 2), target = engine.clock + 7;
  const controller = new AbortController(), delays: number[] = [];
  engine.onRun = () => controller.abort();
  await daemon(engine, { signal: controller.signal, sleep: async milliseconds => { delays.push(milliseconds); engine.clock += milliseconds / 1000; } });
  assert.deepEqual(delays, [7000]); assert.equal(engine.clock, target); assert.equal(engine.modelCalls, 5); assert.equal(engine.effects.size, 5);
  const early = await fixture(context, sessionTime("2026-11-16") + 3);
  assert.equal((await daemonTick(early)).nextWakeAt, sessionTime("2026-11-16") + 5); assert.equal(early.modelCalls, 0);
});

test("H11 weekends, holidays, DST and early close use the shared calendar", async context => {
  for (const [instant, expectedTarget] of [
    ["2027-03-12T14:59:59Z", "2027-03-12T15:00:05Z"],
    ["2027-03-15T13:59:59Z", "2027-03-15T14:00:05Z"],
    ["2026-11-27T14:59:59Z", "2026-11-27T15:00:05Z"],
  ]) {
    const engine = await fixture(context, time(instant)); assert.equal((await daemonTick(engine)).nextWakeAt, time(expectedTarget)); assert.equal(engine.modelCalls, 0);
  }
  for (const instant of ["2026-11-26T15:10:00Z", "2026-11-28T15:10:00Z"]) {
    const engine = await fixture(context, time(instant)); const result = await daemonTick(engine);
    assert.equal(result.nextWakeAt, engine.clock + 60); assert.equal(engine.modelCalls, 0); assert.equal(engine.effects.size, 0);
  }
  assert.equal(sessions(time("2026-11-27T00:00:00Z"), time("2026-11-27T23:59:59Z"))[0][2], time("2026-11-27T18:00:00Z"));
});

test("H11 backfill preserves existing lane journals and paper misses only log", async context => {
  const engine = await fixture(context, time("2026-11-17T14:00:00Z"));
  await atomicJson(join(engine.config.dataDir, "schedule.json"), { checkedThrough: "2026-11-13" });
  const lane = engine.config.lanes[0], existing = newJournal(lane, { date: "2026-11-16", key: "2026-11-16", time: sessionTime("2026-11-16"), mode: "send", now: engine.clock }); existing.final = true;
  await atomicJson(sessionPath(engine.config.dataDir, existing.date, existing.lane), existing);
  await oneTick(engine); assert.equal(engine.effects.size, 4); assert.equal(engine.effects.has(`${existing.date}:${existing.lane}`), false);
  assert.equal((await checkpoint(engine))?.checkedThrough, "2026-11-16");
  const paper = await fixture(context, sessionTime("2026-11-16") + 960); paper.config.mode = "paper"; await oneTick(paper);
  assert.equal(paper.modelCalls, 0); assert.equal(paper.effects.size, 0); assert.equal((await checkpoint(paper))?.checkedThrough, "2026-11-16");
});

test("H11 termination interrupts idle sleep and restores the process signal listeners", async context => {
  const engine = await fixture(context, time("2026-11-17T14:00:00Z")), before = process.listenerCount("SIGTERM"), started = Date.now();
  await daemon(engine, { onTick: () => { setTimeout(() => process.emit("SIGTERM", "SIGTERM"), 5); } });
  assert.equal(process.listenerCount("SIGTERM"), before); assert.ok(Date.now() - started < 1000); assert.equal(engine.modelCalls, 0);
});

function latch() {
  let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release };
}

test("H11 sixty-second recovery advances another lane during an active model step and termination drains both", async context => {
  const engine = await fixture(context, sessionTime("2026-11-16") + 10), pendingLane = engine.config.lanes[4];
  const old = newJournal(pendingLane, { date: "2026-11-16", key: "2026-11-16", time: sessionTime("2026-11-16"), mode: "send", now: engine.clock }); old.stage = "tx:seal";
  await atomicJson(sessionPath(engine.config.dataDir, old.date, old.lane), old);
  const modelStarted = latch(), modelDone = latch(), recoveryStarted = latch(), recoveryDone = latch();
  const originalRun = engine.run.bind(engine), originalResume = engine.resume.bind(engine);
  let resumes = 0, activeRecoveries = 0, maxRecoveries = 0, timer: (() => void) | null = null, cleared = false, finished = false;
  engine.run = async options => {
    if (options.lane === engine.config.lanes[0].lane) { modelStarted.release(); await modelDone.promise; }
    return originalRun(options);
  };
  engine.resume = async () => {
    resumes++;
    if (resumes === 1) { engine.events.push("resume"); return; }
    activeRecoveries++; maxRecoveries = Math.max(maxRecoveries, activeRecoveries); recoveryStarted.release();
    await recoveryDone.promise; await originalResume(); activeRecoveries--;
  };
  const controller = new AbortController();
  const running = daemon(engine, { signal: controller.signal, recoveryScheduler: {
    setInterval(callback, milliseconds) { assert.equal(milliseconds, 60000); timer = callback; return "timer"; },
    clearInterval(handle) { assert.equal(handle, "timer"); cleared = true; },
  } }).then(() => { finished = true; });
  await modelStarted.promise; assert.deepEqual(engine.events.slice(0, 2), ["initialize", "resume"]);
  engine.clock += 60; assert.ok(timer); (timer as () => void)(); (timer as () => void)();
  await recoveryStarted.promise; assert.equal(resumes, 2); assert.equal(maxRecoveries, 1);
  controller.abort(); modelDone.release();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
  recoveryDone.release(); await running;
  assert.equal(cleared, true); assert.equal(engine.effects.get(`${old.date}:${old.lane}`), 1); assert.equal(engine.modelCalls, 4);
  assert.ok(engine.events.includes("recover:2026-11-16")); assert.equal(activeRecoveries, 0);
});

test("H11 recovery STOP propagates after the active step and prevents the next backfill session", async context => {
  const engine = await fixture(context, time("2026-11-18T14:00:00Z"));
  await atomicJson(join(engine.config.dataDir, "schedule.json"), { checkedThrough: "2026-11-13" });
  const modelStarted = latch(), modelDone = latch(), recoveryFailed = latch(), originalRun = engine.run.bind(engine);
  let timer: (() => void) | null = null, resumes = 0;
  engine.run = async options => { if (options.lane === engine.config.lanes[0].lane) { modelStarted.release(); await modelDone.promise; } return originalRun(options); };
  engine.resume = async () => { if (++resumes > 1) { recoveryFailed.release(); throw new Error("STOP synthetic recovery"); } };
  const running = daemon(engine, { recoveryScheduler: {
    setInterval(callback) { timer = callback; return "timer"; }, clearInterval() {},
  } });
  const rejected = assert.rejects(running, /STOP synthetic recovery/);
  await modelStarted.promise; assert.ok(timer); (timer as () => void)(); await recoveryFailed.promise;
  await new Promise(resolve => setImmediate(resolve)); modelDone.release(); await rejected;
  assert.equal(engine.events.filter(event => event.startsWith("run:2026-11-16:")).length, 5);
  assert.equal(engine.events.some(event => event.startsWith("run:2026-11-17:")), false);
  assert.equal((await checkpoint(engine))?.checkedThrough, "2026-11-13");
});

test("H11 the next session waits for an active recovery batch before acquiring lane ownership", async context => {
  const engine = await fixture(context, time("2026-11-18T14:00:00Z"));
  await atomicJson(join(engine.config.dataDir, "schedule.json"), { checkedThrough: "2026-11-13" });
  const started = latch(), releaseModel = latch(), recoveryStarted = latch(), releaseRecovery = latch(), originalRun = engine.run.bind(engine);
  let timer: (() => void) | null = null, resumes = 0, recovering = false;
  engine.run = async options => {
    assert.equal(recovering, false);
    if (options.session === "2026-11-16" && options.lane === engine.config.lanes[0].lane) { started.release(); await releaseModel.promise; }
    return originalRun(options);
  };
  engine.resume = async () => { if (++resumes === 1) return; recovering = true; recoveryStarted.release(); await releaseRecovery.promise; recovering = false; };
  const running = daemonTick(engine, { recoveryScheduler: { setInterval(callback) { timer = callback; return "timer"; }, clearInterval() {} } });
  await started.promise; assert.ok(timer); (timer as () => void)(); await recoveryStarted.promise;
  releaseModel.release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(engine.events.some(event => event.startsWith("run:2026-11-17:")), false);
  releaseRecovery.release(); await running;
  assert.equal(engine.events.filter(event => event.startsWith("run:2026-11-17:")).length, 5);
  assert.equal((await checkpoint(engine))?.checkedThrough, "2026-11-17");
});
