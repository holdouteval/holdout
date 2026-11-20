import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FIXTURE, readFixture, serveFixture } from "./read-fixtures.js";
import { PRINCIPAL_RULE } from "../src/read.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url)), execute = promisify(execFile);
function childEnvironment(home: string): Record<string, string> {
  const omitted = new Set(["HARNESS_SEND", "RHC_RPC_FALLBACK", "HOLDOUT_MCP_FAULT", "HOLDOUT_DATA", "HOLDOUT_SITE", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !omitted.has(key))) as Record<string, string>, HOLDOUT_HOME: home };
}
test("M1 CLI init emits exactly one JSON line and help executes without touching an agent key", async t => {
  const home = await mkdtemp(join(tmpdir(), "mcp-cli-")); t.after(() => rm(home, { recursive: true, force: true }));
  const env = childEnvironment(home), help = await execute(process.execPath, [cli, "--help"], { env });
  assert.ok(help.stdout.includes("--lane") && help.stdout.includes("init")); assert.equal(help.stderr, "");
  const result = await execute(process.execPath, [cli, "init"], { env });
  assert.equal(result.stderr, ""); assert.equal(result.stdout.trim().split("\n").length, 1);
  const value = JSON.parse(result.stdout), key = (await readFile(value.keyFile, "utf8")).trim();
  assert.equal(value.openUrl, null); assert.ok(value.note); assert.equal((await stat(value.keyFile)).mode & 0o7777, 0o600);
  assert.equal((result.stdout + result.stderr).includes(key), false); assert.equal((result.stdout + result.stderr).includes(key.slice(2)), false);
  await assert.rejects(execute(process.execPath, [cli, "init"], { env }), error => (error as any).code === 1 && (error as any).stdout === "" && (error as any).stderr.includes("agent-key-exists"));
});

test("M2 actual stdio startup is read only without a key and stdout remains valid MCP", async t => {
  const home = await mkdtemp(join(tmpdir(), "mcp-cli-")); t.after(() => rm(home, { recursive: true, force: true }));
  const fixture = readFixture(), rpc = await serveFixture(fixture.rpc); t.after(() => rpc.close());
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "--lane", FIXTURE.lane, "--rpc", rpc.url], env: childEnvironment(home), stderr: "pipe" });
  const client = new Client({ name: "fixture-client", version: "0.0.0" }), errors: unknown[] = [], stderr: string[] = [];
  client.onerror = error => errors.push(error); transport.stderr?.on("data", bytes => stderr.push(bytes.toString()));
  t.after(() => client.close()); await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 5);
  const rules = await client.callTool({ name: "holdout_rules", arguments: {} });
  assert.equal(JSON.parse((rules.content as any)[0].text).principal, PRINCIPAL_RULE);
  const result = await client.callTool({ name: "holdout_seal", arguments: { requestId: "readonly-1", model: "fixture", input: "input", output: "output" } });
  assert.equal(result.isError, true); assert.equal(JSON.parse((result.content as any)[0].text).error.code, "agent-key-missing");
  assert.deepEqual(errors, []); assert.ok(stderr.every(line => !line.includes(home))); assert.ok(!fixture.state.calls.includes("eth_sendRawTransaction"));
});

test("M2 actual startup rejects a lane absent from its claimed factory and nonloopback overrides", async t => {
  const home = await mkdtemp(join(tmpdir(), "mcp-cli-")); t.after(() => rm(home, { recursive: true, force: true }));
  const fixture = readFixture(); fixture.state.isLane = false;
  const rpc = await serveFixture(fixture.rpc); t.after(() => rpc.close()); const env = childEnvironment(home);
  await assert.rejects(execute(process.execPath, [cli, "--lane", FIXTURE.lane, "--rpc", rpc.url], { env }), error => (error as any).code === 1 && (error as any).stdout === "" && (error as any).stderr.includes("unknown-lane"));
  await assert.rejects(execute(process.execPath, [cli, "--lane", FIXTURE.lane, "--rpc", "http://provider.example"], { env }), error => (error as any).code === 1 && (error as any).stdout === "" && (error as any).stderr.includes("rpc-override-must-use-ipv4-loopback"));
});
