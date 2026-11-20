#!/usr/bin/env node
import dns from "node:dns";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "./config.js";
import { HarnessEngine, HarnessStop } from "./engine.js";
import { daemon } from "./daemon.js";
import { writePublicConfig } from "./public-config.js";
import { harnessIdentity } from "./version.js";
import { safeLog, safeError } from "./secrets.js";

dns.setDefaultResultOrder("ipv4first");
function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name); if (index < 0) return;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`missing option ${name}`);
  return args[index + 1];
}
async function main(): Promise<void> {
  const args = process.argv.slice(2), values = new Set(["--config", "--budget", "--session", "--at", "--lane", "--out"]);
  const positional = args.filter((value, index) => !value.startsWith("--") && !values.has(args[index - 1]));
  const command = positional[0], config = loadConfig(option(args, "--config") ?? "harness/config/mainnet.example.json");
  if (command === "public-config") {
    const output = option(args, "--out"); if (!output) throw new Error("output path required");
    writePublicConfig(config, output, harnessIdentity()); return;
  }
  if (args.includes("--paper") && config.mode !== "paper") throw new Error("paper flag requires paper mode");
  if (option(args, "--at") !== undefined && (command !== "run" || option(args, "--at") !== "latest" || config.mode !== "paper")) throw new Error("latest is available only for paper runs");
  const engine = new HarnessEngine(config, { budgetPath: option(args, "--budget") });
  const stop = new AbortController();
  const shutdown = () => stop.abort(); process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
  try {
    await engine.initialize();
    if (command === "run") await engine.run({ session: option(args, "--session"), latest: option(args, "--at") === "latest", lane: option(args, "--lane") });
    else if (command === "resume") await engine.resume();
    else if (command === "daemon") await daemon(engine, { signal: stop.signal });
    else if (command === "review") {
      const action = positional[1];
      if (!action) console.log(safeLog(await engine.reviews()));
      else {
        const h = positional[2]; if (!["send", "skip"].includes(action) || !/^0x[0-9a-f]{64}$/.test(h ?? "")) throw new Error("review requires send or skip and a record hash");
        if (action === "send" && !args.includes("--yes")) {
          console.log(safeLog(await engine.reviews()));
          const input = createInterface({ input: process.stdin, output: process.stderr });
          try { if ((await input.question("Send the sealed orders? [y/N] ")).trim().toLowerCase() !== "y") return; } finally { input.close(); }
        }
        await engine.review(h, action as "send" | "skip");
      }
    } else throw new Error("command must be run, daemon, resume, review, or public-config");
  } finally { process.off("SIGTERM", shutdown); process.off("SIGINT", shutdown); engine.close(); }
}
main().catch(error => {
  console.error(safeLog(error instanceof HarnessStop ? { error: error.message, condition: error.condition, evidence: error.evidence } : { error: safeError(error) }));
  process.exitCode = error instanceof HarnessStop ? 2 : 1;
});
