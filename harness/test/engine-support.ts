import http from "node:http";
import { fork } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { LANE_ABI, SendClient, keccak256, legsHash, sha256Hex } from "@holdout/core";
import { decodeFunctionData, encodeErrorResult, parseTransaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HarnessEngine, type EngineOptions } from "../src/engine.js";
import { runModelAttempt } from "../src/models.js";
import { checkExecutionQuotes, emptyOrders, ZERO_HASH } from "../src/orders.js";
import { atomicJson } from "../src/journal.js";
import type { HarnessConfig, HarnessRecord, Orders, SnapshotResult } from "../src/types.js";
import { listing, snapshot } from "./decision-fixtures.js";
import { anthropicFrames, frame, openaiFrames } from "./model-support.js";

export const DATE = "2026-11-16", TIME = Date.parse(DATE + "T15:00:00Z") / 1000;
export const LANE = "0x" + "a".repeat(40), FACTORY = "0x" + "f".repeat(40);
const TEST_KEY = "0x" + "42".repeat(32), AGENT = privateKeyToAccount(TEST_KEY as `0x${string}`).address.toLowerCase();
const NOT_AUTHORIZED = encodeErrorResult({ abi: LANE_ABI, errorName: "NotAuthorized" });
export interface TestConfig extends HarnessConfig { test: { legs: boolean; hugeInput?: boolean; partialKill?: boolean } }
interface Seal { at: number; acted: boolean; legsHash: string }
interface Mined { hash: string; raw: string; from: string; nonce: number; data: string; kind: string; h: string; status: number; blockNumber: number; blockHash: string }
export interface TestState {
  now: number; block: number; finalized: number; branch: number; modelCalls: number; ordersCalls: number; snapshots: number;
  scenario: "normal" | "partial"; quoteOut: string; estimateError: boolean; estimateTemporary: number; tradeRevert: boolean;
  seals: Record<string, Seal>; transactions: Record<string, Mined>; broadcasts: string[]; estimates: string[];
  records: Map<string, Buffer>; executions: Map<string, Buffer>; posts: { kind: string; h: string; hadReceipt: boolean }[];
  indexed: { h: string; time: number }[];
  events: { kind: "Sealed" | "Traded"; h: string }[];
  publicationStatus: number; reason?: string; splitMarker?: string; estimateDiagnostic?: string;
}
function hash(branch: number, block: number): string { return "0x" + (branch * 1_000_000 + block).toString(16).padStart(64, "0"); }
function dataCall(data: string): { kind: string; h: string; legsHash: string } {
  const decoded = decodeFunctionData({ abi: LANE_ABI, data: data as `0x${string}` });
  const args = decoded.args as any[];
  return { kind: decoded.functionName, h: String(args[0]).toLowerCase(), legsHash: decoded.functionName === "seal" ? String(args[1]).toLowerCase() : legsHash(args[1]) };
}

