import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SYSTEM } from "./prompt.js";
import type { HarnessConfig } from "./types.js";

export function publicConfig(config: HarnessConfig, harness: { version: string; commit: string | null }) {
  const cutoffs: unknown = JSON.parse(readFileSync(config.cutoffsFile, "utf8"));
  if (!Array.isArray(cutoffs)) throw new Error("invalid cutoff configuration");
  for (const cutoff of cutoffs) {
    if (!cutoff || typeof cutoff !== "object" || Array.isArray(cutoff) || typeof cutoff.model !== "string"
      || !(cutoff.date === null || typeof cutoff.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(cutoff.date))
      || typeof cutoff.label !== "string" || typeof cutoff.note !== "string" || !(cutoff.source === null || typeof cutoff.source === "string")) throw new Error("invalid cutoff configuration");
    if (typeof cutoff.source === "string") {
      let parsed: URL; try { parsed = new URL(cutoff.source); } catch { throw new Error("invalid cutoff source"); }
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("invalid cutoff source");
    }
  }
  return { schema: "holdout.harness/1" as const, system: SYSTEM, decisionTime: "10:00 America/New_York" as const,
    lineup: config.lanes.map(({ model, review }) => ({ model, review })), cutoffs,
    harness: { version: harness.version, commit: harness.commit } };
}
export function publicConfigBytes(config: HarnessConfig, harness: { version: string; commit: string | null }): Uint8Array {
  return Buffer.from(JSON.stringify(publicConfig(config, harness)) + "\n");
}
export function writePublicConfig(config: HarnessConfig, output: string, harness: { version: string; commit: string | null }): void {
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, publicConfigBytes(config, harness));
}
