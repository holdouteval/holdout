import test from "node:test";
import assert from "node:assert/strict";
import { legsHash } from "../src/legs.js";

test("T3 standard tuple-array hash includes the argument offset word", () => {
  const legs = [
    { pool: 18, buy: true, amountIn: "300000000", minOut: "0" },
    { pool: 9, buy: true, amountIn: "300000000", minOut: "0" },
    { pool: 17, buy: true, amountIn: "150000000", minOut: "0" },
    { pool: 10, buy: true, amountIn: "150000000", minOut: "0" },
  ];
  assert.equal(legsHash(legs), "0x6f2bc426107148b1c2d12cf840e4308cece231f1b94c6bb31f0137c49377cdb7");
  assert.notEqual(legsHash([...legs].reverse()), legsHash(legs));
  assert.throws(() => legsHash([{ ...legs[0], amountIn: 2 ** 53 }]));
  assert.throws(() => legsHash([{ ...legs[0], minOut: -1n }]));
});
