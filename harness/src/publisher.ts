import { readFile } from "node:fs/promises";
import { canonicalize } from "@holdout/core";
import type { HarnessConfig } from "./types.js";
import type { Journal, Publication } from "./journal.js";
import { safeError } from "./secrets.js";

export interface PublicationOptions {
  now?: () => number; fetch?: typeof globalThis.fetch; save: () => Promise<void>;
}
const sameJson = (a: Uint8Array, b: Uint8Array): boolean => {
  try { return Buffer.from(canonicalize(JSON.parse(Buffer.from(a).toString()))).equals(Buffer.from(canonicalize(JSON.parse(Buffer.from(b).toString())))); } catch { return false; }
};
/** One durable publication step. Network delays never hold an unjournaled intent. */
export async function publish(config: HarnessConfig, journal: Journal, options: PublicationOptions): Promise<void> {
  if (journal.mode !== "send" || !journal.record || journal.review?.state === "pending") return;
  if (!journal.transactions.some(tx => !tx.abandoned && tx.receipt)) return;
  if (journal.transactions.some(tx => !tx.abandoned && !tx.receipt)) return;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000)), fetcher = options.fetch ?? globalThis.fetch;
  const step = async (kind: "r" | "x", body: Uint8Array, state: Publication) => {
    if (state.verifiedAt !== undefined || state.error || state.nextAttempt && state.nextAttempt > now()) return;
    const path = `/${kind}/${journal.record!.h}.json`;
    try {
      if (state.acceptedAt !== undefined) {
        if (state.status === 202 && now() - (state.lastCheck ?? state.acceptedAt) < 300) return;
        const response = await fetcher(config.publicBase + path, { signal: AbortSignal.timeout(30_000) });
        state.lastCheck = now();
        if (response.status === 200) {
          const received = new Uint8Array(await response.arrayBuffer());
          const same = kind === "r" ? Buffer.from(body).equals(Buffer.from(received)) : sameJson(body, received);
          if (same) state.verifiedAt = now(); else state.error = "published-content-mismatch";
          await options.save(); return;
        }
        if (response.status !== 404 || now() - state.acceptedAt < 3600) { await options.save(); return; }
        delete state.acceptedAt; delete state.status;
        await options.save();
      }
      const endpoint = config.adminBase + (kind === "r" ? "/r" : `/x/${journal.record!.h}`);
      const response = await fetcher(endpoint, { method: "POST", headers: { "content-type": "application/json" },
        body: Buffer.from(body), signal: AbortSignal.timeout(30_000) });
      state.status = response.status;
      if ([200, 201, 202].includes(response.status)) {
        state.acceptedAt = now(); delete state.lastCheck; delete state.nextAttempt;
      } else if (response.status === 409) {
        let reason: any; try { reason = await response.json(); } catch {}
        if (reason?.error === "not-sealed") state.nextAttempt = now() + Math.max(1, Number(response.headers.get("retry-after")) || 30);
        else state.error = typeof reason?.error === "string" ? reason.error : "publication-conflict";
      } else if (response.status >= 400 && response.status < 500) state.error = `publication-http-${response.status}`;
      else state.nextAttempt = now() + 30;
      await options.save();
      if (state.acceptedAt !== undefined && response.status !== 202) {
        const check = await fetcher(config.publicBase + path, { signal: AbortSignal.timeout(30_000) });
        state.lastCheck = now();
        if (check.status === 200) {
          const received = new Uint8Array(await check.arrayBuffer());
          if (kind === "r" ? Buffer.from(body).equals(Buffer.from(received)) : sameJson(body, received)) state.verifiedAt = now();
          else state.error = "published-content-mismatch";
        }
        await options.save();
      }
    } catch (error) { state.nextAttempt = now() + 30; journal.errors.push(safeError(error)); await options.save(); }
  };
  await step("r", await readFile(journal.record.path), journal.recordPublication);
  if (journal.execution) await step("x", Buffer.from(JSON.stringify(journal.execution)), journal.executionPublication);
  if (journal.recordPublication.verifiedAt !== undefined && (!journal.execution || journal.executionPublication.verifiedAt !== undefined)) journal.stage = "verified";
  else if (journal.recordPublication.acceptedAt !== undefined) journal.stage = "published";
  await options.save();
}
