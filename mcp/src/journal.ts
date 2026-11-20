import { open, mkdir, readFile, rename, link, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Orders, OrderListing, SignedIntent, SendReceipt } from "@holdout/core";
import type { DecisionResult, ToolError } from "./types.js";
import { redactValue } from "./record.js";

export type JournalStage = "record" | "signed" | "sent" | "receipt" | "uploaded" | "verified" | "failed" | "not-sent";
export interface UploadState {
  state: "waiting" | "uploaded" | "verified" | "error";
  status?: number; acceptedAt?: number; lastCheck?: number; nextAttempt?: number; verifiedAt?: number; error?: string;
  lastStatus?: number; lastCode?: string | null;
}
export interface JournalEntry {
  requestId: string; requestDigest: string; h: string; kind: "trade" | "seal"; stage: JournalStage;
  recordAt: number; signed?: SignedIntent; signedAt?: number; broadcastAttemptedAt?: number; sentAt?: number;
  receipt?: SendReceipt; upload: UploadState; error?: ToolError; result: DecisionResult;
  listing: OrderListing; orders: Orders;
}
export interface Journal { schema: "holdout.mcp-journal/1"; lane: string; entries: JournalEntry[] }
export class AgentBusy extends Error { constructor() { super("busy"); } }
const address = (value: string) => { if (!/^0x[0-9a-f]{40}$/.test(value)) throw new Error("invalid-address"); return value; };
export const journalPath = (home: string, lane: string) => join(home, "lanes", address(lane), "journal.json");
export const recordPath = (home: string, lane: string, h: string) => {
  if (!/^0x[0-9a-f]{64}$/.test(h)) throw new Error("invalid-record-hash");
  return join(home, "lanes", address(lane), "records", h + ".json");
};
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r"); try { await directory.sync(); } finally { await directory.close(); }
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + "." + process.pid + "." + Math.random().toString(16).slice(2) + ".tmp";
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path); await syncDirectory(dirname(path));
}
export async function readJournal(home: string, lane: string): Promise<Journal> {
  let value: Journal;
  try { value = JSON.parse(await readFile(journalPath(home, lane), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schema: "holdout.mcp-journal/1", lane, entries: [] }; throw error; }
  if (value.schema !== "holdout.mcp-journal/1" || value.lane !== lane || !Array.isArray(value.entries)) throw new Error("invalid-journal");
  for (const entry of value.entries) {
    if (!/^0x[0-9a-f]{64}$/.test(entry.h) || !["record", "signed", "sent", "receipt", "uploaded", "verified", "failed", "not-sent"].includes(entry.stage)) throw new Error("invalid-journal");
  }
  return value;
}
export async function saveJournal(home: string, journal: Journal): Promise<void> {
  const stored = { ...journal, entries: journal.entries.map(entry => {
    const { signed, ...rest } = entry;
    return { ...redactValue(rest), ...(signed ? { signed } : {}) };
  }) };
  await atomicJson(journalPath(home, journal.lane), stored);
}
export async function storeRecord(home: string, lane: string, h: string, bytes: Uint8Array): Promise<void> {
  const path = recordPath(home, lane, h); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + "." + process.pid + "." + Math.random().toString(16).slice(2) + ".tmp";
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  try { await link(temporary, path); await syncDirectory(dirname(path)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!Buffer.from(bytes).equals(await readFile(path))) throw new Error("record-content-conflict");
  } finally { await unlink(temporary); }
}
export async function withAgentLock<T>(home: string, agent: string, operation: () => Promise<T>): Promise<T> {
  const path = join(home, "locks", address(agent) + ".sqlite"); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    try { db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE"); }
    catch (error) { if (/locked|busy/i.test(String((error as Error).message))) throw new AgentBusy(); throw error; }
    return await operation();
  } finally { try { db.exec("ROLLBACK"); } catch {} db.close(); }
}
export const isOpen = (entry: JournalEntry) => entry.stage === "record" || entry.stage === "signed" || entry.stage === "sent";
