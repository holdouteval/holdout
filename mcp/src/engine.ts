import {
  ADDRESSES, LANE_ABI, assess, buildOrders, checkExecutionQuotes, emptyOrders, readFactory, readLaneState, readHeader,
  canonicalize, sha256Hex, encodeFunctionData, decodeRevert, revertData, safeError, NonceConflictError,
  blockAtTime, decodeEvent, type RpcLog, type Orders, type OrderListing, type SendReceipt, type ExecutionError,
} from "@holdout/core";
import { createAgentRecord, redactValue } from "./record.js";
import { strictWeights } from "./weights.js";
import { AgentBusy, isOpen, readJournal, saveJournal, storeRecord, withAgentLock, type Journal, type JournalEntry } from "./journal.js";
import { advanceUpload } from "./upload.js";
import type { DecisionEngineOptions, DecisionInput, SealInput, DecisionResult, ToolError } from "./types.js";

export interface EngineDependencies extends DecisionEngineOptions {
  read?: { header?: typeof readHeader; factory?: typeof readFactory; lane?: typeof readLaneState;
    assess?: typeof assess; orders?: typeof buildOrders; quotes?: typeof checkExecutionQuotes };
  responseMs?: number; pumpMs?: number;
}
class Refusal extends Error {
  constructor(readonly detail: ToolError) { super(detail.code); }
}
interface Work { started: number; cancelled: boolean; entry?: JournalEntry; prior: boolean; replay?: JournalEntry; conflict?: boolean }
const hex = (number: number) => "0x" + number.toString(16);
const blank = (state: DecisionResult["state"], error: ToolError | null = null): DecisionResult => ({
  state, h: null, tx: null, legs: [], dropped: [], simulation: null, upload: null, recordUrl: null, error,
});
const failure = (code: string, detail?: ExecutionError): Refusal => new Refusal({ code, ...(detail ? { name: detail.name, args: detail.args } : {}) });
const asError = (error: unknown): ToolError => error instanceof Refusal ? error.detail : { code: "rpc-unavailable", message: safeError(error) };

