import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalize } from "@holdout/core";
import { canonicalMetadata } from "./sse.js";

export interface TokenPrice { input: number | string; output: number | string }
export const DEFAULT_PRICES: Record<string, TokenPrice> = {
  "claude-fable-5-2": { input: 8, output: 40 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-haiku-5-5": { input: "0.10", output: "0.50" },
  "gpt-6-astra": { input: 10, output: 50 },
  "gpt-6.1-sol": { input: 2, output: 10 },
};
export interface TokenUsage { inputTokens: number; outputTokens: number; reasoningTokens: number; cacheCreationTokens: number; cacheReadTokens: number }
export interface BudgetOptions { limitUsd?: number | string; lifetimeLimitUsd?: number | string; prices?: Record<string, TokenPrice>; now?: () => number }
export interface Reservation { id: string; model: string; inputTokensBound: number; maxOutputTokens: number }
export interface BudgetSummary {
  limitUsd: string; spentUsd: string; reservedUsd: string; committedUsd: string;
  month?: string; lifetimeLimitUsd?: string; lifetimeCommittedUsd?: string;
  reservations: number; unsettled: number;
  models: Record<string, { inputTokens: number; outputTokens: number; reasoningTokens: number; costUsd: string; unknownReservations: number }>;
}

function count(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0; }
export function tokenUsage(usage: unknown): TokenUsage {
  const u = usage && typeof usage === "object" ? usage as Record<string, any> : {};
  return {
    inputTokens: count(u.input_tokens), outputTokens: count(u.output_tokens),
    reasoningTokens: count(u.output_tokens_details?.reasoning_tokens ?? u.output_tokens_details?.thinking_tokens ?? u.thinking_tokens),
    cacheCreationTokens: count(u.cache_creation_input_tokens), cacheReadTokens: count(u.cache_read_input_tokens),
  };
}
function decimal(value: number | string, scale: number): bigint {
  const text = String(value); if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) throw new Error("invalid cost value");
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > scale && /[1-9]/.test(fraction.slice(scale))) throw new Error("cost precision exceeds supported scale");
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt((fraction.slice(0, scale) + "0".repeat(scale)).slice(0, scale));
}
export function dollars(nanodollars: bigint): string {
  const whole = nanodollars / 1_000_000_000n, fraction = (nanodollars % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
function rates(price: TokenPrice): { input: bigint; output: bigint } {
  // A dollar per million tokens is one thousand nanodollars per token.
  return { input: decimal(price.input, 3), output: decimal(price.output, 3) };
}
export function estimateCost(model: string, usage: unknown, prices = DEFAULT_PRICES): string {
  const price = prices[model]; if (!price) throw new Error("model price unavailable");
  return dollars(costNano(model, usage, price));
}
function costNano(model: string, usage: unknown, price: TokenPrice): bigint {
  const tokens = tokenUsage(usage), rate = rates(price);
  // Unrequested cache metadata is charged conservatively: full input for reads,
  // and the largest normal cache-write multiplier for creation.
  const billedInput = BigInt(tokens.inputTokens) + BigInt(tokens.cacheReadTokens) + 2n * BigInt(tokens.cacheCreationTokens);
  return billedInput * rate.input + BigInt(tokens.outputTokens) * rate.output;
}
export class BudgetLimit extends Error {
  constructor() { super("model cost budget would be exceeded"); this.name = "BudgetLimit"; }
}

/** A reservation remains charged after a crash until completed usage is known. */
export class DurableBudget {
  private readonly db: DatabaseSync;
  private readonly limit: bigint;
  private readonly prices: Record<string, TokenPrice>;
  private readonly lifetimeLimit?: bigint;
  private readonly now: () => number;
  private month(at = this.now()): string { return new Date(at * 1000).toISOString().slice(0, 7); }
  constructor(readonly path: string, options: BudgetOptions = {}) {
    mkdirSync(dirname(path), { recursive: true });
    this.limit = decimal(options.limitUsd ?? 30, 9); this.prices = options.prices ?? DEFAULT_PRICES;
    if (this.limit <= 0n) throw new Error("model budget must be positive");
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.lifetimeLimit = options.lifetimeLimitUsd === undefined ? undefined : decimal(options.lifetimeLimitUsd, 9);
    if (this.lifetimeLimit !== undefined && this.lifetimeLimit <= 0n) throw new Error("model budget must be positive");
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=30000; CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY, model TEXT NOT NULL, input_bound INTEGER NOT NULL, output_bound INTEGER NOT NULL, amount TEXT NOT NULL, settled INTEGER NOT NULL DEFAULT 0, usage TEXT);");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const columns = this.db.prepare("PRAGMA table_info(reservations)").all();
      if (!columns.some(column => column.name === "created_at")) {
        this.db.exec("ALTER TABLE reservations ADD COLUMN created_at INTEGER");
        this.db.prepare("UPDATE reservations SET created_at=? WHERE created_at IS NULL").run(this.now());
      }
      this.db.exec("CREATE INDEX IF NOT EXISTS reservations_created_at ON reservations(created_at); COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); this.db.close(); throw error; }
  }
  reserve(request: Reservation): { id: string; reservedUsd: string; committedUsd: string } {
    if (!request.id || !Number.isSafeInteger(request.inputTokensBound) || request.inputTokensBound < 0 || !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 0) throw new Error("invalid cost reservation");
    const price = this.prices[request.model]; if (!price) throw new Error("model price unavailable");
    const rate = rates(price), multiplier = request.model.startsWith("claude-") ? 2n : 1n;
    const amount = BigInt(request.inputTokensBound) * rate.input * multiplier + BigInt(request.maxOutputTokens) * rate.output;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.db.prepare("SELECT * FROM reservations WHERE id=?").get(request.id);
      if (old && (old.model !== request.model || old.input_bound !== request.inputTokensBound || old.output_bound !== request.maxOutputTokens)) throw new Error("cost reservation conflict");
      const now = this.now(), month = this.month(now), total = this.total(month);
      if (!old) {
        if (total + amount > this.limit || (this.lifetimeLimit !== undefined && this.total() + amount > this.lifetimeLimit)) throw new BudgetLimit();
        this.db.prepare("INSERT INTO reservations(id,model,input_bound,output_bound,amount,created_at) VALUES(?,?,?,?,?,?)").run(request.id, request.model, request.inputTokensBound, request.maxOutputTokens, amount.toString(), now);
      }
      const committed = old ? total : total + amount;
      this.db.exec("COMMIT");
      return { id: request.id, reservedUsd: dollars(old ? BigInt(String(old.amount)) : amount), committedUsd: dollars(committed) };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  settle(id: string, usage: unknown): BudgetSummary {
    if (usage === null || usage === undefined) return this.summary();
    const counters = usage as Record<string, unknown>;
    if (!usage || typeof usage !== "object" || !Number.isSafeInteger(counters.input_tokens) || Number(counters.input_tokens) < 0
      || !Number.isSafeInteger(counters.output_tokens) || Number(counters.output_tokens) < 0) return this.summary();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.db.prepare("SELECT * FROM reservations WHERE id=?").get(id);
      if (!old) throw new Error("cost reservation missing");
      const encoded = Buffer.from(canonicalize(canonicalMetadata(usage))).toString("utf8"), price = this.prices[String(old.model)];
      if (!price) throw new Error("model price unavailable");
      if (old.settled && old.usage !== encoded) throw new Error("cost settlement conflict");
      const amount = costNano(String(old.model), usage, price);
      const committed = this.total(this.month(Number(old.created_at))) - BigInt(String(old.amount)) + amount;
      if (committed > this.limit || (this.lifetimeLimit !== undefined && this.total() - BigInt(String(old.amount)) + amount > this.lifetimeLimit)) throw new BudgetLimit();
      this.db.prepare("UPDATE reservations SET amount=?,settled=1,usage=? WHERE id=?").run(amount.toString(), encoded, id);
      this.db.exec("COMMIT");
      return this.summary();
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /** Use only when the caller has confirmed no provider request was billable. */
  release(id: string): void {
    this.db.prepare("UPDATE reservations SET amount='0',settled=1,usage='null' WHERE id=? AND settled=0").run(id);
  }
  private total(month?: string): bigint {
    const rows = month === undefined ? this.db.prepare("SELECT amount FROM reservations").all()
      : this.db.prepare("SELECT amount FROM reservations WHERE strftime('%Y-%m',created_at,'unixepoch')=?").all(month);
    return rows.reduce((sum, row) => sum + BigInt(String(row.amount)), 0n);
  }
  summary(): BudgetSummary {
    let spent = 0n, reserved = 0n, unsettled = 0;
    const models: BudgetSummary["models"] = {};
    const costs: Record<string, bigint> = {};
    const month = this.month();
    const rows = this.db.prepare("SELECT * FROM reservations WHERE strftime('%Y-%m',created_at,'unixepoch')=? ORDER BY id").all(month);
    for (const row of rows) {
      const model = String(row.model), amount = BigInt(String(row.amount));
      const item = models[model] ??= { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: "0", unknownReservations: 0 };
      if (row.settled) {
        spent += amount;
        const usage = tokenUsage(row.usage ? JSON.parse(String(row.usage)) : null);
        item.inputTokens += usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
        item.outputTokens += usage.outputTokens; item.reasoningTokens += usage.reasoningTokens;
      } else { reserved += amount; unsettled++; item.unknownReservations++; }
      costs[model] = (costs[model] ?? 0n) + amount; item.costUsd = dollars(costs[model]);
    }
    return { limitUsd: dollars(this.limit), month, spentUsd: dollars(spent), reservedUsd: dollars(reserved), committedUsd: dollars(spent + reserved), reservations: rows.length, unsettled, models,
      ...(this.lifetimeLimit === undefined ? {} : { lifetimeLimitUsd: dollars(this.lifetimeLimit), lifetimeCommittedUsd: dollars(this.total()) }) };
  }
  close(): void { this.db.close(); }
}
