import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeErrorResult, keccak256, parseTransaction, recoverTransactionAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { LANE_ABI, NonceConflictError, SendBoundaryError, SendClient, redactSecrets, type SignedIntent } from "../src/index.js";

// This fixed test key is created only in a temporary directory.
const testKey = ("0x" + "42".repeat(32)) as Hex;
const from = privateKeyToAccount(testKey).address.toLowerCase();
const to = "0x" + "23".repeat(20), blockHash = "0x" + "ab".repeat(32);
type Request = { id: number; method: string; params: unknown[] };
type Reply = { result?: unknown; error?: { code: number; message: string; data?: unknown }; status?: number };
async function fixture() {
  const requests: Request[] = [], raw: string[] = [];
  let chain = "0x1237", version = "anvil/test", latest = "0x0", pending = "0x3", price = "0x7", mined = false, own = true;
  let estimate: Reply = { result: "0x5208" }, afterSend: (() => void) | undefined, afterLookup: (() => void) | undefined;
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString()) as Request; requests.push(input);
    let reply: Reply;
    switch (input.method) {
      case "eth_chainId": reply = { result: chain }; break;
      case "web3_clientVersion": reply = { result: version }; break;
      case "eth_getTransactionCount": reply = { result: input.params[1] === "pending" ? pending : latest }; break;
      case "eth_gasPrice": reply = { result: price }; break;
      case "eth_estimateGas": reply = estimate; break;
      case "eth_getTransactionByHash": reply = { result: own && raw.length ? {
        hash: input.params[0], from, nonce: "0x" + (parseTransaction(raw[raw.length - 1] as Hex).nonce ?? 0).toString(16), blockHash: mined ? blockHash : null,
      } : null }; afterLookup?.(); break;
      case "eth_sendRawTransaction": raw.push(String(input.params[0])); afterSend?.(); reply = { result: keccak256(input.params[0] as Hex) }; break;
      case "eth_getTransactionReceipt": reply = { result: mined ? {
        transactionHash: input.params[0], blockNumber: "0x7b", blockHash, status: "0x1", gasUsed: "0x5208", from, to,
      } : null }; break;
      default: reply = { error: { code: -32601, message: "unexpected method" } };
    }
    response.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, ...(reply.error ? { error: reply.error } : { result: reply.result }) }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const directory = await mkdtemp(join(tmpdir(), "core-send-")), keyFile = join(directory, "agent.key");
  await writeFile(keyFile, testKey.slice(2).toUpperCase() + "\n", { mode: 0o600 });
  let clock = Date.now();
  const client = new SendClient({ override: `http://127.0.0.1:${address.port}`, stateIntervalMs: 0, executionIntervalMs: 0,
    now: () => clock, sleep: async ms => { clock += ms; } });
  return { client, keyFile, requests, raw, url: `http://127.0.0.1:${address.port}`,
    chain: (value: string) => { chain = value; }, version: (value: string) => { version = value; },
    estimate: (value: Reply) => { estimate = value; }, latest: (value: string) => { latest = value; },
    pending: (value: string) => { pending = value; }, price: (value: string) => { price = value; },
    mined: (value: boolean) => { mined = value; }, own: (value: boolean) => { own = value; },
    afterSend: (value: () => void) => { afterSend = value; }, afterLookup: (value: () => void) => { afterLookup = value; }, now: () => clock,
    close: async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(directory, { recursive: true, force: true }); } };
}
async function prepare(f: Awaited<ReturnType<typeof fixture>>): Promise<SignedIntent> {
  const result = await f.client.prepare({ to, data: "0x1234", value: 9n, keyFile: f.keyFile, from });
  assert.ok(!result.reverted && !result.temporary); return result.signed;
}

