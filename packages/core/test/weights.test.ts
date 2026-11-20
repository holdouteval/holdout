import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWeights, weightMicros } from "../src/index.js";

test("C1 weights retain exact decimal normalization and millionth floors", () => {
  assert.deepEqual(normalizeWeights({ aaa: "0.123456999", BBB: -3, USDG: 1, OUT: 7, CCC: {}, DDD: "NaN" }, ["AAA", "BBB", "CCC", "DDD"]), { AAA: "0.123456" });
  assert.deepEqual(normalizeWeights({ AAA: "2", BBB: 1 }, ["AAA", "BBB"]), { AAA: "0.666666", BBB: "0.333333" });
  assert.deepEqual(normalizeWeights({ AAA: "1e-6", BBB: ".000000999", CCC: "1.00000000000000001" }, ["AAA", "BBB", "CCC"]), { CCC: "0.999998" });
  assert.equal(weightMicros(".123456999"), 123456n);
  assert.equal(weightMicros("1e-6"), 1n);
  assert.equal(weightMicros("-1"), 0n);
  assert.throws(() => weightMicros("not-a-number"), /invalid decision weight/);
});
