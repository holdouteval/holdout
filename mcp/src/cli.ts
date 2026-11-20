import { safeError } from "@holdout/core";
import { initializeAgent } from "./keys.js";
import { HELP, parseCommand } from "./options.js";
import { startStdio } from "./server.js";

async function main(): Promise<void> {
  const command = parseCommand(process.argv.slice(2));
  if (command.kind === "help") { process.stdout.write(HELP); return; }
  if (command.kind === "init") {
    process.stdout.write(JSON.stringify(await initializeAgent(command.home, command.name, command.site)) + "\n"); return;
  }
  const server = await startStdio(command.config);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { server.close().finally(() => process.exit(0)); });
}
main().catch(error => { process.stderr.write(JSON.stringify({ error: safeError(error) }) + "\n"); process.exitCode = 1; });