test("local anvil signs EIP-1559 only after boundary checks; caller stores before sending", async () => {
  assert.notEqual(process.env.HARNESS_SEND, "true");
  const f = await fixture();
  try {
    const signed = await prepare(f); assert.equal(f.raw.length, 0);
    const decoded = parseTransaction(signed.rawTransaction);
    assert.equal(decoded.type, "eip1559"); assert.equal(decoded.chainId, 4663); assert.equal(decoded.nonce, 3);
    assert.equal(decoded.gas, 42000n); assert.equal(decoded.maxFeePerGas, 14n); assert.equal(decoded.maxPriorityFeePerGas ?? 0n, 0n);
    assert.equal(decoded.value, 9n); assert.equal(decoded.to?.toLowerCase(), to);
    assert.equal((await recoverTransactionAddress({ serializedTransaction: signed.rawTransaction as `0x02${string}` })).toLowerCase(), from);
    assert.equal(signed.hash, keccak256(signed.rawTransaction));
    assert.equal(f.requests.filter(request => request.method === "eth_chainId").length, 2);
    assert.ok(!JSON.stringify(signed).includes(testKey.slice(2)));
    for (const value of [testKey, testKey.slice(2), testKey.slice(2).toUpperCase()]) assert.ok(!redactSecrets(value).includes(value));
    let stored = false, hookCalls = 0; const saved = JSON.parse(JSON.stringify(signed)); stored = true;
    await f.client.broadcast(saved, { beforeBroadcast: async () => { assert.ok(stored); hookCalls++; } });
    assert.deepEqual(f.raw, [signed.rawTransaction]); assert.equal(hookCalls, 1);
    f.mined(true);
    assert.deepEqual(await f.client.wait(signed), { transactionHash: signed.hash, blockNumber: 123, blockHash, status: 1, gasUsed: "21000", from, to });
  } finally { await f.close(); }
});

test("nonlocal, non-anvil, wrong chain, unsupported methods and key permissions fail closed", async () => {
  const f = await fixture();
  try {
    const publicClient = new SendClient({ url: "https://example.invalid", fallback: "" });
    await assert.rejects(publicClient.prepare({ to, data: "0x", keyFile: "missing-file" }), SendBoundaryError);
    const namedLoopback = new SendClient({ override: f.url.replace("127.0.0.1", "localhost") });
    await assert.rejects(namedLoopback.assertBoundary(), /IPv4 loopback/);
    f.version("other-client"); await assert.rejects(() => prepare(f), /not anvil/);
    f.version("anvil/test"); f.chain("0x1"); await assert.rejects(() => prepare(f), /unexpected send chain/);
    f.chain("0x1237");
    await assert.rejects(f.client.request("eth_sendTransaction", []), /not allowed/);
    await assert.rejects(f.client.request("eth_sign", []), /not allowed/);
    await assert.rejects(f.client.request("eth_getBlockByNumber", []), /not allowed/);
    await chmod(f.keyFile, 0o640); await assert.rejects(() => prepare(f), /mode 600/);
    assert.equal(f.requests.some(request => request.method === "eth_estimateGas"), false); assert.equal(f.raw.length, 0);
  } finally { await f.close(); }
});

test("zero nonce, empty calldata and zero fees survive signed intent validation", async () => {
  const f = await fixture();
  try {
    f.pending("0x0"); f.price("0x0");
    const result = await f.client.prepare({ to, data: "0x", keyFile: f.keyFile });
    assert.ok(!result.reverted && !result.temporary); assert.equal(result.signed.nonce, "0");
    assert.equal(result.signed.maxFeePerGas, "0"); assert.equal(result.signed.value, "0");
    await f.client.broadcast(result.signed); assert.equal(f.raw.length, 1);
  } finally { await f.close(); }
});

