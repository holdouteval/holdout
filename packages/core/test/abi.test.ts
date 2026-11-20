import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FACTORY_ABI, LANE_ABI } from "../src/abi.js";

test("T13 generated ABI matches immutable build artifacts", () => {
  execFileSync(process.execPath, [fileURLToPath(new URL("../../scripts/sync-abi.mjs", import.meta.url)), "--check"], { stdio: "pipe" });
  const seals = LANE_ABI.find((entry) => entry.type === "function" && entry.name === "seals");
  assert.ok(seals && seals.type === "function");
  assert.deepEqual(seals.outputs.map((o) => [o.type, o.name]), [["uint64", "at"], ["bool", "acted"], ["bytes32", "legsHash"]]);
  assert.equal(FACTORY_ABI.filter((e) => e.type === "event" && e.name === "LaneOpened").length, 1);
});
