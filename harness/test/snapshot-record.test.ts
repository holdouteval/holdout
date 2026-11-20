import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { snapshotRecordFixture } from "./snapshot-record-fixture.js";

test("C2 real snapshot adapter preserves frozen record bytes and hashes", async () => {
  for (const blocked of [false, true]) {
    const expected = await readFile(new URL(`../../test/fixtures/snapshot-record-${blocked ? "blocked" : "open"}.json`, import.meta.url));
    const actual = await snapshotRecordFixture(blocked);
    assert.deepEqual(Buffer.from(actual.bytes), expected);
    assert.equal(actual.h, (await import("@holdout/core")).sha256Hex(expected));
    assert.ok(actual.value.snapshot!.assets.every(asset => !Object.hasOwn(asset, "paused") && !Object.hasOwn(asset, "oraclePaused")));
  }
});