test("estimate reverts return decoded data; no-data RPC and HTTP failures return temporary results", async () => {
  const f = await fixture();
  try {
    const data = encodeErrorResult({ abi: LANE_ABI, errorName: "DiscountToFeed", args: [to, 11n, 12n] });
    f.estimate({ error: { code: -32000, message: "execution reverted", data } });
    assert.deepEqual(await f.client.prepare({ to, data: "0x", keyFile: f.keyFile }), { reverted: true, error: { name: "DiscountToFeed", args: [to, "11", "12"] } });
    f.estimate({ error: { code: -32000, message: "service unavailable" } });
    const rpc = await f.client.prepare({ to, data: "0x", keyFile: f.keyFile }); assert.ok(!rpc.reverted && rpc.temporary);
    f.estimate({ status: 503 });
    const http = await f.client.prepare({ to, data: "0x", keyFile: f.keyFile }); assert.ok(!http.reverted && http.temporary);
    assert.equal(f.raw.length, 0);
  } finally { await f.close(); }
});

test("boundary is checked again immediately before signing and each broadcast", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.client.prepare({ to, data: "0x", keyFile: f.keyFile, beforeEstimate: async () => { f.chain("0x1"); } }), /unexpected send chain/);
    f.chain("0x1237"); const signed = await prepare(f);
    f.version("other-client"); await assert.rejects(f.client.broadcast(signed), /not anvil/);
    assert.equal(f.raw.length, 0);
  } finally { await f.close(); }
});

test("fresh quote hook failures propagate unchanged and tampered signed metadata is rejected", async () => {
  const f = await fixture();
  try {
    const signed = await prepare(f), moved = new Error("QuoteMoved");
    await assert.rejects(f.client.broadcast(signed, { beforeBroadcast: async () => { throw moved; } }), error => error === moved);
    await assert.rejects(f.client.broadcast({ ...signed, gas: "42001" }), /fields mismatch/);
    await assert.rejects(f.client.broadcast({ ...signed, from: to }), /sender mismatch/);
    assert.equal(f.raw.length, 0);
  } finally { await f.close(); }
});

test("pending transaction is retried after 120 seconds with identical bytes and a fresh quote hook", async () => {
  const f = await fixture();
  try {
    const signed = await prepare(f); let quotes = 0;
    const options = { beforeBroadcast: async () => { quotes++; } };
    await f.client.broadcast(signed, options); const started = f.now();
    f.afterSend(() => { f.mined(true); });
    const receipt = await f.client.wait(signed, options);
    assert.equal(receipt.transactionHash, signed.hash); assert.ok(f.now() - started >= 120000);
    assert.deepEqual(f.raw, [signed.rawTransaction, signed.rawTransaction]); assert.equal(quotes, 2);
  } finally { await f.close(); }
});

test("another transaction consuming the nonce stops without replacement", async () => {
  const f = await fixture();
  try {
    const signed = await prepare(f); f.latest("0x4"); f.own(false);
    await assert.rejects(f.client.broadcast(signed), NonceConflictError);
    await assert.rejects(f.client.wait(signed), NonceConflictError); assert.equal(f.raw.length, 0);
  } finally { await f.close(); }
});

test("own transaction mined between the nonce checks is waited for, not reported as a conflict", async () => {
  const f = await fixture();
  try {
    const signed = await prepare(f); await f.client.broadcast(signed);
    let once = false; f.afterLookup(() => { if (!once) { once = true; f.mined(true); f.latest("0x4"); } });
    const receipt = await f.client.wait(signed);
    assert.equal(receipt.transactionHash, signed.hash); assert.equal(receipt.status, 1); assert.deepEqual(f.raw, [signed.rawTransaction]);
  } finally { await f.close(); }
});

test("missing receipt expires after ten minutes without changing the signed transaction", async () => {
  const f = await fixture();
  try {
    const signed = await prepare(f); await f.client.broadcast(signed); const started = f.now();
    await assert.rejects(f.client.wait(signed), /receipt timeout/);
    assert.equal(f.now() - started, 600000); assert.equal(f.raw.length, 5); assert.ok(f.raw.every(raw => raw === signed.rawTransaction));
  } finally { await f.close(); }
});
