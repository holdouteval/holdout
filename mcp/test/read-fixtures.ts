import { createServer } from "node:http";
import { ADDRESSES, ACCESS_ABI, FACTORY_ABI, FEEDS, LANE_ABI, MULTICALL_ABI, PROXY_ABI, QUOTER_ABI, STOCK_ABI, type ReadRpc } from "@holdout/core";
import { decodeFunctionData, encodeFunctionResult, type Abi } from "viem";

export const FIXTURE = { lane: "0x" + "1".repeat(40), factory: "0x" + "2".repeat(40), owner: "0x" + "3".repeat(40), agent: "0x" + "4".repeat(40), block: 123, time: 1796050800 };
export function readFixture() {
  const assets = ["NVDA", "AAPL"].map(symbol => FEEDS.find(feed => feed.symbol === symbol)!);
  const pools = assets.map((asset, index) => ({ token: asset.token, key: { currency0: [ADDRESSES.usdg, asset.token].sort()[0], currency1: [ADDRESSES.usdg, asset.token].sort()[1], fee: 100, tickSpacing: 1, hooks: "0x" + "0".repeat(40) }, poolId: "0x" + String(index + 1).padStart(64, "0") }));
  const state = { status: 1, isLane: true, agent: FIXTURE.agent, principal: 1000000000n, value: 1000000000n, blocked: false, paused: new Set<string>(), oraclePaused: new Set<string>(), calls: [] as string[] };
  const ledger = { [ADDRESSES.usdg]: 500000000n, [assets[0].token]: 5000000000000000000n, [assets[1].token]: 0n };
  function abiFor(target: string): Abi {
    if (target === FIXTURE.factory) return FACTORY_ABI;
    if (target === FIXTURE.lane) return LANE_ABI;
    if (target === ADDRESSES.accessRegistry) return ACCESS_ABI;
    if (assets.some(asset => asset.token === target)) return STOCK_ABI;
    if (assets.some(asset => asset.proxy === target)) return PROXY_ABI;
    if (target === ADDRESSES.quoter) return QUOTER_ABI;
    throw new Error("unexpected fixture target");
  }
  function call(target: string, data: `0x${string}`): `0x${string}` {
    const abi = abiFor(target), decoded = decodeFunctionData({ abi, data }), name = decoded.functionName!, args = decoded.args ?? [];
    state.calls.push(name);
    let value: unknown;
    if (target === FIXTURE.factory) {
      const values: Record<string, unknown> = { isLane: state.isLane, assetCount: 2n, poolCount: 2n, maxAge: 90000n, actWindow: 1800n, usdg: ADDRESSES.usdg, accessRegistry: ADDRESSES.accessRegistry, burnAmount: 100000n * 10n ** 18n };
      if (name === "assetAt") { const asset = assets[Number(args[0])]; value = { token: asset.token, feed: asset.proxy }; }
      else if (name === "poolAt") value = pools[Number(args[0])];
      else if (name === "assetOf") value = BigInt(assets.findIndex(asset => asset.token === String(args[0]).toLowerCase()) + 1);
      else value = values[name];
    } else if (target === FIXTURE.lane) {
      const values: Record<string, unknown> = { factory: FIXTURE.factory, owner: FIXTURE.owner, agent: state.agent, principal: state.principal, status: state.status, value: state.value, returnedUsdg: 123n, finalUsdg: 456n };
      value = name === "tracked" ? ledger[String(args[0]).toLowerCase()] ?? 0n : values[name];
    } else if (target === ADDRESSES.accessRegistry) value = state.blocked;
    else if (target === ADDRESSES.quoter) {
      const params = args[0] as any, buy = params.zeroForOne === (params.poolKey.currency0.toLowerCase() === ADDRESSES.usdg);
      const out = buy ? BigInt(params.exactAmount) * 10n ** 20n / 10000000000n : BigInt(params.exactAmount) * 10000000000n / 10n ** 20n;
      value = [out, 100000n];
    } else if (assets.some(asset => asset.proxy === target)) value = [1n, 10000000000n, BigInt(FIXTURE.time - 100), BigInt(FIXTURE.time - 100), 1n];
    else value = name === "paused" ? state.paused.has(target) : state.oraclePaused.has(target);
    if (value === undefined) throw new Error("unexpected fixture function");
    return encodeFunctionResult({ abi, functionName: name, result: value } as any);
  }
  const rpc: ReadRpc = { async request<T>(method: string, params: unknown[]): Promise<T> {
    state.calls.push(method);
    if (method === "eth_chainId") return "0x1237" as T;
    if (method === "web3_clientVersion") return "anvil/fake" as T;
    if (method === "eth_getBalance") return "0x38d7ea4c68000" as T;
    if (method === "eth_getBlockByNumber") return { number: "0x7b", timestamp: "0x" + FIXTURE.time.toString(16), hash: "0x" + "5".repeat(64) } as T;
    if (method === "eth_call") {
      const transaction = params[0] as { to: string; data: `0x${string}` }, target = transaction.to.toLowerCase();
      if (target !== ADDRESSES.multicall3) return call(target, transaction.data) as T;
      const decoded = decodeFunctionData({ abi: MULTICALL_ABI, data: transaction.data });
      const results = (decoded.args![0] as readonly { target: string; callData: `0x${string}` }[]).map(entry => ({ success: true, returnData: call(entry.target.toLowerCase(), entry.callData) }));
      return encodeFunctionResult({ abi: MULTICALL_ABI, functionName: "aggregate3", result: results }) as T;
    }
    throw new Error("unexpected fixture RPC method");
  } };
  return { rpc, state, assets, ledger };
}
export async function serveFixture(rpc: ReadRpc) {
  const server = createServer((request, response) => {
    const parts: Buffer[] = [];
    request.on("data", part => parts.push(Buffer.from(part)));
    request.on("end", async () => {
      const body = JSON.parse(Buffer.concat(parts).toString());
      try { response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: await rpc.request(body.method, body.params) })); }
      catch { response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "fixture read failed" } })); }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
