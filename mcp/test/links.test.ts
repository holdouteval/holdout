import assert from "node:assert/strict";
import test from "node:test";
import { siteLink } from "../src/links.js";
import { parseCommand } from "../src/options.js";

const lane = "0x" + "A".repeat(40);
test("M13 opening and closing links retain the exact fragment routes and lowercase addresses", () => {
  assert.equal(siteLink("https://example.test/", "open", lane), `https://example.test/#open?agent=${lane.toLowerCase()}`);
  assert.equal(siteLink("https://example.test", "close", lane), `https://example.test/#close?lane=${lane.toLowerCase()}`);
  assert.equal(siteLink(null, "open", lane), null); assert.equal(siteLink(null, "close", lane), null);
});
test("M2 command options honor explicit values, environment fallbacks and absent domains", () => {
  assert.deepEqual(parseCommand(["--help"], {}, "/tmp/fixture"), { kind: "help" });
  const empty = parseCommand(["--lane", lane], {}, "/tmp/fixture");
  assert.equal(empty.kind, "serve"); if (empty.kind !== "serve") return;
  assert.equal(empty.config.lane, lane.toLowerCase()); assert.equal(empty.config.dataBase, null); assert.equal(empty.config.siteBase, null);
  const command = parseCommand(["--lane", lane, "--data", "https://explicit.test/data", "--site", "https://explicit.test/", "--rpc", "http://127.0.0.1:18881", "--key", "/tmp/agent.key"],
    { HOLDOUT_HOME: "/tmp/fixture-state", HOLDOUT_DATA: "https://ignored.test", HOLDOUT_SITE: "https://ignored.test" });
  assert.equal(command.kind, "serve"); if (command.kind !== "serve") return;
  assert.equal(command.config.dataBase, "https://explicit.test/data"); assert.equal(command.config.siteBase, "https://explicit.test"); assert.equal(command.config.home, "/tmp/fixture-state");
  assert.equal(command.config.rpc, "http://127.0.0.1:18881"); assert.equal(command.config.keyFile, "/tmp/agent.key");
  assert.deepEqual(parseCommand(["init"], { HOLDOUT_HOME: "/tmp/state" }), { kind: "init", home: "/tmp/state", name: "agent", site: null });
  assert.deepEqual(parseCommand(["init", "--name", "new-agent"], { HOLDOUT_HOME: "/tmp/state", HOLDOUT_SITE: "https://example.test" }), { kind: "init", home: "/tmp/state", name: "new-agent", site: "https://example.test" });
});
test("M2 unknown or incomplete options and nonloopback RPC overrides fail before startup", () => {
  for (const args of [["--lane"], ["--lane", lane, "--unknown", "value"], ["init", "--lane", lane], ["--lane", lane, "--lane", lane], ["--lane", "wrong"],
    ["--lane", lane, "--rpc", "https://provider.example"], ["--lane", lane, "--rpc", "http://localhost:18881"], ["--lane", lane, "--rpc", "http://127.0.0.2:18881"],
    ["--lane", lane, "--site", "https://user:password@example.test"]]) assert.throws(() => parseCommand(args, {}));
});