export async function environment(t: TestContext, options: { review?: boolean; legs?: boolean; hugeInput?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "engine-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state: TestState = { now: TIME + 10, block: 200, finalized: 1000, branch: 1, modelCalls: 0, ordersCalls: 0, snapshots: 0,
    scenario: "normal", quoteOut: "1000000", estimateError: false, estimateTemporary: 0, tradeRevert: false, seals: {}, transactions: {}, broadcasts: [], estimates: [], records: new Map(), executions: new Map(), posts: [], indexed: [], events: [], publicationStatus: 201 };
  const canonicalEffects = () => ({ seals: state.events.filter(event => event.kind === "Sealed").length, trades: state.events.filter(event => event.kind === "Traded").length });
  const rpcResult = (method: string, params: any[]): unknown => {
    if (method === "eth_chainId") return "0x1237";
    if (method === "web3_clientVersion") return "anvil/engine-test";
    if (method === "eth_gasPrice") return "0x2";
    if (method === "eth_getTransactionCount") return "0x" + (Object.values(state.transactions).length).toString(16);
    if (method === "eth_estimateGas") {
      const call = dataCall(params[0].data); state.estimates.push(call.kind);
      if (call.kind === "trade" && state.estimateTemporary > 0) { state.estimateTemporary--; throw { code: -32000, message: state.estimateDiagnostic ?? "node temporarily unavailable" }; }
      if (call.kind === "trade" && state.estimateError) throw { code: 3, message: "execution reverted", data: NOT_AUTHORIZED };
      return "0x5208";
    }
    if (method === "eth_call") { if (state.tradeRevert) throw { code: 3, message: "execution reverted", data: NOT_AUTHORIZED }; return "0x"; }
    if (method === "eth_sendRawTransaction") {
      const raw = String(params[0]), transactionHash = keccak256(raw as `0x${string}`); state.broadcasts.push(raw);
      if (state.transactions[transactionHash]) return transactionHash;
      const parsed = parseTransaction(raw as `0x${string}`), call = dataCall(parsed.data ?? "0x");
      const old = state.seals[call.h];
      const status = call.kind === "trade" && (state.tradeRevert || old?.acted) || call.kind === "seal" && old ? 0 : 1;
      const blockNumber = state.block - 20 + Object.keys(state.transactions).length;
      state.transactions[transactionHash] = { hash: transactionHash, raw, from: AGENT, nonce: parsed.nonce ?? 0, data: parsed.data ?? "0x", kind: call.kind, h: call.h, status, blockNumber, blockHash: hash(state.branch, blockNumber) };
      if (status === 1) {
        state.seals[call.h] = { at: old?.at ?? state.now, acted: call.kind === "trade" || old?.acted || false, legsHash: call.legsHash };
        if (!old) state.events.push({ kind: "Sealed", h: call.h });
        if (call.kind === "trade") state.events.push({ kind: "Traded", h: call.h });
      }
      return transactionHash;
    }
    if (method === "eth_getTransactionReceipt") {
      const tx = state.transactions[String(params[0])];
      return tx ? { transactionHash: tx.hash, blockNumber: "0x" + tx.blockNumber.toString(16), blockHash: tx.blockHash, status: "0x" + tx.status, gasUsed: "0x5208", from: tx.from, to: LANE } : null;
    }
    if (method === "eth_getTransactionByHash") {
      const tx = state.transactions[String(params[0])];
      return tx ? { hash: tx.hash, nonce: "0x" + tx.nonce.toString(16), from: tx.from, blockHash: tx.blockHash } : null;
    }
    if (method === "test_header") {
      const block = params[0] === "finalized" ? state.finalized : typeof params[0] === "number" ? params[0] : state.block;
      return { block, time: state.now, hash: hash(state.branch, block) };
    }
    if (method === "test_lane") return { ledger: {}, status: 0, agent: AGENT, owner: AGENT,
      seals: Object.fromEntries((params[0] ?? []).map((h: string) => [h, state.seals[h] ?? { at: 0, acted: false, legsHash: ZERO_HASH }])) };
    if (method === "test_view") return { quoteOut: state.quoteOut };
    if (method === "test_orders") { state.ordersCalls++; return null; }
    if (method === "test_snapshot") { state.snapshots++; return null; }
    throw new Error("unexpected fake method " + method);
  };
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks), path = request.url ?? "/";
    if (path.startsWith("/provider/")) {
      state.modelCalls++;
      const parameters = JSON.parse(body.toString()), anthropic = path.endsWith("messages");
      const text = JSON.stringify({ weights: { AAA: "0.5" }, reason: state.reason ?? "fixed decision" });
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (state.scenario === "partial" && state.modelCalls === 2) {
        response.write(frame({ type: "response.output_text.delta", delta: "second-one" }));
        response.write(frame({ type: "response.output_text.delta", delta: "second-two" }));
        response.write('data: {"type":"response.output_text.delta","delta":"partial-suffix');
      } else {
        const texts = [state.scenario === "partial" && state.modelCalls === 1 ? "first parse failure" : text];
        const raw = (anthropic ? anthropicFrames(texts, { model: parameters.model }) : openaiFrames(texts, { model: parameters.model })).join("");
        if (state.splitMarker && raw.includes(state.splitMarker)) {
          const split = raw.indexOf(state.splitMarker) + Math.floor(state.splitMarker.length / 2);
          response.write(raw.slice(0, split)); await delay(10); response.end(raw.slice(split));
        } else response.end(raw);
      }
      return;
    }
    if (request.method === "GET" && path === "/d/lanes.json") {
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ lanes: [{ address: LANE,
        decisions: [...state.indexed, ...Object.entries(state.seals).map(([h, seal]) => ({ h, time: seal.at }))].map(item => ({ h: item.h, sealed: { time: item.time } })) }] })); return;
    }
    if (request.method === "POST" && (path === "/r" || path.startsWith("/x/"))) {
      const kind = path === "/r" ? "r" : "x", h = kind === "r" ? sha256Hex(body) : path.slice(3);
      const tx = Object.values(state.transactions).find(value => value.h === h && value.status === 1);
      state.posts.push({ kind, h, hadReceipt: !!tx });
      if (!state.seals[h]) { response.writeHead(409, { "content-type": "application/json", "retry-after": "1" }); response.end('{"error":"not-sealed"}'); return; }
      (kind === "r" ? state.records : state.executions).set(h, body); response.writeHead(state.publicationStatus); response.end("{}"); return;
    }
    if (request.method === "GET" && /^\/(r|x)\/0x[0-9a-f]{64}\.json$/.test(path)) {
      const [, kind, h] = /^\/(r|x)\/(0x[0-9a-f]{64})\.json$/.exec(path)!;
      const stored = (kind === "r" ? state.records : state.executions).get(h); response.writeHead(stored ? 200 : 404); response.end(stored); return;
    }
    const requestBody = JSON.parse(body.toString());
    response.setHeader("content-type", "application/json");
    try { response.end(JSON.stringify({ jsonrpc: "2.0", id: requestBody.id, result: rpcResult(requestBody.method, requestBody.params) })); }
    catch (error) { response.end(JSON.stringify({ jsonrpc: "2.0", id: requestBody.id, error: error instanceof Error ? { code: -32000, message: error.message } : error })); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fake chain missing address");
  const baseURL = `http://127.0.0.1:${address.port}`, keyFile = join(root, "signer");
  await writeFile(keyFile, TEST_KEY, { mode: 0o600 });
  const model = options.review ? "gpt-6.1-sol" : "claude-fable-5-2";
  const config: TestConfig = { mode: "send", budget: { monthlyUsd: "30" }, rpc: { override: baseURL }, dataDir: join(root, "data"), publicBase: baseURL, adminBase: baseURL, factory: FACTORY,
    lanes: [{ lane: LANE, agent: AGENT, model, review: options.review ? "operator-send-or-skip" : "auto", keyFile }],
    models: { [model]: { provider: options.review ? "openai" : "anthropic", effort: "high", maxOutputTokens: 64000 } },
    prices: { [model]: { input: 0, output: 0 } }, listingFile: "unused", cutoffsFile: "unused", paperMaxAge: 90000,
    test: { legs: options.legs ?? true, hugeInput: options.hugeInput } };
  const configPath = join(root, "config.json"); await atomicJson(configPath, config);
  const reorg = () => { state.transactions = {}; state.seals = {}; state.events = []; state.branch++; };
  return { root, state, config, configPath, baseURL, canonicalEffects, reorg };
}

