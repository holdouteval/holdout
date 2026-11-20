import { chmod, mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { registerSecret } from "@holdout/core";
import { siteLink } from "./links.js";
import type { AgentKey } from "./types.js";

async function syncDirectory(path: string): Promise<void> { const file = await open(path, "r"); try { await file.sync(); } finally { await file.close(); } }
function registeredKey(value: string): `0x${string}` | null {
  registerSecret(value); const trimmed = value.trim(); registerSecret(trimmed);
  if (!/^(?:0x)?[0-9a-f]{64}$/i.test(trimmed)) return null;
  const key = ("0x" + trimmed.replace(/^0x/i, "")).toLowerCase() as `0x${string}`;
  registerSecret(key); registerSecret(key.slice(2)); return key;
}
export async function initializeAgent(home: string, name: string, site: string | null): Promise<{ address: string; keyFile: string; openUrl: string | null; note?: string }> {
  if (!/^[a-z0-9-]{1,32}$/.test(name)) throw new Error("invalid-agent-name");
  await mkdir(home, { recursive: true, mode: 0o700 }); await chmod(home, 0o700);
  const directory = join(home, "agents"); await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const keyFile = join(directory, name + ".key"), key = generatePrivateKey(); registeredKey(key);
  let file;
  try { file = await open(keyFile, "wx", 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("agent-key-exists"); throw error; }
  try { await file.chmod(0o600); await file.writeFile(key + "\n", "utf8"); await file.sync(); } finally { await file.close(); }
  await syncDirectory(directory); await syncDirectory(home);
  const address = privateKeyToAccount(key).address.toLowerCase(), openUrl = siteLink(site, "open", address);
  return { address, keyFile, openUrl, ...(openUrl === null ? { note: "No site address is configured. Supply --site to create an opening link." } : {}) };
}
export async function findAgentKey(home: string, agent: string, explicit?: string, logger: (message: string) => void = () => {}): Promise<AgentKey | null> {
  let paths: string[];
  if (explicit) paths = [explicit];
  else {
    try { paths = (await readdir(join(home, "agents"))).filter(name => name.endsWith(".key")).sort().map(name => join(home, "agents", name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  for (const path of paths) {
    let file;
    try { file = await open(path, "r"); }
    catch { logger("agent key ignored: file is unavailable"); continue; }
    try {
      const info = await file.stat();
      if (!info.isFile() || (info.mode & 0o7777) !== 0o600) { logger("agent key ignored: mode 600 is required"); continue; }
      const key = registeredKey(await file.readFile("utf8"));
      if (!key) { logger("agent key ignored: invalid key file"); continue; }
      let address: string;
      try { address = privateKeyToAccount(key).address.toLowerCase(); }
      catch { logger("agent key ignored: invalid key file"); continue; }
      if (explicit || address === agent.toLowerCase()) return { path, address };
    } finally { await file.close(); }
  }
  return null;
}
