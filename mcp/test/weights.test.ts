import test from "node:test";
import assert from "node:assert/strict";
import { strictWeights } from "../src/weights.js";

test("M5 strict weights reject every invalid class before normalization", () => {
  for (const value of [null, [], { UNKNOWN: 0.2 }, { USDG: 0 }, { NVDA: -0.1 }, { NVDA: 1.1 }, { NVDA: NaN },
    { NVDA: Infinity }, { NVDA: "NaN" }, { NVDA: "0x1" }, { NVDA: true }, { NVDA: null },
    { NVDA: "0.5000001", AAPL: "0.5000001" }, { NVDA: 0.7, AAPL: 0.4 }]) {
    assert.throws(() => strictWeights(value, ["NVDA", "AAPL"]), /invalid-weights/);
  }
});
test("M5 valid weights retain shared millionth flooring and uppercase symbols", () => {
  assert.deepEqual(strictWeights({ nvda: "0.2500009", AAPL: 0.5 }, ["NVDA", "AAPL"]), { NVDA: "0.25", AAPL: "0.5" });
  assert.deepEqual(strictWeights({ NVDA: 1 }, ["NVDA"]), { NVDA: "1" });
  assert.deepEqual(strictWeights({ NVDA: 1e-7, AAPL: "0" }, ["NVDA", "AAPL"]), {});
});
