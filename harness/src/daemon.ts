import { join } from "node:path";
import { isTradingDay, nextDecision } from "@holdout/core";
import { sessionTime } from "./engine.js";
import { atomicJson, readJson, sessionPath, type Journal } from "./journal.js";
import { newYorkDate } from "./snapshot.js";

export interface DaemonEngine {
  readonly config: { mode: "paper" | "send"; dataDir: string; lanes: readonly { lane: string }[] };
  readonly now?: () => number;
  initialize(): Promise<void>;
  resume(): Promise<unknown>;
  run(options: { session: string; missed?: boolean; lane?: string }): Promise<unknown>;
}
export interface RecoveryScheduler {
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}
export interface TickOptions { now?: () => number; signal?: AbortSignal; recoveryScheduler?: RecoveryScheduler }
export interface TickResult { today: string; checkedThrough: string; nextWakeAt: number }
export interface DaemonOptions extends TickOptions {
  sleep?: (milliseconds: number) => Promise<void>;
  onTick?: (result: TickResult) => void | Promise<void>;
}
function addDays(date: string, count: number): string {
  const day = new Date(date + "T12:00:00Z"); day.setUTCDate(day.getUTCDate() + count); return day.toISOString().slice(0, 10);
}
function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value + "T12:00:00Z")) && new Date(value + "T12:00:00Z").toISOString().slice(0, 10) === value;
}
async function journals(engine: DaemonEngine, date: string): Promise<(Journal | null)[]> {
  return Promise.all(engine.config.lanes.map(lane => readJson<Journal>(sessionPath(engine.config.dataDir, date, lane.lane))));
}
function sealed(journal: Journal | null, mode: "paper" | "send"): boolean {
  if (!journal) return false;
  if (mode === "paper") return journal.final;
  return !!journal.record && (journal.final || !!journal.review || journal.recordPublication.acceptedAt !== undefined
    || journal.transactions.some(tx => !tx.abandoned && tx.receipt?.status === 1));
}
async function runMissing(engine: DaemonEngine, date: string, missed: boolean, allowed: () => boolean, pauseRecovery: () => Promise<() => void>): Promise<void> {
  const release = await pauseRecovery();
  let pending: Promise<unknown>[];
  try {
    const existing = await journals(engine, date);
    if (!allowed()) return;
    pending = engine.config.lanes.filter((_, index) => !existing[index]).map(lane => engine.run({ session: date, missed, lane: lane.lane }));
  } finally { release(); }
  const results = await Promise.allSettled(pending);
  const failure = results.find(result => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}
function recoveryPump(engine: DaemonEngine, options: TickOptions) {
  let active: Promise<void> | null = null, failed = false, failure: unknown, stopped = false, paused = false;
  const scheduler: RecoveryScheduler = options.recoveryScheduler ?? {
    setInterval(callback, milliseconds) { const timer = setInterval(callback, milliseconds); timer.unref(); return timer; },
    clearInterval(handle) { clearInterval(handle as ReturnType<typeof setInterval>); },
  };
  const handle = scheduler.setInterval(() => {
    if (stopped || paused || failed || active || options.signal?.aborted) return;
    active = Promise.resolve().then(() => { if (!stopped && !options.signal?.aborted) return engine.resume(); })
      .then(() => {}, error => { failed = true; failure = error; }).finally(() => { active = null; });
  }, 60_000);
  return {
    check() { if (failed) throw failure; },
    async pause() { paused = true; if (active) await active; if (failed) throw failure; return () => { paused = false; }; },
    async stop() { stopped = true; scheduler.clearInterval(handle); if (active) await active; },
  };
}
export async function daemonTick(engine: DaemonEngine, options: TickOptions = {}): Promise<TickResult> {
  const now = options.now ?? engine.now ?? (() => Math.floor(Date.now() / 1000));
  await engine.initialize();
  await engine.resume();
  const recovery = recoveryPump(engine, options);
  try {
    const today = newYorkDate(now()), yesterday = addDays(today, -1), path = join(engine.config.dataDir, "schedule.json");
    const saved = await readJson<{ checkedThrough: string }>(path);
    if (saved && !validDate(saved.checkedThrough)) throw new Error("invalid schedule checkpoint");
    let checkedThrough = saved?.checkedThrough ?? yesterday;
    const result = (): TickResult => {
      const current = now(), date = newYorkDate(current);
      let nextWakeAt = Math.min(current + 60, nextDecision(current) + 5);
      if (isTradingDay(date)) {
        const target = sessionTime(date) + 5;
        if (current < target) nextWakeAt = Math.min(nextWakeAt, target);
      }
      return { today, checkedThrough, nextWakeAt };
    };
    if (options.signal?.aborted) return result();
    for (let date = addDays(checkedThrough, 1); date <= yesterday; date = addDays(date, 1)) {
      recovery.check();
      if (isTradingDay(date)) await runMissing(engine, date, true, () => { recovery.check(); return !options.signal?.aborted; }, recovery.pause);
      recovery.check();
      if (options.signal?.aborted) return result();
    }
    if (checkedThrough < yesterday || !saved) {
      checkedThrough = yesterday; await atomicJson(path, { checkedThrough });
    }
    if (options.signal?.aborted) return result();
    if (isTradingDay(today)) {
      const time = sessionTime(today), current = now();
      if (current >= time + 5) {
        recovery.check();
        await runMissing(engine, today, current > time + 900, () => { recovery.check(); return !options.signal?.aborted; }, recovery.pause);
        recovery.check();
        if ((await journals(engine, today)).every(journal => sealed(journal, engine.config.mode)) && checkedThrough < today) {
          checkedThrough = today; await atomicJson(path, { checkedThrough });
        }
      }
    }
    return result();
  } finally { await recovery.stop(); recovery.check(); }
}

/** Complete the current engine step before stopping on termination. */
export async function daemon(engine: DaemonEngine, options: DaemonOptions = {}): Promise<void> {
  const controller = new AbortController(), terminate = () => controller.abort();
  process.on("SIGTERM", terminate);
  options.signal?.addEventListener("abort", terminate, { once: true });
  if (options.signal?.aborted) terminate();
  const now = options.now ?? engine.now ?? (() => Math.floor(Date.now() / 1000));
  try {
    while (!controller.signal.aborted) {
      const result = await daemonTick(engine, { now, signal: controller.signal, recoveryScheduler: options.recoveryScheduler });
      await options.onTick?.(result);
      if (controller.signal.aborted) break;
      const milliseconds = Math.max(0, Math.min(60_000, Math.ceil((result.nextWakeAt - now()) * 1000)));
      if (!milliseconds) continue;
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => { if (timer) clearTimeout(timer); controller.signal.removeEventListener("abort", abort); };
        const done = () => { cleanup(); resolve(); }, fail = (error: unknown) => { cleanup(); reject(error); };
        const abort = () => done(); controller.signal.addEventListener("abort", abort, { once: true });
        if (options.sleep) options.sleep(milliseconds).then(done, fail);
        else timer = setTimeout(done, milliseconds);
      });
    }
  } finally {
    process.removeListener("SIGTERM", terminate); options.signal?.removeEventListener("abort", terminate);
  }
}
