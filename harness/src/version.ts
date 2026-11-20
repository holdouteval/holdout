import { readFileSync } from "node:fs";
export function harnessIdentity(): { version: string; commit: string | null } {
  const value = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  return { version: String(value.version), commit: process.env.HARNESS_COMMIT ?? null };
}
