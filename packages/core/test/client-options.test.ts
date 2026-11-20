import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcClient, SendClient, SendBoundaryError } from "../src/index.js";

async function fake(options: { fail?: boolean; chain?: string; version?: string } = {}) {
  const requests: string[] = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString()); requests.push(input.method);
    response.writeHead(options.fail ? 503 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result: input.method === "eth_chainId" ? options.chain ?? "0x1237"
      : input.method === "web3_clientVersion" ? options.version ?? "anvil/test" : "0x7b" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { options, requests, url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
const quick = { stateIntervalMs: 0, executionIntervalMs: 0, attempts: 1, sleep: async () => {} };

test("C3 envFile false performs no file reads while a real dotenv path exercises both read monitors", async () => {
  const server = await fake(), directory = await promises.mkdtemp(join(tmpdir(), "client-options-")), path = join(directory, ".env");
  await promises.writeFile(path, "RHC_RPC_FALLBACK=\n");
  const priorFallback = process.env.RHC_RPC_FALLBACK; delete process.env.RHC_RPC_FALLBACK;
  const originalSync = fs.readFileSync, originalAsync = promises.readFile, reads: string[] = [];
  fs.readFileSync = ((...args: unknown[]) => { reads.push(String(args[0])); return Reflect.apply(originalSync, fs, args); }) as typeof fs.readFileSync;
  promises.readFile = ((...args: unknown[]) => { reads.push(String(args[0])); return Reflect.apply(originalAsync, promises, args); }) as typeof promises.readFile;
  syncBuiltinESMExports();
  try {
    const referenceRead = new RpcClient({ ...quick, publicUrl: server.url, envFile: path });
    assert.equal(await referenceRead.request("eth_blockNumber", []), "0x7b");
    const referenceSend = new SendClient({ ...quick, url: server.url, envFile: path });
    assert.equal(await referenceSend.request("eth_chainId", []), "0x1237");
    assert.deepEqual(reads, [path, path]); reads.length = 0;
    const read = new RpcClient({ ...quick, publicUrl: server.url, envFile: false });
    assert.equal(await read.request("eth_blockNumber", []), "0x7b");
    const send = new SendClient({ ...quick, url: server.url, envFile: false });
    assert.equal(await send.request("eth_chainId", []), "0x1237");
    assert.deepEqual(reads, []);
  } finally {
    fs.readFileSync = originalSync; promises.readFile = originalAsync; syncBuiltinESMExports();
    if (priorFallback === undefined) delete process.env.RHC_RPC_FALLBACK; else process.env.RHC_RPC_FALLBACK = priorFallback;
    await server.close(); await promises.rm(directory, { recursive: true, force: true });
  }
});

test("C3 envFile false retains the environment-only fallback for both clients", async () => {
  const first = await fake({ fail: true }), second = await fake(), prior = process.env.RHC_RPC_FALLBACK;
  process.env.RHC_RPC_FALLBACK = second.url;
  try {
    assert.equal(await new RpcClient({ ...quick, publicUrl: first.url, envFile: false }).request("eth_blockNumber", []), "0x7b");
    assert.equal(await new SendClient({ ...quick, url: first.url, envFile: false }).request("eth_chainId", []), "0x1237");
    assert.ok(first.requests.length > 0); assert.ok(second.requests.includes("eth_blockNumber"));
  } finally {
    if (prior === undefined) delete process.env.RHC_RPC_FALLBACK; else process.env.RHC_RPC_FALLBACK = prior;
    await first.close(); await second.close();
  }
});

test("C3 authorization defaults stay disabled and an explicit callback still enforces chain and local anvil boundaries", async () => {
  assert.notEqual(process.env.HARNESS_SEND, "true");
  await assert.rejects(new SendClient({ url: "https://example.invalid", fallback: "", envFile: false }).assertBoundary(), /sending is not enabled/);
  let calls = 0;
  await assert.rejects(new SendClient({ url: "https://example.invalid", fallback: "", envFile: false,
    authorization: () => { calls++; return false; } }).assertBoundary(), /sending is not enabled/);
  assert.equal(calls, 1);
  // This boundary-only transport double never reads a key, signs, or sends a transaction.
  const nonlocal = new SendClient({ url: "https://example.invalid", fallback: "", envFile: false, authorization: () => true });
  let chain = "0x1237";
  (nonlocal as unknown as { post: (endpoint: unknown, method: string) => Promise<string> }).post = async (_endpoint, method) => {
    assert.equal(method, "eth_chainId"); return chain;
  };
  assert.deepEqual(await nonlocal.assertBoundary(), { local: false, chainId: 4663 });
  chain = "0x1"; await assert.rejects(nonlocal.assertBoundary(), /unexpected send chain/);
  const server = await fake();
  try {
    const local = new SendClient({ ...quick, override: server.url, envFile: false, authorization: () => true });
    assert.deepEqual(await local.assertBoundary(), { local: true, chainId: 4663 });
    server.options.chain = "0x1"; await assert.rejects(local.assertBoundary(), SendBoundaryError);
    server.options.chain = "0x1237"; server.options.version = "other-client";
    await assert.rejects(local.assertBoundary(), /not anvil/);
    await assert.rejects(new SendClient({ ...quick, override: server.url.replace("127.0.0.1", "localhost"), authorization: () => true }).assertBoundary(), /IPv4 loopback/);
    assert.ok(!server.requests.includes("eth_sendRawTransaction"));
  } finally { await server.close(); }
});
