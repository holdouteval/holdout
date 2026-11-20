import test from "node:test";
import assert from "node:assert/strict";
import { canonicalize, parseCanonical, sha256Hex } from "../src/canonical.js";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (value: unknown) => new TextDecoder().decode(canonicalize(value));

test("T1 canonical ordering uses UTF-16 code units and lexical numeric keys", () => {
  assert.equal(text({ "\uffff": 1, "😀": 2, "2": 3, "10": 4 }), '{"10":4,"2":3,"😀":2,"￿":1}');
  assert.equal(text({ a: "/é\u001f\b\f\n\r\t\"\\" }), '{"a":"/é\\u001f\\b\\f\\n\\r\\t\\\"\\\\"}');
  assert.deepEqual(parseCanonical(canonicalize({ z: [null, true, 2], a: "世界" })), { a: "世界", z: [null, true, 2] });
});

test("T1 safe integer boundary and forbidden value classes", () => {
  assert.equal(text(Number.MAX_SAFE_INTEGER), "9007199254740991");
  for (const value of [2 ** 53, -(2 ** 53), -0, 0.1, NaN, Infinity, undefined, 1n, new Date(), Symbol("x")]) {
    assert.throws(() => canonicalize(value));
  }
  const circular: unknown[] = []; circular.push(circular);
  assert.throws(() => canonicalize(circular));
  assert.throws(() => canonicalize(new Array(1)));
  assert.throws(() => canonicalize({ get a() { return 1; } }));
});

test("T1 alternative spellings, duplicate keys and whitespace are rejected by exact bytes", () => {
  for (const value of ["1.0", "1e3", "-0", " 1", "1\n", '{"b":2,"a":1}', '{"a":1,"a":1}',
    '"\\/"', '"\\u00e9"', '"\\u001F"']) assert.throws(() => parseCanonical(bytes(value)), value);
});

test("T1 malformed UTF-8, BOM and unpaired surrogates are rejected", () => {
  assert.throws(() => parseCanonical(Uint8Array.from([0xc3, 0x28])));
  assert.throws(() => parseCanonical(Uint8Array.from([0xef, 0xbb, 0xbf, 0x31])));
  for (const value of ['"\\ud800"', '"\\udfff"', '{"\\ud800":1}']) assert.throws(() => parseCanonical(bytes(value)));
  assert.throws(() => canonicalize("\ud800"));
  assert.equal(text("😀"), '"😀"');
});

test("T1 sha256 produces lowercase prefixed digest of the original bytes", () => {
  assert.equal(sha256Hex(bytes("abc")), "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
