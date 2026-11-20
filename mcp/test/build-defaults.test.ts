import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FIXTURE, readFixture, serveFixture } from "./read-fixtures.js";

const execute = promisify(execFile), root = fileURLToPath(new URL("../../", import.meta.url));
const buildFile = join(root, "build.mjs"), bin = join(root, "dist/holdout-mcp.js");
function environment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOLDOUT_HOME: home };
  for (const key of ["HOLDOUT_DATA", "HOLDOUT_SITE", "RHC_RPC_FALLBACK", "HARNESS_SEND", "HOLDOUT_MCP_FAULT", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) delete env[key];
  return env;
}
test("A5 built binary uses configured HTTPS defaults, absent values stay null, and malformed values cannot replace it", async t => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-build-defaults-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const original: NodeJS.ProcessEnv = { ...process.env }, empty: NodeJS.ProcessEnv = { ...process.env };
  delete empty.HOLDOUT_DATA_BASE; delete empty.HOLDOUT_SITE_BASE;
  const data = "https://data.release-fixture.example", site = "https://release-fixture.example";
  try {
    await execute(process.execPath, [buildFile], { cwd: root, env: empty });
    const initialized = JSON.parse((await execute(process.execPath, [bin, "init"], { env: environment(join(directory, "unconfigured")) })).stdout);
    assert.equal(initialized.openUrl, null);
    await execute(process.execPath, [buildFile], { cwd: root, env: { ...empty, HOLDOUT_DATA_BASE: data + "/", HOLDOUT_SITE_BASE: site + "/" } });
    const configured = JSON.parse((await execute(process.execPath, [bin, "init"], { env: environment(join(directory, "configured")) })).stdout);
    assert.equal(configured.openUrl, site + "/#open?agent=" + configured.address);
    assert.deepEqual(JSON.parse(await readFile(join(root, "dist/defaults.json"), "utf8")), { data, site });

    const fixture = readFixture(), rpc = await serveFixture(fixture.rpc); t.after(() => rpc.close());
    const callsFile = join(directory, "fetch.jsonl"), preload = join(directory, "fetch.mjs");
    await writeFile(preload, "import {appendFileSync} from 'node:fs';\n" + "globalThis.fetch = async url => { appendFileSync(" + JSON.stringify(callsFile) + ", JSON.stringify(String(url))+'\\n'); return new Response(JSON.stringify({lanes:[]}),{status:200,headers:{'content-type':'application/json'}}); };\n");
    const env = Object.fromEntries(Object.entries(environment(join(directory, "readonly"))).filter((entry): entry is [string,string] => entry[1] !== undefined));
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", pathToFileURL(preload).href, bin, "--lane", FIXTURE.lane, "--rpc", rpc.url], env, stderr: "pipe" });
    const client = new Client({ name: "build-default-client", version: "0.0.0" });
    try { await client.connect(transport); await client.callTool({ name: "holdout_lane", arguments: {} }); }
    finally { await client.close(); }
    const calls = (await readFile(callsFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(calls.includes(data + "/d/lanes.json"));
    assert.ok(!fixture.state.calls.includes("eth_sendRawTransaction"));

    const before = await readFile(bin);
    for (const value of ["", "http://invalid.example", "file:///invalid", "https://name:pass@invalid.example", "https://invalid.example/?query=1", "https://invalid.example/#fragment"]) {
      await assert.rejects(execute(process.execPath, [buildFile], { cwd: root, env: { ...empty, HOLDOUT_DATA_BASE: value } }), error => (error as any).code === 1 && !(error as any).stderr.includes(value || "never-a-value"));
      assert.ok((await readFile(bin)).equals(before));
    }
  } finally { await execute(process.execPath, [buildFile], { cwd: root, env: original }); }
});
