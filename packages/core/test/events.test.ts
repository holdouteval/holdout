import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, type AbiEvent, type Hex } from "viem";
import { FACTORY_ABI, LANE_ABI, AGGREGATOR_ABI } from "../src/abi.js";
import { ANSWER_UPDATED_TOPIC } from "../src/chain.js";
import { decodeEvent, type RpcLog } from "../src/events.js";

const address = ("0x" + "ab".repeat(20)) as Hex;
const hash = ("0x" + "cd".repeat(32)) as Hex;
const required = ["TokenSet", "BurnAmountSet", "IdentityBaseSet", "AssetListed", "PoolListed", "LaneOpened",
  "Sealed", "Traded", "CloseStarted", "Exited", "Returned", "Closed", "Rescued", "OwnershipTransferred", "AnswerUpdated"];

test("event decoding covers factory, lane, ownership and signed feed events", () => {
  for (const name of required) {
    const event = [...FACTORY_ABI, ...LANE_ABI, ...AGGREGATOR_ABI].find((item) => item.type === "event" && item.name === name) as AbiEvent;
    assert.ok(event, name);
    const value = (type: string) => type === "address" ? address : type === "string" ? "Lane name"
      : type.startsWith("bytes") ? hash : Number(type.replace(/^u?int/, "")) <= 48
        ? type.startsWith("int") ? -42 : 9 : type.startsWith("int") ? -42n : 9n;
    const args = Object.fromEntries(event.inputs.map((input, i) => [input.name || String(i), value(input.type)]));
    const topics = encodeEventTopics({ abi: [event], eventName: name, args });
    const dataInputs = event.inputs.filter((input) => !input.indexed);
    const data = encodeAbiParameters(dataInputs, dataInputs.map((input) => value(input.type)));
    const log: RpcLog = { address: address.toUpperCase().replace("0X", "0x"), transactionHash: hash,
      blockNumber: "0x7b", logIndex: "0x4", topics: topics as string[], data };
    const decoded = decodeEvent(log);
    assert.ok(decoded, name);
    assert.equal(decoded.name, name);
    assert.deepEqual(decoded.args, args);
    assert.equal(decoded.block, 123);
    assert.equal(decoded.logIndex, 4);
    assert.equal(decoded.address, address);
    assert.equal(decoded.tx, hash);
    if (name === "AnswerUpdated") {
      assert.equal(topics[0], ANSWER_UPDATED_TOPIC);
      assert.equal(decoded.args.current, -42n);
    }
    assert.equal(decodeEvent({ ...log, removed: true }), null);
  }
  assert.equal(decodeEvent({ address, transactionHash: hash, blockNumber: "0x1", logIndex: "0x0", topics: [hash], data: "0x" }), null);
});
