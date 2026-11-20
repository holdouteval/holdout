import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_DATA, DEFAULT_SITE } from "./defaults.js";
import type { ServerConfig } from "./types.js";

export type Command = { kind: "help" } | { kind: "init"; home: string; name: string; site: string | null } | { kind: "serve"; config: ServerConfig };
function baseUrl(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("invalid-url"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("invalid-url");
  return value.replace(/\/+$/, "");
}
export function parseCommand(argv: string[], env: NodeJS.ProcessEnv = process.env, defaultHome = homedir()): Command {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return { kind: "help" };
  const init = argv[0] === "init", args = init ? argv.slice(1) : argv;
  const allowed = new Set(init ? ["--name", "--site"] : ["--lane", "--data", "--site", "--rpc", "--key"]);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i], value = args[i + 1];
    if (!allowed.has(name) || values.has(name) || value === undefined || value.startsWith("--")) throw new Error("invalid-options");
    values.set(name, value);
  }
  const home = resolve(env.HOLDOUT_HOME ?? join(defaultHome, ".holdout"));
  const site = baseUrl(values.get("--site") ?? env.HOLDOUT_SITE ?? DEFAULT_SITE);
  if (init) {
    const name = values.get("--name") ?? "agent";
    if (!/^[a-z0-9-]{1,32}$/.test(name)) throw new Error("invalid-agent-name");
    return { kind: "init", home, name, site };
  }
  const lane = values.get("--lane");
  if (!lane || !/^0x[0-9a-f]{40}$/i.test(lane)) throw new Error("invalid-lane");
  const rpc = baseUrl(values.get("--rpc"));
  if (rpc !== null && new URL(rpc).hostname !== "127.0.0.1") throw new Error("rpc-override-must-use-ipv4-loopback");
  return { kind: "serve", config: { lane: lane.toLowerCase(), home, dataBase: baseUrl(values.get("--data") ?? env.HOLDOUT_DATA ?? DEFAULT_DATA),
    siteBase: site, ...(rpc !== null ? { rpc } : {}), ...(values.has("--key") ? { keyFile: resolve(values.get("--key")!) } : {}) } };
}

export const HELP = `holdout-mcp init [--name <name>] [--site <url>]
holdout-mcp --lane <lane> [--data <url>] [--site <url>] [--rpc <loopback-url>] [--key <path>]

Environment: HOLDOUT_HOME, HOLDOUT_DATA, HOLDOUT_SITE, RHC_RPC_FALLBACK
The server uses stdio. The agent key signs lane decisions; the owner closes through the site.
`;
