import test from "node:test";
import assert from "node:assert/strict";
import { sessions, isTradingDay, nextDecision } from "../src/calendar.js";
const time = (value: string) => Date.parse(value) / 1000;

test("T4 holiday and early-close sessions", () => {
  assert.equal(isTradingDay("2026-11-26"), false);
  assert.equal(isTradingDay("2026-11-27"), true);
  assert.deepEqual(sessions(time("2026-11-26T00:00:00Z"), time("2026-11-28T23:59:59Z")), [
    [time("2026-11-27T14:30:00Z"), time("2026-11-27T15:00:00Z"), time("2026-11-27T18:00:00Z")],
  ]);
});

test("T4 New York daylight saving changes the decision's UTC hour", () => {
  const found = sessions(time("2027-03-12T00:00:00Z"), time("2027-03-15T23:59:59Z"));
  assert.equal(found.length, 2);
  assert.equal(found[0][1], time("2027-03-12T15:00:00Z"));
  assert.equal(found[1][1], time("2027-03-15T14:00:00Z"));
});

test("T4 next decision respects weekends, holidays and the exact decision boundary", () => {
  assert.equal(nextDecision(time("2026-11-27T14:59:59Z")), time("2026-11-27T15:00:00Z"));
  assert.equal(nextDecision(time("2026-11-27T15:00:00Z")), time("2026-11-30T15:00:00Z"));
  assert.equal(nextDecision(time("2026-11-28T16:00:00Z")), time("2026-11-30T15:00:00Z"));
  assert.throws(() => isTradingDay("2028-01-03"));
  assert.throws(() => sessions(time("2027-12-31T00:00:00Z"), time("2028-01-01T12:00:00Z")));
  assert.throws(() => nextDecision(time("2028-01-03T00:00:00Z")));
});