export class DecisionEngine {
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private tasks = new Set<Promise<unknown>>();
  private cached: JournalEntry[] = [];
  private boundary?: Promise<{ local: boolean; chainId: 4663 }>;
  private stopped = false;
  constructor(readonly options: EngineDependencies) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  }
  private log(error: unknown) { this.options.logger?.(safeError(error)); }
  private track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task); void task.finally(() => this.tasks.delete(task)).catch(() => {}); return task;
  }
  async start(): Promise<void> {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { if (!this.stopped) void this.track(this.recover()).catch(error => this.log(error)); }, this.options.pumpMs ?? 30_000);
    this.timer.unref();
    void this.track(this.recover()).catch(error => this.log(error));
  }
  stop(): void { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  private async save(journal: Journal): Promise<void> {
    for (const entry of journal.entries) {
      entry.result.h = entry.h; entry.result.tx = entry.signed?.hash ?? entry.receipt?.transactionHash ?? null;
      entry.result.upload = { ...entry.upload };
      entry.result = redactValue(entry.result);
    }
    await saveJournal(this.options.config.home, journal);
    this.cached = structuredClone(journal.entries);
  }
  private assertLive(work: Work): void {
    if (work.cancelled || this.now() - work.started >= (this.options.responseMs ?? 49_000)) throw failure("rpc-unavailable");
  }
  private async fault(point: string): Promise<void> {
    if (process.env.HOLDOUT_MCP_FAULT !== point) return;
    this.boundary ??= this.options.sender.assertBoundary();
    if ((await this.boundary).local) process.kill(process.pid, "SIGKILL");
    else this.log("fault injection ignored outside guarded local anvil");
  }
  private async closeUnsent(journal: Journal, entry: JournalEntry, error: ToolError, state: "refused" | "not-sent" = "refused"): Promise<void> {
    if (entry.broadcastAttemptedAt !== undefined) return;
    entry.stage = "not-sent"; entry.error = redactValue(error);
    entry.result.state = state; entry.result.error = entry.error ?? null;
    await this.save(journal);
  }
  async pending(): Promise<unknown[]> {
    const present = (entries: JournalEntry[]) => entries.filter(entry => !["verified", "not-sent", "failed"].includes(entry.stage))
      .map(entry => ({ requestId: entry.requestId, h: entry.h, stage: entry.stage, tx: entry.signed?.hash ?? null, upload: entry.upload }));
    try { return await withAgentLock(this.options.config.home, this.options.identity.agent, async () => present((await readJournal(this.options.config.home, this.options.config.lane)).entries)); }
    catch (error) { if (error instanceof AgentBusy) return present(this.cached); throw error; }
  }
  decide(input: DecisionInput): Promise<DecisionResult> { return this.call("holdout_decide", input); }
  seal(input: SealInput): Promise<DecisionResult> { return this.call("holdout_seal", input); }
  private async call(tool: "holdout_decide" | "holdout_seal", input: DecisionInput | SealInput): Promise<DecisionResult> {
    const work: Work = { started: this.now(), cancelled: false, prior: false };
    try {
      if (!input || !/^[A-Za-z0-9._:-]{1,64}$/.test(input.requestId) || typeof input.model !== "string" || [...input.model].length < 1 || [...input.model].length > 200
        || typeof input.input !== "string" || typeof input.output !== "string") throw failure("invalid-input");
      try { canonicalize({ model: input.model, input: input.input, output: input.output }); } catch { throw failure("invalid-text"); }
    } catch (error) { return blank("refused", asError(error)); }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const task = this.track(withAgentLock(this.options.config.home, this.options.identity.agent, async () => {
      const journal = await readJournal(this.options.config.home, this.options.config.lane);
      try {
        const prior = [...journal.entries].reverse().find(entry => entry.requestId === redactValue(input.requestId));
        if (prior && isOpen(prior)) {
          const weights = tool === "holdout_decide" ? this.weights((input as DecisionInput).weights, prior.listing) : null;
          const digest = sha256Hex(canonicalize({ tool, weights, model: input.model, input: input.input, output: input.output }));
          if (prior.requestDigest === digest) work.replay = prior; else work.conflict = true;
        }
        work.prior = true;
        await this.resume(journal, work);
        work.prior = false; work.entry = undefined;
        this.assertLive(work);
        const id = redactValue(input.requestId) as string;
        const previous = [...journal.entries].reverse().find(entry => entry.requestId === id);
        if (previous) {
          const weights = tool === "holdout_decide" ? this.weights((input as DecisionInput).weights, previous.listing) : null;
          const digest = sha256Hex(canonicalize({ tool, weights, model: input.model, input: input.input, output: input.output }));
          if (previous.requestDigest !== digest) return blank("refused", { code: "request-id-conflict" });
          if (!['failed', 'not-sent'].includes(previous.stage)) return { ...previous.result, replayed: true as const };
        }
        const existing = journal.entries.find(isOpen);
        if (existing) return { ...existing.result, state: "busy" as const, error: { code: "busy" } };
        if (!this.options.key) throw failure("agent-key-missing");
        if (!this.options.config.dataBase) throw failure("data-base-missing");
        if (this.options.key.address !== this.options.identity.agent) throw failure("agent-key-mismatch");
        const header = await (this.options.read?.header ?? readHeader)(this.options.rpc); this.assertLive(work);
        const factory = await (this.options.read?.factory ?? readFactory)(this.options.rpc, this.options.identity.factory, header.block); this.assertLive(work);
        const listing: OrderListing = { maxAge: factory.maxAge, actWindow: factory.actWindow,
          assets: factory.assets.map(asset => {
            if (!asset.symbol) throw failure("unknown-asset");
            return { assetId: asset.assetId, symbol: asset.symbol, token: asset.token, feed: asset.feed, pools: factory.pools.filter(pool => pool.token === asset.token) };
          }) };
        const lane = await (this.options.read?.lane ?? readLaneState)(this.options.rpc, this.options.config.lane, [ADDRESSES.usdg, ...listing.assets.map(asset => asset.token)], header.block); this.assertLive(work);
        if (lane.status !== 1) throw failure("lane-not-open");
        if (lane.agent !== this.options.key.address) throw failure("agent-key-mismatch");
        const market = await (this.options.read?.assess ?? assess)({ rpc: this.options.rpc, listing, lane: this.options.config.lane,
          block: header.block, accessRegistry: factory.accessRegistry, time: header.time }); this.assertLive(work);
        const ledger = Object.fromEntries(Object.entries(lane.ledger).map(([token, value]) => [token, value.toString()]));
        let value = lane.ledger[ADDRESSES.usdg] ?? 0n;
        for (const asset of market.assets) value += (lane.ledger[asset.token] ?? 0n) * BigInt(asset.answer) / 10n ** 20n;
        const weights = tool === "holdout_decide" ? this.weights((input as DecisionInput).weights, listing) : null;
        const orders = weights === null ? emptyOrders() : await (this.options.read?.orders ?? buildOrders)({ rpc: this.options.rpc,
          listing, snapshot: { ledger, value: value.toString(), blocked: market.blocked, assets: market.assets }, lane: this.options.config.lane,
          agent: this.options.identity.agent, quoteBlock: header.block, decision: { weights } });
        this.assertLive(work);
        if (orders.simulation.result === "failed") throw failure("simulation-reverted", orders.simulation.error!);
        const record = createAgentRecord({ lane: this.options.config.lane, agent: this.options.identity.agent, time: header.time,
          blocked: market.blocked, model: input.model, input: input.input, output: input.output, weights, orders });
        const requestDigest = sha256Hex(canonicalize({ tool, weights, model: input.model, input: input.input, output: input.output }));
        this.assertLive(work);
        await storeRecord(this.options.config.home, this.options.config.lane, record.h, record.bytes);
        const entry: JournalEntry = { requestId: id, requestDigest, h: record.h, kind: orders.legs.length ? "trade" : "seal", stage: "record", recordAt: this.now(),
          listing, orders, upload: { state: "waiting" }, result: { ...blank("pending"), h: record.h,
            legs: orders.legs.map(({ symbol, buy, amountIn, minOut, quoteOut }) => ({ symbol, buy, amountIn, minOut, quoteOut })), dropped: orders.dropped, simulation: orders.simulation,
            recordUrl: this.options.config.dataBase.replace(/\/$/, "") + "/r/" + record.h + ".json" } };
        journal.entries.push(entry); work.entry = entry; await this.save(journal); await this.fault("after-record");
        this.assertLive(work);
        const known = await (this.options.read?.lane ?? readLaneState)(this.options.rpc, this.options.config.lane, [], (await (this.options.read?.header ?? readHeader)(this.options.rpc)).block, [entry.h]);
        this.assertLive(work);
        if (known.seals[entry.h]?.at) {
          await this.existingSeal(journal, entry, known.seals[entry.h].at, known.seals[entry.h].acted);
          return entry.result;
        }
        await this.prepare(journal, entry, work);
        if (entry.stage === "not-sent") return entry.result;
        await this.send(journal, entry, work);
        return entry.result;
      } catch (error) {
        const detail = error instanceof Error && ["invalid-weights", "invalid-text", "record-too-large"].includes(error.message) ? { code: error.message } : asError(error);
        if (work.entry && work.entry.broadcastAttemptedAt === undefined) await this.closeUnsent(journal, work.entry, detail);
        else if (work.entry) { this.log(error); return work.entry.result; }
        return work.entry?.result ?? blank("refused", detail);
      }
    })).catch(error => error instanceof AgentBusy ? blank("busy", { code: "busy" }) : blank("refused", asError(error)));
    const timeout = new Promise<DecisionResult>(resolve => {
      timer = setTimeout(() => {
        const preview = (entry: JournalEntry): DecisionResult => ({ ...entry.result,
          state: entry.receipt ? entry.receipt.status === 0 ? "failed" : entry.kind === "trade" ? "executed" : "held" : "pending",
          error: entry.receipt?.status === 0 ? entry.error ?? { code: "chain-reverted", name: "Reverted", args: [] } : entry.result.error });
        if (work.prior && work.conflict) { resolve(blank("refused", { code: "request-id-conflict" })); return; }
        if (work.prior && work.replay?.broadcastAttemptedAt !== undefined) {
          resolve({ ...preview(work.replay), replayed: true }); return;
        }
        const entry = work.entry;
        if (entry?.broadcastAttemptedAt !== undefined) resolve(work.prior ? { ...entry.result, state: "busy", error: { code: "busy" } } : preview(entry));
        else { work.cancelled = true; resolve(blank("refused", { code: "rpc-unavailable" })); }
      }, this.options.responseMs ?? 49_000);
    });
    try { return redactValue(await Promise.race([task, timeout])); }
    finally { if (timer) clearTimeout(timer); }
  }
  private weights(raw: unknown, listing: OrderListing): Record<string, string> {
    try { return strictWeights(raw, listing.assets.map(asset => asset.symbol)); } catch { throw failure("invalid-weights"); }
  }
  private async quotes(entry: JournalEntry): Promise<void> {
    if (entry.kind !== "trade") return;
    const header = await (this.options.read?.header ?? readHeader)(this.options.rpc);
    const error = await (this.options.read?.quotes ?? checkExecutionQuotes)({ rpc: this.options.rpc, listing: entry.listing,
      lane: this.options.config.lane, legs: entry.orders.legs, block: header.block });
    if (error) throw failure(error.name === "QuoteMoved" ? "quote-moved" : "quote-unavailable", error);
  }
  private async prepare(journal: Journal, entry: JournalEntry, work: Work): Promise<void> {
    const data = encodeFunctionData({ abi: LANE_ABI, functionName: entry.kind === "trade" ? "trade" : "seal", args: entry.kind === "trade"
      ? [entry.h as `0x${string}`, entry.orders.legs.map(leg => ({ pool: BigInt(leg.pool), buy: leg.buy, amountIn: BigInt(leg.amountIn), minOut: BigInt(leg.minOut) }))]
      : [entry.h as `0x${string}`, ("0x" + "0".repeat(64)) as `0x${string}`] } as any);
    const delays = [2000, 4000, 8000, 16000]; let retry = 0;
    for (;;) {
      this.assertLive(work);
      if (retry > 0 && this.now() - work.started >= 30_000) throw failure("rpc-unavailable");
      let prepared;
      try { prepared = await this.options.sender.prepare({ from: this.options.identity.agent, to: this.options.config.lane, data,
        keyFile: this.options.key!.path, beforeEstimate: () => this.quotes(entry) }); }
      catch (error) { if (error instanceof Refusal) throw error; prepared = { reverted: false as const, temporary: true as const, error: safeError(error) }; }
      this.assertLive(work);
      if (prepared.reverted) { await this.closeUnsent(journal, entry, { code: "estimate-reverted", name: prepared.error.name, args: prepared.error.args }); return; }
      if (prepared.temporary) {
        const delay = delays[retry++];
        if (delay === undefined || this.now() - work.started + delay >= 30_000) throw failure("rpc-unavailable");
        await this.sleep(delay); continue;
      }
      const balance = BigInt(await this.options.rpc.request<string>("eth_getBalance", [this.options.identity.agent, "latest"]));
      this.assertLive(work);
      if (balance < BigInt(prepared.signed.gas) * BigInt(prepared.signed.maxFeePerGas)) { await this.closeUnsent(journal, entry, { code: "agent-gas" }); return; }
      entry.signed = prepared.signed; entry.signedAt = this.now(); entry.stage = "signed";
      await this.save(journal); await this.fault("after-sign"); return;
    }
  }
  private async send(journal: Journal, entry: JournalEntry, work?: Work): Promise<void> {
    if (!entry.signed) return;
    if (entry.broadcastAttemptedAt === undefined) {
      if (this.now() - (entry.signedAt ?? 0) > 120_000) throw failure("stale");
      const delays = [2000, 4000, 8000, 16000]; let retry = 0;
      for (;;) {
        try { await this.quotes(entry); break; }
        catch (error) {
          if (error instanceof Refusal || !work) throw error;
          const delay = delays[retry++];
          if (delay === undefined || this.now() - work.started + delay >= 30_000) throw failure("rpc-unavailable");
          await this.sleep(delay); this.assertLive(work);
        }
      }
      if (work) this.assertLive(work);
      if (this.now() - (entry.signedAt ?? 0) > 120_000) throw failure("stale");
      entry.broadcastAttemptedAt = this.now(); entry.stage = "sent"; await this.save(journal);
    }
    try {
      await this.options.sender.broadcast(entry.signed);
      entry.sentAt = this.now(); entry.stage = "sent"; await this.save(journal); await this.fault("after-broadcast");
      await this.received(journal, entry, await this.options.sender.wait(entry.signed));
    } catch (error) {
      if (error instanceof NonceConflictError) {
        // The original can be mined between the sender's transaction and nonce reads.
        try {
          const head = await (this.options.read?.header ?? readHeader)(this.options.rpc);
          const used = BigInt(await this.options.sender.request<string>("eth_getTransactionCount", [entry.signed.from, hex(head.block)]));
          const receipt = await this.options.sender.receipt(entry.signed.hash);
          if (receipt) { await this.received(journal, entry, receipt); return; }
          if (used > BigInt(entry.signed.nonce)) {
            entry.stage = "failed"; entry.error = { code: "nonce-conflict" }; entry.result.state = "failed"; entry.result.error = entry.error;
            await this.save(journal); return;
          }
        } catch (readError) { this.log(readError); }
        entry.stage = "sent"; entry.result.state = "pending"; await this.save(journal);
      }
      else { entry.stage = "sent"; entry.result.state = "pending"; await this.save(journal); this.log(error); }
    }
  }
  private async received(journal: Journal, entry: JournalEntry, receipt: SendReceipt): Promise<void> {
    entry.receipt = receipt;
    if (receipt.status === 0) {
      let decoded: ExecutionError = { name: "Reverted", args: [] };
      if (entry.signed) try { await this.options.rpc.request("eth_call", [{ from: entry.signed.from, to: entry.signed.to, data: entry.signed.data, value: hex(Number(entry.signed.value)) }, hex(Math.max(0, receipt.blockNumber - 1))]); }
      catch (error) { const data = revertData(error); if (data !== null) decoded = decodeRevert(data); }
      entry.stage = "failed"; entry.error = { code: "chain-reverted", name: decoded.name, args: decoded.args };
      entry.result.state = "failed"; entry.result.error = entry.error; await this.save(journal); return;
    }
    entry.stage = "receipt"; entry.result.state = entry.kind === "trade" ? "executed" : "held"; entry.result.error = null;
    await this.save(journal); await this.upload(journal, entry);
  }
  private async upload(journal: Journal, entry: JournalEntry): Promise<void> {
    if (!this.options.config.dataBase) return;
    await advanceUpload(entry, { home: this.options.config.home, lane: this.options.config.lane, dataBase: this.options.config.dataBase,
      now: this.now, fetch: this.options.fetch ?? globalThis.fetch, save: () => this.save(journal) });
  }
  private async existingSeal(journal: Journal, entry: JournalEntry, at: number, acted: boolean): Promise<void> {
    const head = await readHeader(this.options.rpc), from = await blockAtTime(this.options.rpc, at, { head });
    const logs = await this.options.rpc.request<RpcLog[]>("eth_getLogs", [{ address: this.options.config.lane, fromBlock: hex(Math.max(0, from - 1)), toBlock: hex(head.block) }]);
    const event = logs.map(decodeEvent).find(event => event?.name === "Sealed" && String(event.args.reasoningHash).toLowerCase() === entry.h);
    const receipt = event ? await this.options.sender.receipt(event.tx) : null;
    if (!receipt || !acted && entry.orders.legs.length) { await this.closeUnsent(journal, entry, { code: "already-sealed" }); return; }
    entry.kind = acted ? "trade" : "seal";
    await this.received(journal, entry, receipt);
  }
  private async resume(journal: Journal, work?: Work): Promise<void> {
    for (const entry of journal.entries) {
      if (work) work.entry = entry;
      if (entry.stage === "record" && !entry.signed) { await this.closeUnsent(journal, entry, { code: "interrupted" }, "not-sent"); continue; }
      if (entry.stage === "signed" && entry.broadcastAttemptedAt === undefined) {
        if (this.now() - (entry.signedAt ?? 0) > 120_000) await this.closeUnsent(journal, entry, { code: "stale" }, "not-sent");
        else try { await this.send(journal, entry, work); } catch (error) {
          if (error instanceof Refusal) await this.closeUnsent(journal, entry, error.detail);
          else this.log(error);
        }
      } else if (entry.broadcastAttemptedAt !== undefined && !entry.receipt && isOpen(entry)) {
        try {
          const receipt = await this.options.sender.receipt(entry.signed!.hash);
          if (receipt) await this.received(journal, entry, receipt); else await this.send(journal, entry);
        } catch (error) { this.log(error); }
      }
      if (entry.receipt?.status === 1 && entry.stage !== "verified") await this.upload(journal, entry);
      if (work && work.cancelled) return;
    }
  }
  private async recover(): Promise<void> {
    try { await withAgentLock(this.options.config.home, this.options.identity.agent, async () => {
      const journal = await readJournal(this.options.config.home, this.options.config.lane); await this.resume(journal);
    }); } catch (error) { if (!(error instanceof AgentBusy)) throw error; }
  }
}
