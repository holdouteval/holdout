import { readFile } from "node:fs/promises";
import { RpcClient, SendClient, registerSecret } from "@holdout/core";
import { DecisionEngine } from "../src/engine.js";
import { readJournal, recordPath, withAgentLock, AgentBusy } from "../src/journal.js";
import type { DecisionEngineOptions } from "../src/types.js";

async function main() {
  const value = JSON.parse(process.argv[2]) as Omit<DecisionEngineOptions, "rpc" | "sender"> & { action: string; request: any };
  if (value.action === "lock" || value.action === "lock-once") {
    try { await withAgentLock(value.config.home, value.identity.agent, async () => {
      console.log(JSON.stringify({ acquired: true }));
      if (value.action === "lock") await new Promise<void>(() => { setInterval(() => {}, 1000); });
    }); } catch (error) { if (error instanceof AgentBusy) console.log(JSON.stringify({ state: "busy" })); else throw error; }
    return;
  }
  if (value.key) { const secret = (await readFile(value.key.path, "utf8")).trim(); registerSecret(secret); registerSecret(secret.replace(/^0x/, "")); }
  const rpc = new RpcClient({ override: value.config.rpc, envFile: false, stateIntervalMs: 0, executionIntervalMs: 0, attempts: 1, sleep: async () => {} });
  const sender = new SendClient({ override: value.config.rpc, envFile: false, stateIntervalMs: 0, executionIntervalMs: 0 });
  const fetcher: typeof fetch = async (url, options) => {
    if (options?.method === "POST") return new Response("{}", { status: 201 });
    const h = String(url).split("/").at(-1)!.replace(".json", "");
    return new Response(await readFile(recordPath(value.config.home, value.config.lane, h)));
  };
  const engine = new DecisionEngine({ ...value, rpc, sender, fetch: fetcher });
  try {
    if (value.action === "decide") console.log(JSON.stringify(await engine.decide(value.request)));
    else {
      await engine.start();
      const start = Date.now();
      for (;;) {
        const journal = await readJournal(value.config.home, value.config.lane);
        if (journal.entries.every(entry => ["not-sent", "failed", "verified"].includes(entry.stage))) {
          console.log(JSON.stringify({ stages: journal.entries.map(entry => entry.stage) })); break;
        }
        if (Date.now() - start > 12000) throw new Error("recovery timeout");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  } finally { engine.stop(); }
}
main().catch(() => { console.error("child-failed"); process.exitCode = 1; });
