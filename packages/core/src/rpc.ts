import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { RpcLog } from "./events.js";

export const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const READ_METHODS: ReadonlySet<string> = new Set([
  "eth_chainId", "eth_blockNumber", "eth_getBalance", "eth_getCode", "eth_getStorageAt",
  "eth_getTransactionCount", "eth_getBlockByHash", "eth_getBlockByNumber",
  "eth_getBlockTransactionCountByHash", "eth_getBlockTransactionCountByNumber",
  "eth_getTransactionByHash", "eth_getTransactionByBlockHashAndIndex",
  "eth_getTransactionByBlockNumberAndIndex", "eth_getTransactionReceipt", "eth_getBlockReceipts",
  "eth_getLogs", "eth_getProof", "eth_call", "eth_estimateGas", "eth_gasPrice",
  "eth_maxPriorityFeePerGas", "eth_feeHistory", "eth_simulateV1", "net_version", "web3_clientVersion",
]);

const privateNames = [...new Set([basename(homedir()), (() => { try { return userInfo().username; } catch { return ""; } })()])].filter(Boolean);
function escaped(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export function sanitize(value: unknown): string {
  let output: string;
  if (value instanceof Error) output = value.message;
  else if (typeof value === "string") output = value;
  else { try { output = JSON.stringify(value, (_key, v) => typeof v === "bigint" ? v.toString() : v); } catch { output = "operation failed"; } }
  output = String(output).replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[endpoint]");
  for (const home of new Set([homedir(), process.env.HOME ?? ""])) {
    if (home.length > 1) output = output.replace(new RegExp(escaped(home) + "(?:[/\\\\][^\\s\"'<>]*)?", "g"), "[path]");
  }
  for (const name of privateNames) output = output.replace(new RegExp("\\b" + escaped(name) + "\\b", "g"), "[user]");
  return output;
}

function cleanObject(value: unknown): unknown {
  if (typeof value === "string") return sanitize(value);
  if (Array.isArray(value)) return value.map(cleanObject);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [sanitize(k), cleanObject(v)]));
  return value;
}

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(error: { code?: unknown; message?: unknown; data?: unknown }) {
    super(sanitize(error.message ?? "RPC error")); this.name = "RpcError";
    this.code = typeof error.code === "number" ? error.code : -32000;
    this.data = cleanObject(error.data);
  }
}

class TransportError extends Error {
  constructor(message: string, readonly retryAfter?: number) { super(message); }
}

