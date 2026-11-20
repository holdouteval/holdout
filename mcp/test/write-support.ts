import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TestContext } from "node:test";
import { RpcClient, SendClient, ADDRESSES, LANE_ABI, MULTICALL_ABI, QUOTER_ABI, registerSecret, legsHash, type ReadRpc } from "@holdout/core";
import { decodeFunctionData, encodeFunctionResult, encodeErrorResult, keccak256, parseTransaction, recoverTransactionAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DecisionEngine, type EngineDependencies } from "../src/engine.js";
import { FIXTURE, readFixture } from "./read-fixtures.js";

export const input = (requestId = "request-1") => ({ requestId, weights: { NVDA: "0.25" }, model: "test-agent", input: "market observations", output: "target NVDA" });
export function writeRpc(agent: string) {
  const fixture = readFixture(); fixture.state.agent = agent;
  fixture.ledger[ADDRESSES.usdg] = 1_000_000_000n; fixture.ledger[fixture.assets[0].token] = 0n;
  const state = { block: FIXTURE.block, time: FIXTURE.time, nonce: 0n, gasBalance: 10n ** 18n, automine: true,
    estimateError: false, simulationError: false, chainFailure: false, loseBroadcast: false, receiptError: false,
    beforeEstimateMove: false, afterEstimateMove: false, multiplier: 10000n, estimates: 0, simulations: 0,
    prepares: 0, raw: [] as string[], receipts: new Map<string, any>(), transactions: new Map<string, any>(),
    seals: new Map<string, { at: bigint; acted: boolean; legsHash: string }>(), sealEvents: [] as { h: string; tx: string }[] };
  const hash = () => "0x" + state.block.toString(16).padStart(64, "0");
  const revert = () => ({ code: -32000, message: "execution reverted", data: encodeErrorResult({ abi: LANE_ABI, errorName: "MinOut", args: [1n, 2n] }) });
  function mine() {
    for (const [txHash, tx] of state.transactions) {
      if (tx.blockHash) continue;
      state.block++; state.time++;
      tx.blockHash = hash(); state.nonce = BigInt(tx.nonce) + 1n;
      const status = tx.failed ? 0 : 1;
      state.receipts.set(txHash, { transactionHash: txHash, blockNumber: "0x" + state.block.toString(16), blockHash: hash(), status: "0x" + status, gasUsed: "0x5208", from: tx.from, to: FIXTURE.lane });
      if (status) {
        const decoded = decodeFunctionData({ abi: LANE_ABI, data: tx.data });
        const h = String(decoded.args![0]).toLowerCase(), trade = decoded.functionName === "trade";
        let legsHash = String(decoded.args![1]).toLowerCase();
        if (trade) {
          legsHash = requireLegsHash(decoded.args![1] as any);
        }
        if (!state.seals.has(h)) state.sealEvents.push({ h, tx: txHash });
        state.seals.set(h, { at: BigInt(state.time), acted: trade, legsHash });
      }
    }
  }
  const call = async (target: string, data: `0x${string}`): Promise<`0x${string}`> => {
    if (target === FIXTURE.lane) {
      const decoded = decodeFunctionData({ abi: LANE_ABI, data });
      if (decoded.functionName === "seals") {
        const seal = state.seals.get(String(decoded.args![0]).toLowerCase());
        return encodeFunctionResult({ abi: LANE_ABI, functionName: "seals", result: seal ? [seal.at, seal.acted, seal.legsHash as `0x${string}`] : [0n, false, ("0x" + "0".repeat(64)) as `0x${string}`] });
      }
      if (decoded.functionName === "trade") { state.simulations++; if (state.simulationError) throw revert(); return "0x"; }
    }
    if (target === ADDRESSES.quoter) {
      const value = await fixture.rpc.request<`0x${string}`>("eth_call", [{ to: target, data }, "latest"]);
      const decoded = (await import("viem")).decodeFunctionResult({ abi: QUOTER_ABI, functionName: "quoteExactInputSingle", data: value });
      return encodeFunctionResult({ abi: QUOTER_ABI, functionName: "quoteExactInputSingle", result: [decoded[0] * state.multiplier / 10000n, decoded[1]] });
    }
    return fixture.rpc.request("eth_call", [{ to: target, data }, "latest"]);
  };
  const rpc: ReadRpc = { async request<T>(method: string, params: unknown[]): Promise<T> {
    if (method === "eth_getBlockByNumber") return { number: "0x" + state.block.toString(16), timestamp: "0x" + state.time.toString(16), hash: hash() } as T;
    if (method === "eth_getBalance") return ("0x" + state.gasBalance.toString(16)) as T;
    if (method === "eth_getTransactionCount") return ("0x" + state.nonce.toString(16)) as T;
    if (method === "eth_gasPrice") { state.prepares++; if (state.beforeEstimateMove) state.multiplier = 10100n; return "0x1" as T; }
    if (method === "eth_estimateGas") { state.estimates++; if (state.estimateError) throw revert(); if (state.afterEstimateMove) state.multiplier = 10100n; return "0x186a0" as T; }
    if (method === "eth_sendRawTransaction") {
      const raw = String(params[0]) as `0x02${string}`, txHash = keccak256(raw); state.raw.push(raw);
      if (!state.transactions.has(txHash)) {
        const parsed = parseTransaction(raw), from = (await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase();
        state.transactions.set(txHash, { hash: txHash, nonce: "0x" + BigInt(parsed.nonce!).toString(16), from, data: parsed.data, failed: state.chainFailure });
        if (state.automine) mine();
      }
      if (state.loseBroadcast) { state.loseBroadcast = false; throw new Error("broadcast response lost"); }
      return txHash as T;
    }
    if (method === "eth_getTransactionByHash") return (state.transactions.get(String(params[0])) ?? null) as T;
    if (method === "eth_getTransactionReceipt") { if (state.receiptError) throw new Error("receipt RPC unavailable"); return (state.receipts.get(String(params[0])) ?? null) as T; }
    if (method === "eth_call") {
      const transaction = params[0] as { to: string; data: `0x${string}` }, target = transaction.to.toLowerCase();
      if (target === ADDRESSES.multicall3) {
        const decoded = decodeFunctionData({ abi: MULTICALL_ABI, data: transaction.data });
        const values = await Promise.all((decoded.args![0] as readonly { target: string; callData: `0x${string}` }[]).map(async item => ({ success: true, returnData: await call(item.target.toLowerCase(), item.callData) })));
        return encodeFunctionResult({ abi: MULTICALL_ABI, functionName: "aggregate3", result: values }) as T;
      }
      return await call(target, transaction.data) as T;
    }
    return fixture.rpc.request<T>(method, params);
  } };
  return { ...fixture, rpc, writeState: state, mine };
}
const requireLegsHash = legsHash;

export async function serveWrite(rpc: ReadRpc) {
  const server = createServer((request, response) => {
    const parts: Buffer[] = []; request.on("data", part => parts.push(Buffer.from(part)));
    request.on("end", async () => {
      const body = JSON.parse(Buffer.concat(parts).toString());
      try { response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: await rpc.request(body.method, body.params) })); }
      catch (error) { response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "fixture unavailable", ...(typeof error === "object" && error && "data" in error ? { data: error.data } : {}) } })); }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { url: `http://127.0.0.1:${(server.address() as any).port}`, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
export async function writeFixture(t: TestContext, extra: Partial<EngineDependencies> = {}) {
  const home = await mkdtemp(join(tmpdir(), "mcp-write-")), key = generatePrivateKey(), agent = privateKeyToAccount(key).address.toLowerCase();
  registerSecret(key); registerSecret(key.slice(2));
  await mkdir(join(home, "agents"), { mode: 0o700 }); const path = join(home, "agents", "agent.key"); await writeFile(path, key, { mode: 0o600 });
  const chain = writeRpc(agent), server = await serveWrite(chain.rpc);
  const sender = new SendClient({ override: server.url, envFile: false, stateIntervalMs: 0, executionIntervalMs: 0 });
  const rpc = new RpcClient({ override: server.url, envFile: false, stateIntervalMs: 0, executionIntervalMs: 0, attempts: 1, sleep: async () => {} });
  const posts: Uint8Array[] = [], published = new Map<string, Uint8Array>();
  const fetcher: typeof fetch = async (input, options) => {
    if (options?.method === "POST") { const bytes = new Uint8Array(options.body as Uint8Array); posts.push(bytes); const { sha256Hex } = await import("@holdout/core"); published.set(sha256Hex(bytes), bytes); return new Response('{}', { status: 201 }); }
    const h = String(input).split('/').at(-1)!.replace('.json', '');
    return new Response(published.has(h) ? Buffer.from(published.get(h)!) : null, { status: published.has(h) ? 200 : 404 });
  };
  const options: EngineDependencies = { config: { lane: FIXTURE.lane, home, dataBase: "http://127.0.0.1:1", siteBase: null, rpc: server.url },
    identity: { factory: FIXTURE.factory, owner: FIXTURE.owner, agent, status: 1 }, key: { path, address: agent }, rpc, sender, fetch: fetcher, ...extra };
  const engine = new DecisionEngine(options);
  t.after(async () => { engine.stop(); await server.close(); await rm(home, { recursive: true, force: true }); });
  return { engine, options, home, key, chain, server, posts, published };
}
