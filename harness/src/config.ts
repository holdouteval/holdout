import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ADDRESSES } from "@holdout/core";
import type { HarnessConfig, LaneConfig, Listing, ModelConfig, Price } from "./types.js";

export const MODELS = ["claude-fable-5-2", "claude-opus-5-5", "claude-haiku-5-5", "gpt-6-astra", "gpt-6.1-sol"] as const;
const address = /^0x[0-9a-fA-F]{40}$/;
const hash = /^0x[0-9a-fA-F]{64}$/;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown, minimum = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const bad = (): never => { throw new Error("invalid harness configuration"); };
function endpoint(value: unknown): string {
  if (typeof value !== "string") return bad();
  try { const u = new URL(value); if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) return bad(); }
  catch { return bad(); }
  return value.replace(/\/$/, "");
}
export function validateConfig(value: unknown, baseDir = process.cwd()): HarnessConfig {
  if (!object(value)) return bad();
  const mode = value.mode ?? "paper"; if (!["paper", "send"].includes(mode)) return bad();
  const monthlyUsd = value.budget?.monthlyUsd;
  if (value.budget !== undefined && !object(value.budget)) return bad();
  if (monthlyUsd === undefined ? mode === "send" : typeof monthlyUsd !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(monthlyUsd) || !/[1-9]/.test(monthlyUsd) || (monthlyUsd.split(".")[1]?.length ?? 0) > 9) return bad();
  if (!object(value.rpc ?? {}) || typeof value.dataDir !== "string" || !value.dataDir) return bad();
  const rpc: { override?: string } = {};
  if (value.rpc?.override !== undefined) {
    rpc.override = endpoint(value.rpc.override);
    if (!["127.0.0.1", "localhost"].includes(new URL(rpc.override).hostname)) return bad();
  }
  const factory = value.factory === null ? null : typeof value.factory === "string" && address.test(value.factory) ? value.factory.toLowerCase() : bad();
  if (mode === "send" && factory === null) return bad();
  if (!Array.isArray(value.lanes) || value.lanes.length !== 5 || !object(value.models) || !object(value.prices)) return bad();
  const models: Record<string, ModelConfig> = {}, prices: Record<string, Price> = {};
  for (const id of MODELS) {
    const m = value.models[id], p = value.prices[id], provider = id.startsWith("claude-") ? "anthropic" : "openai";
    if (!object(m) || m.provider !== provider || m.effort !== "high" || m.maxOutputTokens !== 64000
      || !object(p) || ![p.input, p.output].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)) return bad();
    models[id] = { provider, effort: "high", maxOutputTokens: 64000 }; prices[id] = { input: p.input, output: p.output };
  }
  const seen = new Set<string>(), seenModels = new Set<string>();
  const lanes: LaneConfig[] = value.lanes.map((lane: any) => {
    if (!object(lane) || typeof lane.lane !== "string" || !address.test(lane.lane) || typeof lane.agent !== "string" || !address.test(lane.agent)
      || !MODELS.includes(lane.model) || !["auto", "operator-send-or-skip"].includes(lane.review) || typeof lane.keyFile !== "string") return bad();
    const expected = lane.model.startsWith("claude-") ? "auto" : "operator-send-or-skip";
    if (lane.review !== expected || seen.has(lane.lane.toLowerCase()) || seenModels.has(lane.model)) return bad();
    seen.add(lane.lane.toLowerCase()); seenModels.add(lane.model);
    return { lane: lane.lane.toLowerCase(), agent: lane.agent.toLowerCase(), model: lane.model, review: expected,
      keyFile: resolve(baseDir, lane.keyFile) };
  });
  if (typeof value.listingFile !== "string" || typeof value.cutoffsFile !== "string" || !integer(value.paperMaxAge, 1)) return bad();
  return { mode, budget: { monthlyUsd: monthlyUsd ?? "30" }, rpc, dataDir: resolve(baseDir, value.dataDir), publicBase: endpoint(value.publicBase), adminBase: endpoint(value.adminBase),
    factory, lanes, models, prices, listingFile: resolve(baseDir, value.listingFile), cutoffsFile: resolve(baseDir, value.cutoffsFile), paperMaxAge: value.paperMaxAge };
}
export function loadConfig(path: string): HarnessConfig { return validateConfig(JSON.parse(readFileSync(path, "utf8"))); }
export function validateListing(value: unknown, maxAge = 90000): Listing {
  if (!object(value) || !Array.isArray(value.assets) || !/^\d+$/.test(String(value.principal)) || !integer(value.actWindow, 1)) return bad();
  const seen = new Set<string>(), indices = new Set<number>();
  const assets = value.assets.map((a: any, index: number) => {
    if (!object(a) || typeof a.symbol !== "string" || !/^[A-Z][A-Z0-9.]*$/.test(a.symbol) || !address.test(a.token) || !address.test(a.feed)
      || !Array.isArray(a.pools) || !a.pools.length || seen.has(a.token.toLowerCase())) return bad();
    seen.add(a.token.toLowerCase());
    const pools = a.pools.map((p: any) => {
      const key = p.key;
      if (!object(p) || !integer(p.index) || indices.has(p.index) || !hash.test(p.poolId) || !object(key)
        || !address.test(key.currency0) || !address.test(key.currency1) || !address.test(key.hooks)
        || !integer(key.fee) || !Number.isSafeInteger(key.tickSpacing)) return bad();
      const [currency0, currency1] = [ADDRESSES.usdg, a.token.toLowerCase()].sort();
      if (key.currency0.toLowerCase() !== currency0 || key.currency1.toLowerCase() !== currency1) return bad();
      indices.add(p.index);
      return { index: p.index, token: a.token.toLowerCase(), poolId: p.poolId.toLowerCase(), key: { currency0, currency1, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks.toLowerCase() } };
    });
    return { assetId: integer(a.assetId) ? a.assetId : index, symbol: a.symbol, token: a.token.toLowerCase(), feed: a.feed.toLowerCase(), pools };
  });
  if (!integer(maxAge, 1)) return bad();
  return { principal: String(value.principal), maxAge, actWindow: value.actWindow, assets };
}
export function loadListing(path: string, maxAge = 90000): Listing { return validateListing(JSON.parse(readFileSync(path, "utf8")), maxAge); }