export interface RpcOptions {
  override?: string;
  fallback?: string;
  envFile?: string | false;
  publicUrl?: string;
  timeoutMs?: number;
  stateIntervalMs?: number;
  executionIntervalMs?: number;
  attempts?: number;
  logger?: (message: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface LogFilter {
  fromBlock: number;
  toBlock: number;
  address: string | readonly string[];
  topics?: readonly (string | readonly string[] | null)[];
}

function environmentFallback(path?: string | false): string | undefined {
  if (process.env.RHC_RPC_FALLBACK) return process.env.RHC_RPC_FALLBACK;
  if (path === false) return undefined;
  const file = path ?? resolve(fileURLToPath(new URL("../../../../", import.meta.url)), ".env");
  let contents: string;
  try { contents = readFileSync(file, "utf8"); } catch { return undefined; }
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?RHC_RPC_FALLBACK\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[1];
    if ((value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) return value.slice(1, -1);
    return value.split(/\s+#/)[0].trim() || undefined;
  }
  return undefined;
}

function endpoint(input: string, local = false): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("invalid RPC endpoint"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("invalid RPC protocol");
  if (local && !["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("override must use loopback");
  return url;
}

function retryMilliseconds(value: string | string[] | undefined): number | undefined {
  const text = Array.isArray(value) ? value[0] : value;
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text.trim())) return Math.max(0, Number(text) * 1000);
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

let transportQueue: Promise<void> = Promise.resolve();
let lastRequestAt = -Infinity;

export class RpcClient {
  readonly stats = { requests: 0, logCalls: 0 };
  private readonly endpoints: { label: string; url: URL }[];
  private readonly verified = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private serial = 0;
  private readonly wait: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: RpcOptions = {}) {
    this.wait = options.sleep ?? ((milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
    if (options.override) this.endpoints = [{ label: "override", url: endpoint(options.override, true) }];
    else {
      this.endpoints = [{ label: "public", url: endpoint(options.publicUrl ?? PUBLIC_RPC) }];
      const fallback = options.fallback ?? environmentFallback(options.envFile);
      if (fallback && fallback !== this.endpoints[0].url.href) this.endpoints.push({ label: "fallback", url: endpoint(fallback) });
    }
  }

  request<T = unknown>(method: string, params: unknown[]): Promise<T> {
    if (!READ_METHODS.has(method)) return Promise.reject(new Error("read method is not allowed"));
    const result = this.queue.then(() => this.execute<T>(method, params));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async execute<T>(method: string, params: unknown[]): Promise<T> {
    for (let attempt = 0; attempt < (this.options.attempts ?? 3); attempt++) {
      for (const item of this.endpoints) {
        try {
          if (!this.verified.has(item.url.href)) {
            let check: unknown;
            try { check = await this.post(item.url, "eth_chainId", []); }
            catch (error) { if (error instanceof RpcError) throw new TransportError("chain ID verification failed"); throw error; }
            if (check !== "0x1237") throw new TransportError("chain ID mismatch");
            this.verified.add(item.url.href);
            this.options.logger?.(item.label + ": chain ID 4663 verified");
          }
          return await this.post(item.url, method, params) as T;
        } catch (error) {
          if (error instanceof RpcError) throw error;
          const message = error instanceof Error ? sanitize(error) : "read failed";
          this.options.logger?.(item.label + ": " + message);
          const delay = error instanceof TransportError && error.retryAfter !== undefined
            ? error.retryAfter : Math.min(10_000, message.includes("429") ? 10_000 : 1000 * 2 ** attempt);
          await this.wait(delay);
        }
      }
    }
    throw new Error("all configured RPC endpoints failed");
  }

  private post(url: URL, method: string, params: unknown[]): Promise<unknown> {
    const result = transportQueue.then(() => this.performPost(url, method, params));
    transportQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async performPost(url: URL, method: string, params: unknown[]): Promise<unknown> {
    const interval = ["eth_call", "eth_simulateV1"].includes(method)
      ? this.options.executionIntervalMs ?? 500 : this.options.stateIntervalMs ?? 250;
    const delay = lastRequestAt + interval - performance.now();
    if (delay > 0) await this.wait(delay);
    lastRequestAt = performance.now();
    this.stats.requests++;
    if (method === "eth_getLogs") this.stats.logCalls++;
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++this.serial, method, params });
    return await new Promise((resolveResult, reject) => {
      const transport = url.protocol === "https:" ? https : http;
      const request = transport.request(url, { method: "POST", family: 4, agent: false,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (response) => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          reject(new TransportError("HTTP " + (response.statusCode ?? "failure"), retryMilliseconds(response.headers["retry-after"])));
          return;
        }
        const chunks: Buffer[] = []; let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 64 * 1024 * 1024) { response.destroy(); reject(new TransportError("response too large")); return; }
          chunks.push(chunk);
        });
        response.on("error", () => reject(new TransportError("no response")));
        response.on("aborted", () => reject(new TransportError("no response")));
        response.on("end", () => {
          let decoded: { result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };
          try { decoded = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
          catch { reject(new TransportError("invalid JSON response")); return; }
          if (decoded.error) { reject(new RpcError(decoded.error)); return; }
          if (!Object.hasOwn(decoded, "result")) { reject(new TransportError("RPC result missing")); return; }
          resolveResult(cleanObject(decoded.result));
        });
      });
      request.setTimeout(this.options.timeoutMs ?? 60_000, () => request.destroy());
      request.on("error", () => reject(new TransportError("no response")));
      request.end(body);
    });
  }

  async getLogs(filter: LogFilter): Promise<RpcLog[]> {
    if (!Number.isSafeInteger(filter.fromBlock) || !Number.isSafeInteger(filter.toBlock)
        || filter.fromBlock < 0 || filter.toBlock < filter.fromBlock) throw new Error("invalid log interval");
    const results: RpcLog[] = [];
    const fetch = async (from: number, to: number): Promise<void> => {
      let logs: RpcLog[];
      try {
        logs = await this.request<RpcLog[]>("eth_getLogs", [{
          ...filter, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16),
        }]);
      } catch (error) {
        const limited = error instanceof RpcError && (error.code === -32005
          || /range|result|limit|too many|response size|block span/i.test(error.message));
        if (!limited || from === to) throw error;
        const mid = Math.floor((from + to) / 2);
        await fetch(from, mid); await fetch(mid + 1, to);
        return;
      }
      if (!Array.isArray(logs)) throw new Error("invalid logs response");
      if (logs.length >= 10_000) {
        if (from === to) throw new Error("single block exceeds log result limit");
        const mid = Math.floor((from + to) / 2);
        await fetch(from, mid); await fetch(mid + 1, to); return;
      }
      results.push(...logs);
    };
    for (let from = filter.fromBlock; from <= filter.toBlock; from += 62_500) {
      await fetch(from, Math.min(filter.toBlock, from + 62_500 - 1));
    }
    const unique = new Map<string, RpcLog>();
    for (const log of results) {
      const key = BigInt(log.blockNumber).toString() + ":" + BigInt(log.logIndex).toString();
      const previous = unique.get(key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(log)) throw new Error("conflicting log identity");
      unique.set(key, log);
    }
    return [...unique.values()].sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
  }
}