export function hooks(config: TestConfig): EngineOptions {
  const rpc = { async request<T>(method: string, params: unknown[]): Promise<T> {
    const response = await fetch(config.rpc.override!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const value = await response.json() as any; if (value.error) throw value.error; return value.result;
  } };
  return { rpc, sender: new SendClient({ override: config.rpc.override, stateIntervalMs: 0, executionIntervalMs: 0, sleep: async () => {} }),
    now: () => TIME + 10, sleep: async () => {}, logger: () => {},
    header: async (_rpc, block = "latest") => rpc.request("test_header", [block]),
    laneState: async (_rpc, _lane, _tokens, _block, hashes = []) => rpc.request("test_lane", [hashes]),
    snapshot: async () => {
      await rpc.request("test_snapshot", []);
      const assets = listing(1), value = snapshot(assets); value.time = TIME;
      if (config.test.hugeInput) value.history = [{ date: "2026-11-13", weights: { AAA: "0.5" }, reason: "x".repeat(70000) }];
      return { snapshot: value, listing: assets, openedTime: TIME - 86400, status: 0, principal: assets.principal } as SnapshotResult;
    },
    orders: async () => {
      await rpc.request("test_orders", []);
      const orders = emptyOrders(200); orders.simulation = { result: "passed", error: null };
      if (config.test.legs) { orders.legs = [{ symbol: "AAA", pool: 0, buy: true, amountIn: "1000000", minOut: "995000", quoteOut: "1000000" }]; orders.legsHash = legsHash(orders.legs); }
      return orders;
    },
    executionQuotes: async options => checkExecutionQuotes({ ...options, quote: async () => BigInt((await rpc.request<{ quoteOut: string }>("test_view", [])).quoteOut) }),
    model: options => runModelAttempt({ ...options, apiKey: "engine-test-provider-key", baseURL: config.publicBase + "/provider" }),
    onAttemptChunk: async journal => {
      if (config.test.partialKill && journal.attempts.length === 2 && (await readFile(journal.attempts[1].raw, "utf8")).includes("partial-suffix")) process.kill(process.pid, "SIGKILL");
    },
  };
}
export function engine(config: TestConfig): HarnessEngine { return new HarnessEngine(config, hooks(config)); }
export async function loadRecord(journal: { record?: { path: string } }): Promise<HarnessRecord> { return JSON.parse(await readFile(journal.record!.path, "utf8")); }
export function launch(configPath: string, command = "run", options: { fault?: string; h?: string } = {}) {
  const childEnvironment: NodeJS.ProcessEnv = { ...process.env, HARNESS_FAULT: options.fault ?? "" };
  delete childEnvironment.HARNESS_SEND;
  const child = fork(fileURLToPath(new URL("./engine-child.js", import.meta.url)), [configPath, command, options.h ?? ""], {
    stdio: ["ignore", "pipe", "pipe", "ipc"], env: childEnvironment,
  });
  let stderr = ""; child.stderr?.on("data", chunk => { stderr += chunk; });
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal, stderr })));
  return { child, result };
}
