import http from "node:http";
import https from "node:https";
import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, parseTransaction, recoverTransactionAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PUBLIC_RPC } from "./rpc.js";
import { decodeRevert, registerSecret, revertData, safeError, type DecodedRevert } from "./errors.js";

export const SEND_METHODS: ReadonlySet<string> = new Set([
  "eth_sendRawTransaction", "eth_chainId", "eth_getTransactionCount", "eth_estimateGas", "eth_gasPrice",
  "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_call", "web3_clientVersion",
]);
export interface SendOptions {
  url?: string; override?: string; fallback?: string; envFile?: string | false; timeoutMs?: number;
  authorization?: () => boolean;
  stateIntervalMs?: number; executionIntervalMs?: number; sleep?: (ms: number) => Promise<void>;
  now?: () => number; logger?: (message: string) => void;
}
export interface TransactionIntent { to: string; data: Hex; value?: bigint | string; keyFile: string; from?: string; beforeEstimate?: () => Promise<void> }
export interface SignedIntent {
  rawTransaction: Hex; hash: Hex; nonce: string; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: "0";
  from: string; to: string; data: Hex; value: string;
}
export type PrepareResult = { reverted: false; temporary: false; signed: SignedIntent }
  | { reverted: true; error: DecodedRevert } | { reverted: false; temporary: true; error: string };
export interface SendReceipt {
  transactionHash: string; blockNumber: number; blockHash: string; status: 0 | 1; gasUsed: string;
  from?: string; to?: string | null;
}
export interface BroadcastOptions { beforeBroadcast?: () => Promise<void> }
interface Endpoint { label: string; url: URL }
export class SendBoundaryError extends Error {}
export class NonceConflictError extends Error {}
class SendRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data: unknown) { super(safeError(message)); }
}
let queue: Promise<void> = Promise.resolve(), lastRequestAt = -Infinity;
const hex = (value: bigint | number): Hex => `0x${BigInt(value).toString(16)}`;
const quantity = (value: unknown): bigint => BigInt(value as string);
const localHost = (host: string): boolean => host === "localhost" || host === "[::1]" || host === "::1" || /^127\./.test(host);

