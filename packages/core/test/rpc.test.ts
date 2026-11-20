import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, basename } from "node:path";
import { RpcClient, RpcError, sanitize } from "../src/rpc.js";
import type { RpcLog } from "../src/events.js";

type Request = { jsonrpc: string; id: number; method: string; params: unknown[] };
type Reply = { status?: number; headers?: Record<string, string>; result?: unknown; error?: unknown; hang?: boolean };

async function fake(handler: (request: Request) => Reply) {
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Request;
    const result = handler(body);
    if (result.hang) return;
    response.writeHead(result.status ?? 200, { "Content-Type": "application/json", ...result.headers });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id,
      ...(result.error ? { error: result.error } : { result: result.result }) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())) };
}

const quick = { stateIntervalMs: 0, executionIntervalMs: 0, attempts: 1 };

test("T5 429 honors Retry-After before trying the fallback, with chain checks", async () => {
  const order: string[] = [], waits: number[] = [], messages: string[] = [];
  const first = await fake((r) => {
    order.push("public:" + r.method);
    return r.method === "eth_chainId" ? { result: "0x1237" } : { status: 429, headers: { "Retry-After": "2" }, error: { code: 429 } };
  });
  const second = await fake((r) => {
    order.push("fallback:" + r.method);
    if (r.method !== "eth_chainId") assert.deepEqual(waits, [2000]);
    return { result: r.method === "eth_chainId" ? "0x1237" : "0x7b" };
  });
  try {
    const rpc = new RpcClient({ ...quick, publicUrl: first.url, fallback: second.url,
      sleep: async (delay) => { waits.push(delay); }, logger: (line) => messages.push(line) });
    assert.equal(await rpc.request("eth_blockNumber", []), "0x7b");
    assert.deepEqual(order, ["public:eth_chainId", "public:eth_blockNumber", "fallback:eth_chainId", "fallback:eth_blockNumber"]);
    assert.equal(rpc.stats.requests, 4);
    assert.ok(messages.every((line) => !line.includes(first.url) && !line.includes(second.url)));
  } finally { await first.close(); await second.close(); }
});

test("T5 mismatched chain is rejected and unsupported methods never reach transport", async () => {
  const methods: string[] = [];
  const server = await fake((r) => { methods.push(r.method); return { result: "0x1" }; });
  try {
    const rpc = new RpcClient({ ...quick, override: server.url, sleep: async () => {} });
    await assert.rejects(rpc.request("eth_blockNumber", []), /endpoints failed/);
    await assert.rejects(rpc.request("eth_sendRawTransaction", ["0x"]), /not allowed/);
    await assert.rejects(rpc.request("eth_sign", []), /not allowed/);
    assert.deepEqual(methods, ["eth_chainId"]);
    assert.throws(() => new RpcClient({ override: "https://example.invalid" }), /loopback/);
    assert.throws(() => new RpcClient({ override: "http://127.0.0.1.example.invalid" }), /loopback/);
  } finally { await server.close(); }
});

test("T5 an unresponsive endpoint times out and the fallback completes the read", async () => {
  const first = await fake((r) => r.method === "eth_chainId" ? { result: "0x1237" } : { hang: true });
  const second = await fake((r) => ({ result: r.method === "eth_chainId" ? "0x1237" : "0x4" }));
  try {
    const rpc = new RpcClient({ ...quick, publicUrl: first.url, fallback: second.url, timeoutMs: 50, sleep: async () => {} });
    assert.equal(await rpc.request("eth_blockNumber", []), "0x4");
    assert.equal(rpc.stats.requests, 4);
  } finally { await first.close(); await second.close(); }
});

test("T5 localhost connects through IPv4 and serializes concurrent reads", async () => {
  let chainChecks = 0;
  const times: number[] = [];
  const server = await fake((r) => {
    if (r.method === "eth_chainId") { chainChecks++; return { result: "0x1237" }; }
    times.push(Date.now()); return { result: "0x2" };
  });
  try {
    const rpc = new RpcClient({ ...quick, override: server.url.replace("127.0.0.1", "localhost"), stateIntervalMs: 35 });
    assert.deepEqual(await Promise.all([rpc.request("eth_blockNumber", []), rpc.request("eth_blockNumber", []), rpc.request("eth_blockNumber", [])]), ["0x2", "0x2", "0x2"]);
    assert.equal(chainChecks, 1);
    assert.ok(times[1] - times[0] >= 25);
    assert.ok(times[2] - times[1] >= 25);
  } finally { await server.close(); }
});

