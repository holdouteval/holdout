import { open, mkdir, rename, readFile, readdir, link, unlink } from "node:fs/promises";
import { dirname, join, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SignedIntent, SendReceipt } from "@holdout/core";
import { redactValue } from "./secrets.js";
import type { AttemptRecord, Decision, HarnessRequest, HarnessResponse, LaneConfig, RecordError, SnapshotResult } from "./types.js";

export interface Publication {
  acceptedAt?: number; lastCheck?: number; nextAttempt?: number; status?: number; verifiedAt?: number; error?: string;
}
export interface ExecutionBody {
  schema: "holdout.execution/1"; h: string; lane: string; outcome: "reverted";
  error: { name: string; args: unknown[] }; stage: "simulation" | "quote" | "estimate" | "chain" | "late"; tx: string | null;
}
export interface TransactionState {
  kind: "seal" | "trade"; signed: SignedIntent; signedAt: number; sentAt?: number;
  receipt?: SendReceipt; abandoned?: boolean;
}
export interface Journal {
  schema: "holdout.session/1"; date: string; key: string; lane: string; model: string; mode: "paper" | "send";
  time: number; createdAt: number; updatedAt: number; stage: string; final: boolean;
  snapshot?: SnapshotResult; request?: HarnessRequest;
  attempts: { started: number; finished?: number; raw: string; reservation: string; bytesRead?: number; result?: AttemptRecord; durationMs?: number; httpStatus?: number | null }[];
  response?: HarnessResponse; decision?: Decision | null; recordError?: RecordError | null;
  record?: { h: string; path: string }; transactions: TransactionState[];
  review?: { state: "pending" | "sent" | "skipped" | "auto-skipped"; time: number; chainOverride?: boolean };
  execution?: ExecutionBody; recordPublication: Publication; executionPublication: Publication;
  faults: string[]; errors: string[];
}

export function lanePath(lane: string): string {
  if (!/^0x[0-9a-f]{40}$/.test(lane)) throw new Error("invalid lane journal key");
  return lane;
}
export function sessionPath(dataDir: string, key: string, lane: string): string {
  if (!/^\d{4}-\d{2}-\d{2}(?:-\d+)?$/.test(key)) throw new Error("invalid session journal key");
  return join(dataDir, "sessions", key, lanePath(lane) + ".json");
}
export async function atomicBytes(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + `.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const text = JSON.stringify(redactValue(value), (_key, item) => typeof item === "bigint" ? item.toString() : item);
  await atomicBytes(path, Buffer.from(text + "\n"));
}
export async function readJson<T>(path: string): Promise<T | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value?.schema === "holdout.session/1") {
      const root = dirname(dirname(dirname(path)));
      const artifact = (entry: string) => {
        if (isAbsolute(entry)) return entry;
        const result = resolve(root, entry);
        if (!result.startsWith(resolve(root) + "/")) throw new Error("invalid journal artifact path");
        return result;
      };
      if (value.record?.path) value.record.path = artifact(value.record.path);
      for (const attempt of value.attempts ?? []) if (attempt.raw) attempt.raw = artifact(attempt.raw);
    }
    return value as T;
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export async function storeRecord(dataDir: string, h: string, bytes: Uint8Array): Promise<string> {
  if (!/^0x[0-9a-f]{64}$/.test(h)) throw new Error("invalid record hash");
  const path = join(dataDir, "records", h + ".json");
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + `.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await link(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!Buffer.from(bytes).equals(await readFile(path))) throw new Error("immutable record content conflict");
  } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
  return path;
}
export async function listJournals(dataDir: string): Promise<Journal[]> {
  const root = join(dataDir, "sessions"), result: Journal[] = [];
  let dates; try { dates = await readdir(root, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  for (const date of dates.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!date.isDirectory() || !/^\d{4}-\d{2}-\d{2}(?:-\d+)?$/.test(date.name)) continue;
    for (const file of await readdir(join(root, date.name))) {
      if (!/^0x[0-9a-f]{40}\.json$/.test(file)) continue;
      const value = await readJson<Journal>(join(root, date.name, file)); if (value) result.push(value);
    }
  }
  return result;
}
export async function withLaneLock<T>(dataDir: string, lane: string, task: () => Promise<T>, timeout = 30_000): Promise<T> {
  const path = join(dataDir, "locks", lanePath(lane) + ".sqlite");
  await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try { db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.floor(timeout))}; BEGIN EXCLUSIVE`); return await task(); }
  finally { try { db.exec("ROLLBACK"); } catch {} db.close(); }
}
export function newJournal(lane: LaneConfig, options: { date: string; key: string; time: number; mode: "paper" | "send"; now: number }): Journal {
  return { schema: "holdout.session/1", date: options.date, key: options.key, lane: lane.lane, model: lane.model, mode: options.mode,
    time: options.time, createdAt: options.now, updatedAt: options.now, stage: "snapshot", final: false, attempts: [], transactions: [],
    recordPublication: {}, executionPublication: {}, faults: [], errors: [] };
}