export class SendClient {
  private endpoints?: Endpoint[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private serial = 0;
  constructor(private readonly options: SendOptions = {}) {
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    if (options.override && options.url) throw new Error("one explicit endpoint is allowed");
    if (options.override) {
      const url = this.endpoint(options.override);
      if (!localHost(url.hostname)) throw new SendBoundaryError("override must use loopback");
    }
  }
  private endpoint(value: string): URL {
    let url: URL; try { url = new URL(value); } catch { throw new SendBoundaryError("invalid send endpoint"); }
    if (!["http:", "https:"].includes(url.protocol)) throw new SendBoundaryError("invalid send protocol");
    return url;
  }
  private async sources(): Promise<Endpoint[]> {
    if (this.endpoints) return this.endpoints;
    const primary = this.options.override ?? this.options.url ?? PUBLIC_RPC;
    const entries = [{ label: this.options.override ? "override" : "public", url: this.endpoint(primary) }];
    if (!this.options.override) {
      let fallback = this.options.fallback ?? process.env.RHC_RPC_FALLBACK;
      if (!fallback && this.options.envFile !== false) {
        const path = this.options.envFile ?? resolve(fileURLToPath(new URL("../../../../", import.meta.url)), ".env");
        try {
          for (const line of (await readFile(path, "utf8")).split(/\r?\n/)) {
            const match = /^\s*(?:export\s+)?RHC_RPC_FALLBACK\s*=\s*(.*?)\s*$/.exec(line);
            if (match) { const raw = match[1]; fallback = (raw[0] === "'" || raw[0] === '"') && raw.at(-1) === raw[0]
              ? raw.slice(1, -1) : raw.split(/\s+#/)[0].trim(); break; }
          }
        } catch { /* An optional fallback need not exist. */ }
      }
      if (fallback && fallback !== primary) entries.push({ label: "fallback", url: this.endpoint(fallback) });
    }
    this.endpoints = entries; return entries;
  }
  private async post<T>(endpoint: Endpoint, method: string, params: unknown[]): Promise<T> {
    if (!SEND_METHODS.has(method)) throw new SendBoundaryError("send RPC method is not allowed");
    let release!: () => void;
    const prior = queue; queue = new Promise(resolve => { release = resolve; }); await prior;
    try {
      const execution = method === "eth_call" || method === "eth_estimateGas";
      const interval = execution ? this.options.executionIntervalMs ?? 500 : this.options.stateIntervalMs ?? 250;
      await this.sleep(Math.max(0, lastRequestAt + interval - this.now())); lastRequestAt = this.now();
      const bytes = JSON.stringify({ jsonrpc: "2.0", id: ++this.serial, method, params });
      return await new Promise<T>((resolve, reject) => {
        const transport = endpoint.url.protocol === "https:" ? https : http;
        const request = transport.request(endpoint.url, { method: "POST", family: 4, headers: {
          "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bytes),
        } }, response => {
          const pieces: Buffer[] = []; let size = 0;
          response.on("data", part => {
            size += part.length;
            if (size > 16 * 1024 * 1024) request.destroy(new Error("send RPC response too large")); else pieces.push(part);
          });
          response.on("error", () => reject(new Error(`${endpoint.label}: incomplete response`)));
          response.on("end", () => {
            if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) { reject(new Error(`${endpoint.label}: HTTP ${response.statusCode ?? 0}`)); return; }
            try {
              const value = JSON.parse(Buffer.concat(pieces).toString());
              if (value.error) reject(new SendRpcError(value.error.code ?? -32000, value.error.message ?? "RPC error", value.error.data));
              else if (Object.hasOwn(value, "result")) resolve(value.result as T);
              else reject(new Error(`${endpoint.label}: invalid RPC response`));
            } catch { reject(new Error(`${endpoint.label}: invalid JSON response`)); }
          });
        });
        request.setTimeout(this.options.timeoutMs ?? 60_000, () => request.destroy(new Error(`${endpoint.label}: no response`)));
        request.on("error", error => reject(new Error(safeError(error)))); request.end(bytes);
      });
    } finally { release(); }
  }
  private async guarded(): Promise<{ endpoint: Endpoint; local: boolean }> {
    let failure: unknown;
    for (const endpoint of await this.sources()) {
      if (localHost(endpoint.url.hostname) && endpoint.url.hostname !== "127.0.0.1") throw new SendBoundaryError("sending requires IPv4 loopback");
      if (!localHost(endpoint.url.hostname) && !(this.options.authorization ?? (() => process.env.HARNESS_SEND === "true"))()) throw new SendBoundaryError("sending is not enabled");
      try {
        if (quantity(await this.post(endpoint, "eth_chainId", [])) !== 4663n) throw new SendBoundaryError("unexpected send chain");
        const local = endpoint.url.hostname === "127.0.0.1";
        if (local && !String(await this.post(endpoint, "web3_clientVersion", [])).toLowerCase().includes("anvil")) throw new SendBoundaryError("loopback send endpoint is not anvil");
        return { endpoint, local };
      } catch (error) {
        if (error instanceof SendBoundaryError) throw error;
        failure = error; this.options.logger?.(safeError(error));
      }
    }
    throw new Error(safeError(failure));
  }
  async assertBoundary(): Promise<{ local: boolean; chainId: 4663 }> { const checked = await this.guarded(); return { local: checked.local, chainId: 4663 }; }
  async request<T = unknown>(method: string, params: unknown[]): Promise<T> {
    if (!SEND_METHODS.has(method)) throw new SendBoundaryError("send RPC method is not allowed");
    if (method === "eth_sendRawTransaction") {
      const { endpoint } = await this.guarded(); return this.post(endpoint, method, params);
    }
    let failure: unknown;
    for (const endpoint of await this.sources()) {
      try { return await this.post<T>(endpoint, method, params); }
      catch (error) { if (error instanceof SendRpcError) throw error; failure = error; }
    }
    throw new Error(safeError(failure));
  }
  private async key(path: string): Promise<Hex> {
    const file = await open(path, "r");
    try {
      const info = await file.stat();
      if (!info.isFile() || (info.mode & 0o7777) !== 0o600) throw new SendBoundaryError("key file must have mode 600");
      const original = await file.readFile("utf8"), trimmed = original.trim();
      registerSecret(original); registerSecret(trimmed);
      if (!/^(?:0x)?[0-9a-f]{64}$/i.test(trimmed)) throw new SendBoundaryError("invalid key file");
      const value = ("0x" + trimmed.replace(/^0x/i, "")).toLowerCase() as Hex;
      registerSecret(value); registerSecret(value.slice(2));
      registerSecret(trimmed.replace(/^0x/i, ""));
      return value;
    } finally { await file.close(); }
  }
  async prepare(intent: TransactionIntent): Promise<PrepareResult> {
    const { endpoint } = await this.guarded();
    const key = await this.key(intent.keyFile), account = privateKeyToAccount(key);
    const from = account.address.toLowerCase();
    if (intent.from && intent.from.toLowerCase() !== from) throw new SendBoundaryError("key does not match the configured agent");
    if (!/^0x[0-9a-f]{40}$/i.test(intent.to) || !/^0x(?:[0-9a-f]{2})*$/i.test(intent.data)) throw new SendBoundaryError("invalid transaction intent");
    const value = BigInt(intent.value ?? 0); if (value < 0n) throw new SendBoundaryError("invalid transaction value");
    let nonce: bigint, gas: bigint, price: bigint;
    try {
      nonce = quantity(await this.post(endpoint, "eth_getTransactionCount", [from, "pending"]));
      price = quantity(await this.post(endpoint, "eth_gasPrice", []));
    } catch (error) { return { reverted: false, temporary: true, error: safeError(error) }; }
    await intent.beforeEstimate?.();
    try { gas = quantity(await this.post(endpoint, "eth_estimateGas", [{ from, to: intent.to, data: intent.data, value: hex(value) }])); }
    catch (error) {
      const data = revertData(error);
      return data === null ? { reverted: false, temporary: true, error: safeError(error) } : { reverted: true, error: decodeRevert(data) };
    }
    if (nonce > BigInt(Number.MAX_SAFE_INTEGER) || gas <= 0n || price < 0n) throw new SendBoundaryError("unsupported transaction quantities");
    // Authorization may have changed during estimation; check again immediately before signing.
    const final = await this.guarded();
    if (final.endpoint.url.href !== endpoint.url.href) return { reverted: false, temporary: true, error: "send endpoint changed during preparation" };
    const rawTransaction = await account.signTransaction({ type: "eip1559", chainId: 4663, to: intent.to as Hex,
      data: intent.data, value, nonce: Number(nonce), gas: gas * 2n, maxFeePerGas: price * 2n, maxPriorityFeePerGas: 0n });
    return { reverted: false, temporary: false, signed: { rawTransaction, hash: keccak256(rawTransaction), nonce: nonce.toString(),
      gas: (gas * 2n).toString(), maxFeePerGas: (price * 2n).toString(), maxPriorityFeePerGas: "0", from,
      to: intent.to.toLowerCase(), data: intent.data.toLowerCase() as Hex, value: value.toString() } };
  }
  private async validate(signed: SignedIntent): Promise<void> {
    if (keccak256(signed.rawTransaction) !== signed.hash) throw new SendBoundaryError("signed transaction hash mismatch");
    const parsed = parseTransaction(signed.rawTransaction);
    if (parsed.type !== "eip1559" || parsed.chainId !== 4663 || BigInt(parsed.nonce ?? -1) !== BigInt(signed.nonce)
      || parsed.to?.toLowerCase() !== signed.to.toLowerCase() || (parsed.data ?? "0x").toLowerCase() !== signed.data.toLowerCase()
      || (parsed.value ?? 0n) !== BigInt(signed.value) || parsed.gas !== BigInt(signed.gas)
      || (parsed.maxFeePerGas ?? 0n) !== BigInt(signed.maxFeePerGas) || (parsed.maxPriorityFeePerGas ?? 0n) !== 0n) throw new SendBoundaryError("signed transaction fields mismatch");
    if ((await recoverTransactionAddress({ serializedTransaction: signed.rawTransaction as `0x02${string}` })).toLowerCase() !== signed.from) throw new SendBoundaryError("signed transaction sender mismatch");
  }
  private async nonceConflict(endpoint: Endpoint, signed: SignedIntent): Promise<void> {
    // Nonce first: if it is already used, the later lookup still shows this transaction in a block when it was the one mined.
    const used = quantity(await this.post(endpoint, "eth_getTransactionCount", [signed.from, "latest"]));
    const own = await this.post<any>(endpoint, "eth_getTransactionByHash", [signed.hash]);
    if (own && String(own.hash).toLowerCase() !== signed.hash) throw new NonceConflictError("transaction hash changed for this nonce");
    if (own && (quantity(own.nonce) !== BigInt(signed.nonce) || String(own.from).toLowerCase() !== signed.from)) throw new NonceConflictError("transaction identity changed for this nonce");
    if (used > BigInt(signed.nonce) && !own?.blockHash) throw new NonceConflictError("another transaction consumed the signed nonce");
  }
  async broadcast(signed: SignedIntent, options: BroadcastOptions = {}): Promise<string> {
    await this.validate(signed); const { endpoint } = await this.guarded();
    await options.beforeBroadcast?.();
    await this.nonceConflict(endpoint, signed);
    try {
      const hash = String(await this.post(endpoint, "eth_sendRawTransaction", [signed.rawTransaction])).toLowerCase();
      if (hash !== signed.hash) throw new SendBoundaryError("broadcast transaction hash mismatch");
      return hash;
    } catch (error) {
      if (/already known|known transaction/i.test(safeError(error))) return signed.hash;
      throw error;
    }
  }
  async receipt(hash: string): Promise<SendReceipt | null> {
    const value = await this.request<any>("eth_getTransactionReceipt", [hash]);
    if (!value) return null;
    const blockNumber = Number(quantity(value.blockNumber)), status = Number(quantity(value.status));
    if (!Number.isSafeInteger(blockNumber) || status !== 0 && status !== 1 || String(value.transactionHash).toLowerCase() !== hash.toLowerCase()) throw new Error("invalid transaction receipt");
    return { transactionHash: String(value.transactionHash).toLowerCase(), blockNumber, blockHash: String(value.blockHash).toLowerCase(),
      status, gasUsed: quantity(value.gasUsed ?? "0x0").toString(), ...(value.from ? { from: String(value.from).toLowerCase() } : {}),
      ...(value.to !== undefined ? { to: value.to === null ? null : String(value.to).toLowerCase() } : {}) };
  }
  async wait(signed: SignedIntent, options: BroadcastOptions = {}): Promise<SendReceipt> {
    await this.validate(signed); const started = this.now(); let rebroadcastAt = started + 120_000;
    while (this.now() - started < 600_000) {
      const receipt = await this.receipt(signed.hash); if (receipt) return receipt;
      const { endpoint } = await this.guarded(); await this.nonceConflict(endpoint, signed);
      if (this.now() >= rebroadcastAt) { await this.broadcast(signed, options); rebroadcastAt = this.now() + 120_000; }
      await this.sleep(1000);
    }
    throw new Error("transaction receipt timeout");
  }
}