test("T15 RPC errors, results, dotenv values and local identities are redacted", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "core-rpc-"));
  let secret = "";
  const primary = await fake((r) => r.method === "eth_chainId" ? { result: "0x1237" } : { status: 503 });
  const secondary = await fake((r) => r.method === "eth_chainId" ? { result: "0x1237" } : {
    error: { code: -32000, message: "failure " + secret + " " + homedir() + "/private/file", data: { endpoint: secret } },
  });
  secret = secondary.url.replace("http://", "http://sample:dummy-token@") + "/rpc?token=private-test-token";
  await writeFile(join(temporary, ".env"), "IGNORED_VALUE=unused\nRHC_RPC_FALLBACK='" + secret + "'\n");
  const messages: string[] = [];
  try {
    const rpc = new RpcClient({ ...quick, publicUrl: primary.url, envFile: join(temporary, ".env"), sleep: async () => {}, logger: (s) => messages.push(s) });
    let caught: unknown;
    try { await rpc.request("eth_call", []); } catch (error) { caught = error; }
    assert.ok(caught instanceof RpcError);
    const output = JSON.stringify({ messages, message: caught.message, data: caught.data });
    for (const needle of [secret, "dummy-token", "private-test-token", homedir(), basename(homedir())]) assert.equal(output.includes(needle), false, needle);
    assert.ok(output.includes("[endpoint]"));
    assert.ok(output.includes("[path]"));
    assert.equal(sanitize("https://a.invalid/x"), "[endpoint]");
  } finally { await primary.close(); await secondary.close(); await rm(temporary, { recursive: true, force: true }); }
});

const hash = "0x" + "ab".repeat(32);
function log(block: number, index = 0): RpcLog {
  return { address: "0x" + "12".repeat(20), blockNumber: "0x" + block.toString(16), logIndex: "0x" + index.toString(16), transactionHash: hash, topics: [hash], data: "0x" };
}

test("T6 range refusal bisects and leaves no missing or duplicated logs", async () => {
  const ranges: [number, number][] = [];
  const server = await fake((r) => {
    if (r.method === "eth_chainId") return { result: "0x1237" };
    const filter = r.params[0] as { fromBlock: string; toBlock: string };
    const from = Number(BigInt(filter.fromBlock)), to = Number(BigInt(filter.toBlock)); ranges.push([from, to]);
    if (to - from > 2) return { error: { code: -32005, message: "block range limit" } };
    return { result: Array.from({ length: to - from + 1 }, (_, i) => log(from + i)) };
  });
  try {
    const rpc = new RpcClient({ ...quick, override: server.url });
    const output = await rpc.getLogs({ fromBlock: 0, toBlock: 10, address: "0x" + "12".repeat(20) });
    assert.deepEqual(output.map((l) => Number(BigInt(l.blockNumber))), Array.from({ length: 11 }, (_, i) => i));
    assert.equal(rpc.stats.logCalls, ranges.length);
    assert.deepEqual(ranges[0], [0, 10]);
  } finally { await server.close(); }
});

test("T6 truncation at the result limit is retried as smaller ranges", async () => {
  const server = await fake((r) => {
    if (r.method === "eth_chainId") return { result: "0x1237" };
    const filter = r.params[0] as { fromBlock: string; toBlock: string };
    const from = Number(BigInt(filter.fromBlock)), to = Number(BigInt(filter.toBlock));
    const records: RpcLog[] = [];
    for (let b = from; b <= to; b++) for (let i = 0; i < 2501; i++) records.push(log(b, i));
    return { result: records.slice(0, 10_000) };
  });
  try {
    const rpc = new RpcClient({ ...quick, override: server.url });
    const output = await rpc.getLogs({ fromBlock: 1, toBlock: 4, address: "0x" + "12".repeat(20) });
    assert.equal(output.length, 10_004);
    assert.equal(rpc.stats.logCalls, 3);
    assert.equal(output.at(-1)?.blockNumber, "0x4");
    assert.equal(output.at(-1)?.logIndex, "0x9c4");
  } finally { await server.close(); }
});

test("T6 requests begin with bounded chunks even across a large interval", async () => {
  const ranges: [number, number][] = [];
  const server = await fake((r) => {
    if (r.method === "eth_chainId") return { result: "0x1237" };
    const f = r.params[0] as { fromBlock: string; toBlock: string };
    ranges.push([Number(BigInt(f.fromBlock)), Number(BigInt(f.toBlock))]); return { result: [] };
  });
  try {
    await new RpcClient({ ...quick, override: server.url }).getLogs({ fromBlock: 100, toBlock: 130_100, address: [] });
    assert.deepEqual(ranges, [[100, 62599], [62600, 125099], [125100, 130100]]);
    assert.ok(ranges.every(([a, b]) => b - a + 1 <= 100_000));
  } finally { await server.close(); }
});
