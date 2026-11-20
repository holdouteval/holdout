import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerSecret, redactSecrets, safeError, secretValues, sanitize } from "@holdout/core";

export interface ProviderKeys { anthropic?: string; openai?: string }
export interface ProviderKeyOptions { envFile?: string; env?: NodeJS.ProcessEnv }

export function readProviderKeys(options: ProviderKeyOptions = {}): ProviderKeys {
  const env = options.env ?? process.env;
  const file = options.envFile ?? resolve(fileURLToPath(new URL("../../../", import.meta.url)), ".env");
  const values: Record<string, string | undefined> = {
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: env.OPENAI_API_KEY,
  };
  if (!values.ANTHROPIC_API_KEY || !values.OPENAI_API_KEY) {
    let contents = "";
    try { contents = readFileSync(file, "utf8"); } catch {}
    for (const line of contents.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?(ANTHROPIC_API_KEY|OPENAI_API_KEY)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match || values[match[1]]) continue;
      const quoted = match[2];
      values[match[1]] = ((quoted.startsWith('"') || quoted.startsWith("'")) && quoted.at(-1) === quoted[0]
        ? quoted.slice(1, -1) : quoted.split(/\s+#/)[0].trim()) || undefined;
    }
  }
  for (const value of Object.values(values)) if (value) registerSecret(value);
  return { anthropic: values.ANTHROPIC_API_KEY, openai: values.OPENAI_API_KEY };
}

/** Preserve JSON structure while removing every registered exact secret value. */
export function redactValue<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map(redactValue) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactSecrets(key), redactValue(item)])) as T;
  return value;
}

export function safeLog(value: unknown): string {
  return sanitize(redactSecrets(value)).replace(/[\r\n]+/g, " ");
}

export { registerSecret, redactSecrets, safeError, secretValues };

/** Delays a possible secret prefix until its match can be decided across chunks. */
export class SecretByteRedactor {
  private pending = Buffer.alloc(0);
  private readonly secrets: Buffer[];
  constructor(values: readonly string[] = secretValues()) {
    this.secrets = [...new Set(values.filter(Boolean))].sort((a, b) => b.length - a.length).map(value => Buffer.from(value));
  }
  push(chunk: Uint8Array, final = false): Uint8Array {
    const bytes = Buffer.concat([this.pending, chunk]);
    const output: Buffer[] = [];
    let at = 0, literal = 0;
    while (at < bytes.length) {
      const remaining = bytes.subarray(at);
      const candidates = this.secrets.filter(secret => secret[0] === bytes[at]);
      const matched = candidates.find(secret => remaining.length >= secret.length && remaining.subarray(0, secret.length).equals(secret));
      if (matched) {
        if (literal < at) output.push(bytes.subarray(literal, at));
        output.push(Buffer.from("[secret]")); at += matched.length; literal = at; continue;
      }
      if (!final && candidates.some(secret => remaining.length < secret.length && secret.subarray(0, remaining.length).equals(remaining))) break;
      at++;
    }
    if (literal < at) output.push(bytes.subarray(literal, at));
    this.pending = bytes.subarray(at);
    return Buffer.concat(output);
  }
  finish(): Uint8Array { return this.push(new Uint8Array(), true); }
}
