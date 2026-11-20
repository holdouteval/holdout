import { canonicalize, redactSecrets, sha256Hex, validateRecord } from "@holdout/core";
import { emptyOrders } from "./orders.js";
import type { Decision, HarnessRecord, HarnessRequest, HarnessResponse, LaneConfig, Orders, RecordError, Review, Snapshot } from "./types.js";

export const MAX_INPUT_BYTES = 65_536;
export const MAX_RECORD_BYTES = 2_707_460;
export class RecordTooLarge extends Error { constructor(readonly bytes: number) { super("record exceeds structural byte bound"); this.name = "RecordTooLarge"; } }
export function inputBytes(snapshot: Snapshot, request: HarnessRequest): number { return canonicalize({ snapshot, request }).length; }
export interface CreateRecordOptions {
  lane: string | LaneConfig; model?: string; review?: Review; time: number; date: string; harness: { version: string; commit: string | null };
  snapshot?: Snapshot | null; request?: HarnessRequest | null; response?: HarnessResponse | null; decision?: Decision | null; orders?: Orders; error?: RecordError | null;
}
function redact(value: any): any {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [redactSecrets(key), redact(entry)]));
  return value;
}
function freeze(value: any): void { if (value && typeof value === "object") { Object.freeze(value); for (const entry of Object.values(value)) freeze(entry); } }
export function createRecord(options: CreateRecordOptions): { value: HarnessRecord; bytes: Uint8Array; h: string } {
  const lane = typeof options.lane === "string" ? options.lane : options.lane.lane;
  const model = options.model ?? (typeof options.lane === "string" ? undefined : options.lane.model);
  const review = options.review ?? (typeof options.lane === "string" ? undefined : options.lane.review);
  if (!model || !review) throw new Error("record requires lane model and review");
  const value: HarnessRecord = redact({ schema: "holdout.record/1", chainId: 4663, lane, kind: "decision", time: options.time, model, review,
    harness: options.harness, session: { date: options.date, decisionTime: options.time }, snapshot: options.snapshot ?? null,
    request: options.request ?? null, response: options.response ?? null, decision: options.decision ?? null, orders: options.orders ?? emptyOrders(), error: options.error ?? null });
  validateRecord(value); const bytes = canonicalize(value);
  if (bytes.length > MAX_RECORD_BYTES) throw new RecordTooLarge(bytes.length);
  freeze(value); return { value, bytes, h: sha256Hex(bytes) };
}
export function failureRecord(options: Omit<CreateRecordOptions, "snapshot" | "request" | "response" | "decision" | "orders" | "error"> & { error: RecordError }) {
  return createRecord({ ...options, snapshot: null, request: null, response: null, decision: null, orders: emptyOrders() });
}
