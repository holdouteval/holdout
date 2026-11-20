import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, encodeFunctionResult, encodeErrorResult, type Abi, type Hex } from "viem";
import { ACCESS_ABI, ADDRESSES, FACTORY_ABI, FEEDS, LANE_ABI, MULTICALL_ABI, PROXY_ABI, QUOTER_ABI, STOCK_ABI,
  blockAtTime, decodeRevert, normalizePoolKey, quoteExactInput, readContracts, readFactory, readHeader, readLaneState, readMarkets,
  redactSecrets, registerSecret, revertData, safeError, secretValues, type ReadRpc } from "../src/index.js";

const address = (byte: string) => `0x${byte.repeat(40)}`;
const hash = (byte: string) => `0x${byte.repeat(64)}`;
const key = { currency0: ADDRESSES.usdg, currency1: FEEDS[0].token, fee: 3000, tickSpacing: 60, hooks: address("0") };

test("quoter encodes sorted currencies, both directions, exact input and fixed block", async () => {
  const calls: unknown[][] = [];
  const rpc: ReadRpc = { async request<T>(method: string, params: unknown[]): Promise<T> {
    assert.equal(method, "eth_call"); calls.push(params);
    const transaction = params[0] as { to: string; data: Hex };
    assert.equal(transaction.to, ADDRESSES.quoter); assert.equal(params[1], "0x7b");
    const decoded = decodeFunctionData({ abi: QUOTER_ABI, data: transaction.data });
    assert.equal(decoded.functionName, "quoteExactInputSingle");
    const input = decoded.args![0];
    assert.deepEqual([input.poolKey.currency0.toLowerCase(), input.poolKey.currency1.toLowerCase()], [key.currency0, key.currency1].sort());
    assert.equal(input.zeroForOne, calls.length === 1); assert.equal(input.exactAmount, 250_000_000n); assert.equal(input.hookData, "0x");
    return encodeFunctionResult({ abi: QUOTER_ABI, functionName: "quoteExactInputSingle", result: [123456n, 555n] }) as T;
  } };
  const reversed = { ...key, currency0: key.currency1, currency1: key.currency0 };
  assert.deepEqual(normalizePoolKey(reversed), key);
  assert.equal(await quoteExactInput(rpc, reversed, true, 250_000_000n, 123), 123456n);
  assert.equal(await quoteExactInput(rpc, key, false, 250_000_000n, "0x7b"), 123456n);
  await assert.rejects(() => quoteExactInput(rpc, key, true, 0n, 123), /range/);
  await assert.rejects(() => quoteExactInput(rpc, key, true, 1n << 128n, 123), /range/);
});

test("factory, lane, seal and market reads use one selected block and preserve integer precision", async () => {
  const blocks: unknown[] = [], functions: string[] = [], principalTargets: string[] = [];
  const abis = [FACTORY_ABI, LANE_ABI, STOCK_ABI, PROXY_ABI, ACCESS_ABI];
  const responder = (name: string, args: readonly unknown[] | undefined, target: string): unknown => {
    switch (name) {
      case "assetCount": return 1n; case "poolCount": return 1n;
      case "principal": principalTargets.push(target); return target === address("1") ? 250_000_000n : 10n ** 24n;
      case "maxAge": return 86400n; case "actWindow": return 900n;
      case "usdg": return ADDRESSES.usdg; case "accessRegistry": return ADDRESSES.accessRegistry;
      case "assetAt": assert.equal(args![0], 0n); return { token: FEEDS[0].token, feed: FEEDS[0].proxy };
      case "poolAt": return { token: FEEDS[0].token, key, poolId: hash("b") };
      case "assetOf": assert.equal(String(args![0]).toLowerCase(), FEEDS[0].token); return 1n;
      case "tracked": return target === address("1") ? 9007199254740993123n : 0n;
      case "status": return 0; case "agent": return address("2"); case "owner": return address("3");
      case "seals": return [1700000000n, true, hash("c")];
      case "paused": return false; case "oraclePaused": return true;
      case "latestRoundData": return [2n ** 70n, 98765432100n, 1699999999n, 1700000000n, 2n ** 70n];
      case "isBlocked": assert.equal(String(args![0]).toLowerCase(), address("1")); return true;
      default: throw new Error("unexpected function " + name);
    }
  };
  const rpc: ReadRpc = { async request<T>(method: string, params: unknown[]): Promise<T> {
    assert.equal(method, "eth_call"); blocks.push(params[1]);
    const transaction = params[0] as { to: string; data: Hex };
    assert.equal(transaction.to, ADDRESSES.multicall3);
    const aggregate = decodeFunctionData({ abi: MULTICALL_ABI, data: transaction.data });
    const result = aggregate.args![0].map(call => {
      let decoded: { functionName: string; args?: readonly unknown[] } | undefined, abi: Abi | undefined;
      for (const candidate of abis) {
        try { decoded = decodeFunctionData({ abi: candidate, data: call.callData }); abi = candidate; break; } catch {}
      }
      assert.ok(decoded && abi); functions.push(decoded.functionName);
      return { success: true, returnData: encodeFunctionResult({ abi, functionName: decoded.functionName,
        result: responder(decoded.functionName, decoded.args, call.target.toLowerCase()) }) };
    });
    return encodeFunctionResult({ abi: MULTICALL_ABI, functionName: "aggregate3", result }) as T;
  } };
  const factory = await readFactory(rpc, address("4"), 123);
  assert.equal(factory.assets[0].symbol, FEEDS[0].symbol); assert.equal(factory.assets[0].assetOf, 1);
  assert.equal(factory.pools[0].poolId, hash("b")); assert.ok(!("principal" in factory)); assert.deepEqual(principalTargets, []);
  const state = await readLaneState(rpc, address("1"), [FEEDS[0].token, FEEDS[0].token.toUpperCase()], 123, [hash("a")]);
  assert.equal(Object.keys(state.ledger).length, 1); assert.equal(state.ledger[FEEDS[0].token], 9007199254740993123n);
  assert.deepEqual(state.seals[hash("a")], { at: 1700000000, acted: true, legsHash: hash("c") });
  assert.equal(state.status, 0); assert.equal(state.agent, address("2"));
  assert.equal(state.principal, 250_000_000n);
  const other = await readLaneState(rpc, address("5"), [], 123, [hash("a")]);
  assert.equal(other.principal, 10n ** 24n); assert.deepEqual(other.seals[hash("a")], state.seals[hash("a")]);
  assert.deepEqual(principalTargets, [address("1"), address("5")]);
  const markets = await readMarkets(rpc, factory.assets, address("1"), 123);
  assert.equal(markets.blocked, true); assert.equal(markets.assets[0].paused, false); assert.equal(markets.assets[0].oraclePaused, true);
  assert.equal(markets.assets[0].roundId, 2n ** 70n); assert.equal(markets.assets[0].answer, 98765432100n);
  assert.ok(blocks.length >= 5); assert.ok(blocks.every(block => block === "0x7b"));
  for (const name of ["assetCount", "assetAt", "poolCount", "poolAt", "assetOf", "principal", "maxAge", "actWindow", "tracked", "status", "seals", "isBlocked", "paused", "oraclePaused", "latestRoundData"]) assert.ok(functions.includes(name), name);
});

