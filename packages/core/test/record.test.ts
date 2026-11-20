import test from "node:test";
import assert from "node:assert/strict";
import { validateRecord, inspectHouseRecord } from "../src/record.js";

const envelope = { schema: "holdout.record/1", chainId: 4663, lane: "0x" + "ab".repeat(20), kind: "decision", time: 1_800_000_000 };

test("T2 record envelope validates only its declared fields", () => {
  const value = { ...envelope, decision: { arbitrary: [true, "content"] }, custom: "preserved" };
  assert.equal(validateRecord(value), value);
  for (const change of [{ schema: "other" }, { chainId: 1 }, { lane: envelope.lane.toUpperCase() },
    { lane: "0x1234" }, { kind: "execution" }, { time: 1.5 }, { time: 2 ** 53 }, { time: -0 }]) {
    assert.throws(() => validateRecord({ ...envelope, ...change }));
  }
  for (const value of [null, [], "x", 1]) assert.throws(() => validateRecord(value));
});

test("T2 house fields are independent from envelope acceptance", () => {
  const good = { ...envelope, decision: { weights: { SPY: "0.5", NVDA: "1.000", USDG: "0" }, reason: "A reason" } };
  assert.deepEqual(inspectHouseRecord(good), { weights: good.decision.weights, reason: "A reason" });
  for (const decision of [undefined, [], { weights: [], reason: "x" }, { weights: { SPY: 0.5 }, reason: "x" },
    { weights: { SPY: "1.0000000000000000001" }, reason: "x" }, { weights: { SPY: "-0.1" }, reason: "x" },
    { weights: { SPY: "1e-1" }, reason: "x" }, { weights: { SPY: "0.5" }, reason: 1 }]) {
    const record = { ...envelope, decision };
    assert.equal(validateRecord(record), record);
    assert.equal(inspectHouseRecord(record), null);
  }
});
