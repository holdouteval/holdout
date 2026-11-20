import type { Provider } from "./types.js";

export const OFFICIAL_PROVIDER_ENDPOINTS: Readonly<Record<Provider, string>> = Object.freeze({
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
});
export interface ProviderEndpointOptions {
  mode: "paper" | "send"; local: boolean; env?: NodeJS.ProcessEnv; warn?: (message: string) => void;
}
function localEndpoint(value: string): string {
  const match = /^http:\/\/127\.0\.0\.1:(\d+)(?:\/[^?#]*)?$/.exec(value);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("provider base URL must use IPv4 loopback HTTP with an explicit port"); }
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535 || url.protocol !== "http:" || url.hostname !== "127.0.0.1"
    || url.username || url.password || url.search || url.hash) throw new Error("provider base URL must use IPv4 loopback HTTP with an explicit port");
  return value.replace(/\/$/, "");
}

/** Endpoint overrides are restricted to an already authenticated local sender. */
export function providerEndpoints(options: ProviderEndpointOptions): Record<Provider, string> {
  const env = options.env ?? process.env;
  const overrides = { anthropic: env.ANTHROPIC_BASE_URL, openai: env.OPENAI_BASE_URL };
  if (options.mode !== "send" || !options.local) {
    if (Object.values(overrides).some(value => value !== undefined)) options.warn?.("provider base URL settings ignored outside guarded local send mode");
    return { ...OFFICIAL_PROVIDER_ENDPOINTS };
  }
  return {
    anthropic: overrides.anthropic === undefined ? OFFICIAL_PROVIDER_ENDPOINTS.anthropic : localEndpoint(overrides.anthropic),
    openai: overrides.openai === undefined ? OFFICIAL_PROVIDER_ENDPOINTS.openai : localEndpoint(overrides.openai),
  };
}