test("multicall propagates a failed selected-block read", async () => {
  const rpc: ReadRpc = { async request<T>(): Promise<T> { return encodeFunctionResult({ abi: MULTICALL_ABI, functionName: "aggregate3",
    result: [{ success: false, returnData: "0x" }] }) as T; } };
  await assert.rejects(() => readContracts(rpc, [{ target: address("1"), abi: LANE_ABI, functionName: "status" }], 10), /status/);
});

test("all generated lane and factory custom errors decode with JSON-safe arguments", () => {
  const definitions = [...LANE_ABI, ...FACTORY_ABI].filter(entry => entry.type === "error");
  const required = ["NotAuthorized", "WrongStatus", "NotListed", "OverTracked", "ZeroAmount", "ZeroHash", "NoLegs", "AlreadySealed", "AlreadyActed", "ActWindowPassed", "LegsMismatch", "NotTradable", "DiscountToFeed", "StaleFeed", "BadFeed", "TokenPaused", "OracleFlagged", "LaneBlocked", "MinOut", "PartialFill", "NothingToExit", "BadConfig", "PrincipalMismatch", "ZeroPrincipal"];
  for (const entry of definitions) {
    const args = entry.inputs.map(input => input.type === "address" ? address("a") : input.type === "bytes32" ? hash("b") : 9007199254740993123n);
    const data = encodeErrorResult({ abi: [entry], errorName: entry.name, args });
    const decoded = decodeRevert(data); assert.equal(decoded.name, entry.name);
    assert.deepEqual(decoded.args, args.map(arg => typeof arg === "bigint" ? arg.toString() : arg.toLowerCase()));
    assert.doesNotThrow(() => JSON.stringify(decoded));
  }
  for (const name of required) assert.ok(definitions.some(entry => entry.name === name), name);
  assert.deepEqual(decodeRevert("0x1234"), { name: "Reverted", args: ["0x1234"] });
  assert.equal(revertData({ error: { data: { originalError: { data: "0x1234" } } } }), "0x1234");
  assert.equal(revertData({ message: "transport failed 0x1234" }), null);
  assert.equal(revertData({ error: { data: "0x" } }), "0x");
});

test("exact secrets are shared in memory and removed before sanitizing diagnostic text", () => {
  const value = "test-provider-key-3575"; registerSecret(value);
  assert.ok(secretValues().includes(value)); assert.equal(redactSecrets({ value, quantity: 100n }), '{"value":"[secret]","quantity":"100"}');
  const diagnostic = safeError(new Error(`request https://user:${value}@example.invalid/rpc?key=${value} failed ${value}`));
  assert.ok(!diagnostic.includes(value)); assert.ok(!diagnostic.includes("user:"));
});

test("blockAtTime finds the first matching block including repeated timestamps and waits for a future head", async () => {
  const timestamps = [100, 101, 101, 103, 104, 108]; let head = 3, sleeps = 0;
  const rpc: ReadRpc = { async request<T>(method: string, params: unknown[]): Promise<T> {
    assert.equal(method, "eth_getBlockByNumber"); assert.equal(params[1], false);
    const index = params[0] === "latest" ? head : Number(BigInt(params[0] as string));
    return { number: "0x" + index.toString(16), timestamp: "0x" + timestamps[index].toString(16), hash: hash("a") } as T;
  } };
  assert.equal((await readHeader(rpc)).block, 3);
  assert.equal(await blockAtTime(rpc, 99), 0); assert.equal(await blockAtTime(rpc, 101), 1);
  assert.equal(await blockAtTime(rpc, 102), 3);
  assert.equal(await blockAtTime(rpc, 107, { sleep: async ms => { assert.equal(ms, 1000); sleeps++; head++; } }), 5);
  assert.equal(sleeps, 2); await assert.rejects(() => blockAtTime(rpc, -1), /target/);
});
