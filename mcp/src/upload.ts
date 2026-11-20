import { readFile } from "node:fs/promises";
import { safeError } from "@holdout/core";
import { recordPath, type JournalEntry } from "./journal.js";

export interface UploadOptions { home: string; lane: string; dataBase: string; now: () => number; fetch: typeof globalThis.fetch; save: () => Promise<void> }
async function bodyCode(response: Response): Promise<string | null> {
  try { const value = await response.json() as { error?: string }; return typeof value.error === "string" ? value.error : null; } catch { return null; }
}
export async function advanceUpload(entry: JournalEntry, options: UploadOptions): Promise<void> {
  if (!entry.receipt || entry.receipt.status !== 1 || entry.upload.state === "verified" || entry.upload.state === "error") return;
  const now = options.now(), state = entry.upload;
  if ((state.nextAttempt ?? 0) > now) return;
  const bytes = await readFile(recordPath(options.home, options.lane, entry.h));
  const url = options.dataBase.replace(/\/$/, "") + "/r/" + entry.h + ".json";
  const request = (input: string, init?: RequestInit) => options.fetch(input, { ...init, signal: AbortSignal.timeout(10_000) });
  try {
    if (state.state === "uploaded") {
      const response = await request(url);
      state.lastCheck = now;
      if (response.status === 200) {
        if (!bytes.equals(Buffer.from(await response.arrayBuffer()))) { state.state = "error"; state.error = "record-content-conflict"; }
        else { state.state = "verified"; state.verifiedAt = now; entry.stage = "verified"; }
        await options.save(); return;
      }
      if (response.status !== 404 || now - (state.acceptedAt ?? now) < 3_600_000) {
        state.nextAttempt = now + (response.status >= 500 ? 30_000 : 300_000); await options.save(); return;
      }
      state.state = "waiting";
    }
    const response = await request(options.dataBase.replace(/\/$/, "") + "/r", { method: "POST", headers: { "content-type": "application/json" }, body: bytes });
    state.status = response.status;
    state.lastStatus = response.status;
    state.lastCode = null;
    if (response.status === 200 || response.status === 201 || response.status === 202) {
      state.state = "uploaded"; state.acceptedAt = now; state.nextAttempt = response.status === 202 ? now + 300_000 : now;
      entry.stage = "uploaded"; delete state.error; await options.save();
      if (response.status !== 202) await advanceUpload(entry, options);
      return;
    }
    const code = await bodyCode(response);
    state.lastCode = code;
    if (response.status === 409 && code === "not-sealed") {
      const value = response.headers.get("retry-after"), numeric = value === null ? NaN : Number(value);
      const retry = Number.isFinite(numeric) && numeric >= 0 ? numeric * 1000 : value ? Math.max(0, Date.parse(value) - now) : 30_000;
      state.nextAttempt = now + (Number.isFinite(retry) ? retry : 30_000); state.error = "not-sealed";
    } else if (response.status === 404 && code === "unknown-lane") {
      state.nextAttempt = now + 30_000; state.error = "unknown-lane";
    } else if ([400, 404, 413, 415, 422].includes(response.status)) {
      state.state = "error"; state.error = code ?? "upload-rejected";
    } else { state.nextAttempt = now + 30_000; state.error = "upload-unavailable"; }
  } catch (error) { state.nextAttempt = now + 30_000; state.error = "upload-unavailable"; void safeError(error); }
  await options.save();
}
