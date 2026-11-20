import { readFile, mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { ADDRESSES, LANE_ABI, RpcClient, SendClient, blockAtTime, canonicalize, decodeRevert, encodeFunctionData,
  isTradingDay, readHeader, readLaneState, revertData, sessions, sha256Hex, type SendReceipt, type SignedIntent } from "@holdout/core";
import { DurableBudget, BudgetLimit } from "./budget.js";
import { runModelAttempt, recoverAttempt, retryBudget, classifyAttempt, type AttemptOptions, type AttemptOutcome } from "./models.js";
import { atomicJson, listJournals, newJournal, readJson, sessionPath, storeRecord, withLaneLock, type Journal, type TransactionState } from "./journal.js";
import { publish } from "./publisher.js";
import { collectSnapshot, newYorkDate } from "./snapshot.js";
import { buildPrompt } from "./prompt.js";
import { parseDecision } from "./parse.js";
import { buildOrders, checkExecutionQuotes, emptyOrders, MAX, ZERO_HASH } from "./orders.js";
import { createRecord, inputBytes, MAX_INPUT_BYTES, RecordTooLarge } from "./record.js";
import { readProviderKeys, redactValue, safeError, safeLog } from "./secrets.js";
import { harnessIdentity } from "./version.js";
import { OFFICIAL_PROVIDER_ENDPOINTS, providerEndpoints } from "./provider-endpoints.js";
import type { AttemptRecord, ExecutionError, HarnessConfig, HarnessRecord, LaneConfig, ReadRpc, RecordError } from "./types.js";

export class HarnessStop extends Error {
  constructor(readonly condition: number, readonly evidence: unknown) { super(`STOP ${condition}`); this.name = "HarnessStop"; }
}
export class KnownExecutionFailure extends Error {
  constructor(readonly stage: "quote" | "estimate", readonly detail: ExecutionError) { super(detail.name); }
}
export class SnapshotUnavailable extends Error {}
type Budget = Pick<DurableBudget, "reserve" | "settle" | "release" | "summary">;
export interface EngineOptions {
  rpc?: ReadRpc; sender?: SendClient; budget?: Budget; budgetPath?: string; fetch?: typeof globalThis.fetch;
  now?: () => number; sleep?: (ms: number) => Promise<void>; logger?: (message: string) => void;
  model?: (options: AttemptOptions) => Promise<AttemptOutcome>;
  snapshot?: typeof collectSnapshot; orders?: typeof buildOrders; executionQuotes?: typeof checkExecutionQuotes;
  header?: typeof readHeader; laneState?: typeof readLaneState;
  onAttemptChunk?: (journal: Journal, progress: { bytesRead: number; persistedBytes: number }) => Promise<void>;
}
export interface RunOptions { session?: string; latest?: boolean; missed?: boolean; lane?: string }
const attemptRecord = (value: AttemptOutcome): AttemptRecord => ({ text: value.text, tail: value.tail, bytesRead: value.bytesRead,
  completed: value.completed, stop: value.stop, usage: value.usage, model: value.model, id: value.id, error: value.error });
const hex = (value: number) => "0x" + value.toString(16);
export function sessionTime(date: string): number {
  if (!isTradingDay(date)) throw new Error("session is not a trading day");
  const noon = Date.parse(date + "T12:00:00Z") / 1000;
  const found = sessions(noon - 86400, noon + 86400).find(s => newYorkDate(s[1]) === date);
  if (!found) throw new Error("session time unavailable"); return found[1];
}

export class HarnessEngine {
  readonly rpc: ReadRpc; readonly sender: SendClient; readonly now: () => number; readonly sleep: (ms: number) => Promise<void>;
  readonly budget: Budget; readonly fetcher: typeof globalThis.fetch;
  readonly harness = harnessIdentity();
  private local = false; private initialized = false; private ownedBudget?: DurableBudget;
  private endpoints = { ...OFFICIAL_PROVIDER_ENDPOINTS };
  private endpointWarningLogged = false;
  readonly busyLanes = new Set<string>();
  constructor(readonly config: HarnessConfig, readonly options: EngineOptions = {}) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.rpc = options.rpc ?? new RpcClient({ override: config.rpc.override, logger: message => this.log({ stage: "rpc", error: message }) });
    this.sender = options.sender ?? new SendClient({ override: config.rpc.override, logger: message => this.log({ stage: "send-rpc", error: message }) });
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.budget = options.budget ?? (this.ownedBudget = new DurableBudget(options.budgetPath ?? join(config.dataDir, "cost.sqlite"), { limitUsd: config.budget.monthlyUsd, prices: config.prices, now: this.now, ...(options.budgetPath ? { lifetimeLimitUsd: 30 } : {}) }));
  }
  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.config.mode === "send") this.local = (await this.sender.assertBoundary()).local;
    this.endpoints = providerEndpoints({ mode: this.config.mode, local: this.local,
      warn: message => { if (!this.endpointWarningLogged) { this.endpointWarningLogged = true; this.log({ stage: "provider-endpoint-warning", message }); } } });
    if (!this.options.model) readProviderKeys();
    if (process.env.HARNESS_FAULT && !this.local) this.log({ stage: "fault-ignored", error: "fault injection requires guarded local anvil" });
    this.initialized = true;
  }
  close(): void { this.ownedBudget?.close(); }
  private log(value: unknown): void { const message = safeLog(value); (this.options.logger ?? console.log)(message); }
  private header(block: number | string = "latest") { return (this.options.header ?? readHeader)(this.rpc, block as any); }
  private async save(journal: Journal): Promise<void> {
    journal.updatedAt = this.now();
    const stored = { ...journal, record: journal.record ? { ...journal.record, path: relative(this.config.dataDir, journal.record.path) } : undefined,
      attempts: journal.attempts.map(attempt => ({ ...attempt, raw: relative(this.config.dataDir, attempt.raw) })) };
    await atomicJson(sessionPath(this.config.dataDir, journal.key, journal.lane), stored);
  }
  private async fault(journal: Journal, point: string): Promise<void> {
    if (!this.local || process.env.HARNESS_FAULT !== `${point}:${journal.lane}` || journal.faults.includes(point)) return;
    journal.faults.push(point); await this.save(journal); process.kill(process.pid, "SIGKILL");
  }
  async run(options: RunOptions): Promise<Journal[]> {
    await this.initialize();
    if (options.latest && this.config.mode !== "paper") throw new Error("latest snapshots require paper mode");
    if (!options.latest && !options.session) throw new Error("session is required");
    const head = options.latest ? await this.header() : null;
    const date = options.session ?? newYorkDate(head!.time), time = head?.time ?? sessionTime(date);
    if (options.session && !isTradingDay(options.session)) throw new Error("session is not a trading day");
    const key = head ? `${date}-${head.block}` : date;
    const lanes = this.config.lanes.filter(l => !options.lane || l.lane === options.lane.toLowerCase());
    if (!lanes.length) throw new Error("unknown lane");
    const settled = await Promise.allSettled(lanes.map(lane => this.runLane(lane, { date, key, time, block: head?.block, missed: options.missed })));
    const failed = settled.find(v => v.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    return settled.flatMap(v => v.status === "fulfilled" ? [v.value] : []);
  }
  async runLane(lane: LaneConfig, session: { date: string; key: string; time: number; block?: number; missed?: boolean }): Promise<Journal> {
    await this.initialize();
    if (this.busyLanes.has(lane.lane)) throw new Error("lane is already active in this process");
    this.busyLanes.add(lane.lane);
    try { return await withLaneLock(this.config.dataDir, lane.lane, async () => {
      const path = sessionPath(this.config.dataDir, session.key, lane.lane);
      const old = await readJson<Journal>(path);
      const journal = old ?? newJournal(lane, { ...session, mode: this.config.mode, now: this.now() });
      if (journal.final) return journal;
      if (!old) await this.save(journal);
      if (!journal.record) {
        if (session.missed) {
          if (this.config.mode === "paper") { journal.errors.push("harness-missed"); journal.stage = "final"; journal.final = true; await this.save(journal); return journal; }
          journal.recordError = "harness-missed"; journal.response = { used: null, attempts: [] }; await this.save(journal);
        } else {
          if (!journal.snapshot) {
            const block = session.block ?? await blockAtTime(this.rpc, journal.time, { sleep: this.sleep });
            const prior = this.config.factory === null ? await this.paperState(lane) : null;
            const snapshotRpc: ReadRpc = { request: async <T>(method: string, params: unknown[]) => {
              try { return await this.rpc.request<T>(method, params); } catch (error) { throw new SnapshotUnavailable(safeError(error)); }
            } };
            try {
              journal.snapshot = await (this.options.snapshot ?? collectSnapshot)({ rpc: snapshotRpc, config: this.config, lane, block,
                ledger: prior?.ledger, history: prior?.history, openedTime: prior?.openedTime, fetch: this.fetcher });
            } catch (error) {
              if (!(error instanceof SnapshotUnavailable) || this.config.mode !== "send") throw error;
              const failuresPath = join(this.config.dataDir, "snapshot-failures.json");
              const failures = await readJson<{ sessions: string[] }>(failuresPath) ?? { sessions: [] };
              if (!failures.sessions.includes(journal.key)) failures.sessions.push(journal.key);
              await atomicJson(failuresPath, failures);
              if (failures.sessions.length > 1) throw new HarnessStop(6, { block, error: safeError(error), sessions: failures.sessions });
              journal.recordError = "harness-missed"; journal.response = { used: null, attempts: [] };
              journal.errors.push(safeError(error));
            }
            if (journal.snapshot) {
              const prompt = buildPrompt(journal.snapshot.snapshot, journal.snapshot);
              journal.request = { ...prompt, params: { provider: this.config.models[lane.model].provider, model: lane.model,
                effort: "high", maxOutputTokens: 64000, stream: true } };
            }
            journal.stage = "snapshot"; await this.save(journal);
          }
          if (!journal.response) {
            if (inputBytes(journal.snapshot!.snapshot, journal.request!) > MAX_INPUT_BYTES) {
              journal.recordError = "input-too-large"; journal.response = { used: null, attempts: [] }; await this.save(journal);
            } else {
              await this.preventDuplicate(journal);
              await this.collectResponse(journal, lane);
            }
          }
        }
        await this.makeRecord(journal, lane);
        await this.fault(journal, "after-record");
      }
      if (this.config.mode === "paper") await this.paperFill(journal, lane);
      else await this.advance(journal, lane);
      return journal;
    }); } finally { this.busyLanes.delete(lane.lane); }
  }
  private async preventDuplicate(journal: Journal): Promise<void> {
    const response = await this.fetcher(this.config.publicBase + "/d/lanes.json");
    if (!response.ok) throw new Error("indexed lane guard unavailable");
    const value = await response.json() as any;
    const known = new Set((await listJournals(this.config.dataDir)).filter(j => j.lane === journal.lane).map(j => j.record?.h).filter(Boolean));
    const lane = value.lanes?.find((l: any) => l.address === journal.lane);
    if (lane?.decisions?.some((d: any) => d.sealed?.time >= journal.time && !known.has(d.h))) {
      journal.errors.push("session-already-sealed"); await this.save(journal); throw new Error("session-already-sealed");
    }
  }
  private async collectResponse(journal: Journal, lane: LaneConfig): Promise<void> {
    const model = this.config.models[lane.model];
    for (const attempt of journal.attempts) {
      if (attempt.finished !== undefined) continue;
      let raw: Uint8Array; try { raw = await readFile(attempt.raw); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; raw = new Uint8Array(); }
      attempt.result = recoverAttempt(raw, model.provider, { bytesRead: attempt.bytesRead }); attempt.finished = this.now(); await this.save(journal);
    }
    let failure: RecordError = "parse-failed", terminal = false;
    // A crash between persisting a completed attempt and the response marker must not spend another request.
    for (let index = 0; index < journal.attempts.length; index++) {
      const result = journal.attempts[index].result!;
      if (result.error === "model-unavailable" || result.error === "refusal") { failure = result.error; terminal = true; break; }
      const status = journal.attempts[index].httpStatus;
      if (status !== undefined && status !== null && status >= 400 && status < 500 && status !== 429) throw new HarnessStop(1, { model: lane.model, httpStatus: status, error: result.error });
      if (result.completed && !result.error) {
        const decision = parseDecision(result.text, journal.snapshot!.snapshot.assets.map(a => a.symbol));
        if (decision) { journal.decision = decision; journal.response = { used: index + 1, attempts: journal.attempts.map(a => a.result!) }; break; }
      }
    }
    if (journal.response) { journal.stage = "response"; await this.save(journal); return; }
    while (!terminal && retryBudget(journal.attempts.map(a => a.result!)).available) {
      const n = journal.attempts.length + 1, reservation = `${sha256Hex(Buffer.from(this.config.dataDir))}:${journal.key}:${lane.lane}:${n}`;
      try { this.budget.reserve({ id: reservation, model: lane.model,
        inputTokensBound: Buffer.byteLength(journal.request!.system + journal.request!.user) + 1024, maxOutputTokens: 64000 }); }
      catch (error) { if (error instanceof BudgetLimit) throw new HarnessStop(5, this.budget.summary()); throw error; }
      const raw = join(this.config.dataDir, "sessions", journal.key, `${lane.lane}.attempt-${n}.raw`);
      const attempt: Journal["attempts"][number] = { started: this.now(), raw, reservation };
      journal.attempts.push(attempt); journal.stage = `attempt:${n}`; await this.save(journal);
      const result = await (this.options.model ?? runModelAttempt)({ provider: model.provider, model: lane.model,
        system: journal.request!.system, user: journal.request!.user, rawPath: raw, effort: "high", maxOutputTokens: 64000,
        baseURL: this.endpoints[model.provider],
        onChunk: async progress => { attempt.bytesRead = progress.bytesRead; await this.save(journal); await this.options.onAttemptChunk?.(journal, progress); } });
      attempt.result = attemptRecord(result); attempt.finished = this.now(); attempt.durationMs = result.durationMs; attempt.httpStatus = result.httpStatus;
      if (!result.requestSent || result.httpStatus !== null && result.httpStatus >= 400 && result.httpStatus < 500) this.budget.release(reservation);
      else this.budget.settle(reservation, result.usage);
      await this.save(journal);
      this.log({ lane: lane.lane, stage: journal.stage, h: null, tx: null, usage: result.usage, cost: this.budget.summary(), durationMs: result.durationMs });
      const classification = classifyAttempt(result);
      if (classification === "fatal") throw new HarnessStop(1, { model: lane.model, httpStatus: result.httpStatus, error: result.error });
      if (classification === "model-unavailable" || classification === "refusal") { failure = classification; break; }
      if (classification === "success") {
        const parsed = parseDecision(result.text, journal.snapshot!.snapshot.assets.map(a => a.symbol));
        if (parsed) { journal.decision = parsed; journal.response = { used: n, attempts: journal.attempts.map(a => a.result!) }; break; }
        attempt.result.error = "parse-failed"; await this.save(journal);
      }
      if (!retryBudget(journal.attempts.map(a => a.result!)).available) break;
      await this.sleep(retryBudget(journal.attempts.map(a => a.result!)).delayMs);
    }
    if (!journal.response) { journal.response = { used: null, attempts: journal.attempts.map(a => a.result!) }; journal.decision = null; journal.recordError = failure; }
    journal.stage = "response"; await this.save(journal);
  }
  private async makeRecord(journal: Journal, lane: LaneConfig): Promise<void> {
    let orders = emptyOrders();
    if (journal.decision) orders = await (this.options.orders ?? buildOrders)({ rpc: this.rpc, snapshot: journal.snapshot!.snapshot,
      listing: journal.snapshot!.listing, lane: lane.lane, agent: lane.agent, quoteBlock: (await this.header()).block,
      decision: journal.decision, virtual: this.config.factory === null });
    const small = journal.recordError === "harness-missed" || journal.recordError === "input-too-large";
    let record;
    try { record = createRecord({ lane, date: journal.date, time: journal.time, harness: this.harness,
      snapshot: small ? null : journal.snapshot?.snapshot, request: small ? null : journal.request,
      response: small ? null : journal.response, decision: journal.decision, orders, error: journal.recordError }); }
    catch (error) { if (error instanceof RecordTooLarge) throw new HarnessStop(6, { lane: lane.lane, bytes: error.bytes }); throw error; }
    const path = await storeRecord(this.config.dataDir, record.h, record.bytes);
    journal.record = { h: record.h, path }; journal.stage = "record"; await this.save(journal);
    this.log({ lane: lane.lane, stage: "record", h: record.h, tx: null, bytes: record.bytes.length, cost: this.budget.summary() });
  }
  private async record(journal: Journal): Promise<HarnessRecord> {
    const bytes = await readFile(journal.record!.path);
    if (sha256Hex(bytes) !== journal.record!.h) throw new Error("immutable record hash mismatch");
    return JSON.parse(bytes.toString()) as HarnessRecord;
  }
  private async sealState(journal: Journal) {
    const state = await (this.options.laneState ?? readLaneState)(this.rpc, journal.lane, [], (await this.header()).block, [journal.record!.h]);
    return state.seals[journal.record!.h];
  }
  private async quotes(journal: Journal, record: HarnessRecord): Promise<void> {
    const block = (await this.header()).block;
    const error = await (this.options.executionQuotes ?? checkExecutionQuotes)({ rpc: this.rpc, listing: journal.snapshot!.listing,
      lane: journal.lane, legs: record.orders.legs, block });
    if (error) throw new KnownExecutionFailure("quote", error);
  }
  private execution(journal: Journal, stage: "simulation" | "quote" | "estimate" | "chain" | "late", error: ExecutionError, tx: string | null = null): void {
    if (journal.execution) return;
    journal.execution = redactValue({ schema: "holdout.execution/1", h: journal.record!.h, lane: journal.lane, outcome: "reverted", stage, error, tx });
    journal.stage = "x";
  }
  private async chainError(transaction: TransactionState): Promise<ExecutionError> {
    try { await this.rpc.request("eth_call", [{ from: transaction.signed.from, to: transaction.signed.to, data: transaction.signed.data, value: hex(Number(transaction.signed.value)) }, hex(Math.max(0, transaction.receipt!.blockNumber - 1))]); }
    catch (error) { const data = revertData(error); if (data !== null) return decodeRevert(data); }
    return { name: "Reverted", args: [] };
  }
  private async transact(journal: Journal, lane: LaneConfig, record: HarnessRecord, kind: "seal" | "trade"): Promise<void> {
    let transaction = journal.transactions.find(t => t.kind === kind && !t.abandoned);
    if (!transaction) {
      const state = await this.sealState(journal);
      if (kind === "trade" && state?.acted || kind === "seal" && state?.at) return;
      const data = kind === "seal" ? encodeFunctionData({ abi: LANE_ABI, functionName: "seal", args: [journal.record!.h as `0x${string}`, record.orders.legsHash as `0x${string}`] })
        : encodeFunctionData({ abi: LANE_ABI, functionName: "trade", args: [journal.record!.h as `0x${string}`, record.orders.legs.map(l => ({ pool: BigInt(l.pool), buy: l.buy, amountIn: BigInt(l.amountIn), minOut: BigInt(l.minOut) }))] });
      let delay = 2000;
      while (true) {
        if (kind === "trade" && lane.review === "auto" && (await this.header()).time > journal.time + 1800) {
          this.execution(journal, "late", { name: "HarnessLate", args: [] }); await this.save(journal); return;
        }
        const prepared = await this.sender.prepare({ to: lane.lane, from: lane.agent, data, keyFile: lane.keyFile,
          beforeEstimate: kind === "trade" ? () => this.quotes(journal, record) : undefined });
        if (prepared.reverted) {
          if (kind === "trade") throw new KnownExecutionFailure("estimate", prepared.error);
          throw new Error(`seal estimate reverted: ${prepared.error.name}`);
        }
        if (prepared.temporary) { journal.errors.push(safeError(prepared.error)); await this.save(journal); await this.sleep(delay); delay = Math.min(60_000, delay * 2); continue; }
        transaction = { kind, signed: prepared.signed, signedAt: this.now() };
        journal.transactions.push(transaction); journal.stage = `tx:${kind}`; await this.save(journal);
        await this.fault(journal, "after-sign"); break;
      }
    }
    if (transaction.receipt) return;
    const receipt = await this.sender.receipt(transaction.signed.hash);
    if (receipt) transaction.receipt = receipt;
    else {
      if (kind === "trade" && lane.review === "auto" && transaction.sentAt === undefined && (await this.header()).time > journal.time + 1800) {
        const known = await this.sender.request("eth_getTransactionByHash", [transaction.signed.hash]);
        if (!known) {
          transaction.abandoned = true; this.execution(journal, "late", { name: "HarnessLate", args: [] }); await this.save(journal); return;
        }
      }
      try {
        await this.sender.broadcast(transaction.signed, { beforeBroadcast: kind === "trade" ? () => this.quotes(journal, record) : undefined });
        transaction.sentAt = this.now(); await this.save(journal); await this.fault(journal, "after-broadcast");
        transaction.receipt = await this.sender.wait(transaction.signed, { beforeBroadcast: kind === "trade" ? () => this.quotes(journal, record) : undefined });
      } catch (error) {
        if (error instanceof KnownExecutionFailure) { transaction.abandoned = true; await this.save(journal); }
        throw error;
      }
    }
    journal.stage = `receipt:${kind}`; await this.save(journal);
    this.log({ lane: lane.lane, stage: journal.stage, h: journal.record!.h, tx: transaction.signed.hash, status: transaction.receipt.status });
    if (kind === "trade" && transaction.receipt.status === 0) {
      this.execution(journal, "chain", await this.chainError(transaction), transaction.signed.hash); await this.save(journal);
    }
  }
  private async refreshReceipts(journal: Journal, record: HarnessRecord): Promise<void> {
    for (const transaction of journal.transactions.filter(t => !t.abandoned).sort((a, b) => Number(BigInt(a.signed.nonce) - BigInt(b.signed.nonce)))) {
      if (!transaction.receipt) continue;
      const current = await this.sender.receipt(transaction.signed.hash);
      if (current && current.blockHash === transaction.receipt.blockHash) continue;
      delete transaction.receipt; delete journal.recordPublication.verifiedAt; delete journal.executionPublication.verifiedAt; await this.save(journal);
      try {
        await this.sender.broadcast(transaction.signed, { beforeBroadcast: transaction.kind === "trade" ? () => this.quotes(journal, record) : undefined });
        transaction.sentAt = this.now(); await this.save(journal);
        transaction.receipt = await this.sender.wait(transaction.signed, { beforeBroadcast: transaction.kind === "trade" ? () => this.quotes(journal, record) : undefined });
        if (transaction.kind === "trade" && transaction.receipt.status === 0) this.execution(journal, "chain", await this.chainError(transaction), transaction.signed.hash);
      } catch (error) {
        if (error instanceof KnownExecutionFailure) { transaction.abandoned = true; this.execution(journal, error.stage, error.detail); }
        else throw error;
      }
      await this.save(journal);
    }
  }
  private async advance(journal: Journal, lane: LaneConfig): Promise<void> {
    const record = await this.record(journal);
    await this.refreshReceipts(journal, record);
    // A persisted review trade is already authorized, including when the CLI died before broadcasting it.
    if (lane.review !== "auto" && journal.transactions.some(tx => tx.kind === "trade" && !tx.abandoned && !tx.receipt)) {
      try { await this.transact(journal, lane, record, "trade"); }
      catch (error) { if (error instanceof KnownExecutionFailure) this.execution(journal, error.stage, error.detail); else throw error; }
      await this.save(journal);
    }
    const failed = journal.transactions.find(tx => tx.kind === "trade" && !tx.abandoned && tx.receipt?.status === 0);
    if (failed && !journal.execution) { this.execution(journal, "chain", await this.chainError(failed), failed.signed.hash); await this.save(journal); }
    const simulationFailed = record.orders.simulation.result === "failed";
    const canTrade = record.orders.legs.length > 0 && !simulationFailed;
    if (simulationFailed) this.execution(journal, "simulation", record.orders.simulation.error!);
    if (lane.review === "auto" && canTrade && !journal.execution) {
      try { await this.transact(journal, lane, record, "trade"); }
      catch (error) { if (error instanceof KnownExecutionFailure) this.execution(journal, error.stage, error.detail); else throw error; }
      await this.save(journal);
    }
    if (lane.review !== "auto" || !canTrade || journal.execution) await this.transact(journal, lane, record, "seal");
    if (lane.review !== "auto" && canTrade && !journal.execution) {
      const state = await this.sealState(journal), head = await this.header();
      if (state?.acted) {
        if (journal.review?.state === "skipped" || journal.review?.state === "auto-skipped") journal.errors.push("chain-overrides-review");
        journal.review = { state: "sent", time: head.time, chainOverride: true };
      } else if (!journal.review || journal.review.state === "pending") {
        if (head.time > state.at + journal.snapshot!.listing.actWindow) journal.review = { state: "auto-skipped", time: head.time };
        else if (!journal.review) journal.review = { state: "pending", time: head.time };
      }
      journal.stage = "review"; await this.save(journal);
    }
    if (journal.execution && journal.review?.state === "pending") { journal.review = { state: "sent", time: (await this.header()).time }; await this.save(journal); }
    if (journal.review?.state === "pending") return;
    await publish(this.config, journal, { now: this.now, fetch: this.fetcher, save: () => this.save(journal) });
    if (journal.recordPublication.verifiedAt === undefined || journal.execution && journal.executionPublication.verifiedAt === undefined) return;
    const finalized = await this.header("finalized");
    for (const transaction of journal.transactions.filter(t => !t.abandoned)) {
      if (!transaction.receipt || transaction.receipt.blockNumber > finalized.block) return;
      if ((await this.header(transaction.receipt.blockNumber)).hash !== transaction.receipt.blockHash) return;
    }
    journal.stage = "final"; journal.final = true; await this.save(journal);
  }
  async resume(): Promise<Journal[]> {
    await this.initialize(); const result: Journal[] = [];
    for (const journal of await listJournals(this.config.dataDir)) {
      if (journal.final || this.busyLanes.has(journal.lane)) continue;
      const lane = this.config.lanes.find(l => l.lane === journal.lane); if (!lane) throw new Error("journal lane missing from configuration");
      result.push(await this.runLane(lane, { date: journal.date, key: journal.key, time: journal.time }));
    }
    return result;
  }
  async reviews(): Promise<unknown[]> {
    await this.initialize(); const result: unknown[] = [];
    for (const journal of await listJournals(this.config.dataDir)) {
      if (journal.review?.state !== "pending" || !journal.record) continue;
      const state = await this.sealState(journal), record = await this.record(journal);
      result.push({ lane: journal.lane, model: journal.model, h: journal.record.h, sealedAt: state.at,
        remainingSeconds: Math.max(0, state.at + journal.snapshot!.listing.actWindow - (await this.header()).time),
        weights: record.decision?.weights, reason: record.decision?.reason, legs: record.orders.legs, simulation: record.orders.simulation });
    }
    return result;
  }
  async review(h: string, action: "send" | "skip"): Promise<Journal> {
    await this.initialize(); if (this.config.mode !== "send") throw new Error("review requires send mode");
    const found = (await listJournals(this.config.dataDir)).find(j => j.record?.h === h);
    if (!found) throw new Error("review record not found");
    return withLaneLock(this.config.dataDir, found.lane, async () => {
      const journal = (await readJson<Journal>(sessionPath(this.config.dataDir, found.key, found.lane)))!;
      if (journal.review?.state !== "pending") throw new Error("review is not pending");
      const lane = this.config.lanes.find(l => l.lane === journal.lane)!, state = await this.sealState(journal), head = await this.header();
      if (state.acted) { journal.review = { state: "sent", time: head.time, chainOverride: true }; journal.errors.push("chain-overrides-review"); await this.save(journal); throw new Error("review already acted on chain"); }
      if (head.time >= state.at + journal.snapshot!.listing.actWindow - 60) throw new Error("review window has less than sixty seconds");
      const record = await this.record(journal);
      if (action === "skip") journal.review = { state: "skipped", time: head.time };
      else {
        try { await this.transact(journal, lane, record, "trade"); }
        catch (error) { if (error instanceof KnownExecutionFailure) this.execution(journal, error.stage, error.detail); else throw error; }
        journal.review = { state: "sent", time: (await this.header()).time };
      }
      await this.save(journal); await this.advance(journal, lane); return journal;
    });
  }
  private async paperState(lane: LaneConfig): Promise<{ ledger: Record<string, string>; history: any[]; openedTime?: number }> {
    const saved = await readJson<{ ledger: Record<string, string>; applied: string[]; openedTime: number }>(join(this.config.dataDir, "paper", "ledger", lane.model + ".json"));
    const previous = (await listJournals(this.config.dataDir)).filter(j => j.lane === lane.lane && j.record && j.final)
      .sort((a, b) => b.time - a.time || (b.snapshot?.snapshot.block ?? 0) - (a.snapshot?.snapshot.block ?? 0));
    const history: any[] = [];
    for (const old of previous) { const record = await this.record(old); if (record.decision) history.push({ date: old.date, ...record.decision }); if (history.length === 3) break; }
    return { ledger: saved?.ledger ?? { [ADDRESSES.usdg]: "1000000000" }, history, openedTime: saved?.openedTime };
  }
  private async paperFill(journal: Journal, lane: LaneConfig): Promise<void> {
    const record = await this.record(journal), ledgerPath = join(this.config.dataDir, "paper", "ledger", lane.model + ".json");
    const old = await readJson<{ ledger: Record<string, string>; applied: string[]; openedTime: number }>(ledgerPath);
    const ledger = { ...(journal.snapshot?.snapshot.ledger ?? old?.ledger ?? { [ADDRESSES.usdg]: "1000000000" }) };
    const fills: unknown[] = [];
    if (this.config.factory === null) {
      for (const leg of record.orders.legs) {
        const asset = journal.snapshot!.listing.assets.find(a => a.symbol === leg.symbol)!;
        const tokenIn = leg.buy ? ADDRESSES.usdg : asset.token, tokenOut = leg.buy ? asset.token : ADDRESSES.usdg;
        const amount = BigInt(leg.amountIn) === MAX ? BigInt(ledger[tokenIn] ?? "0") : BigInt(leg.amountIn);
        if (BigInt(ledger[tokenIn] ?? "0") < amount) throw new Error("paper ledger has insufficient balance");
        ledger[tokenIn] = (BigInt(ledger[tokenIn] ?? "0") - amount).toString();
        ledger[tokenOut] = (BigInt(ledger[tokenOut] ?? "0") + BigInt(leg.quoteOut)).toString();
        fills.push({ label: "paper fill", ...leg, amountIn: amount.toString() });
      }
      if (!old?.applied.includes(journal.record!.h)) await atomicJson(ledgerPath, { ledger, applied: [...(old?.applied ?? []), journal.record!.h], openedTime: old?.openedTime ?? journal.time });
    }
    await atomicJson(join(this.config.dataDir, "paper", journal.key, lane.lane + ".json"), { h: journal.record!.h, record, fills, ledgerAfter: ledger });
    journal.final = true; journal.stage = "final"; await this.save(journal);
  }
}
