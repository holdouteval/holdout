import dns from "node:dns";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { extractSse, canonicalMetadata, type ModelProvider } from "./sse.js";
import { readProviderKeys, redactValue, registerSecret, safeError, SecretByteRedactor } from "./secrets.js";
import { OFFICIAL_PROVIDER_ENDPOINTS } from "./provider-endpoints.js";

dns.setDefaultResultOrder("ipv4first");
export const MAX_RESPONSE_BYTES = 524_288;
export const MODEL_TIMEOUT_MS = 15 * 60_000;
export const RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 32000] as const;
export interface ModelAttemptRecord {
  text: string; tail: string; bytesRead: number; completed: boolean;
  stop: unknown | null; usage: unknown | null; model: string | null; id: string | null; error: string | null;
}
export interface AttemptOutcome extends ModelAttemptRecord {
  httpStatus: number | null; durationMs: number; sdkText: string; requestSent: boolean; retryable: boolean;
}
export interface AttemptOptions {
  provider: ModelProvider; model: string; system: string; user: string; rawPath: string;
  effort?: "high"; maxOutputTokens?: 64000; apiKey?: string; baseURL?: string;
  fetch?: typeof globalThis.fetch; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal;
  onChunk?: (progress: { bytesRead: number; persistedBytes: number }) => void | Promise<void>;
}
export type AttemptClassification = "success" | "retry" | "model-unavailable" | "refusal" | "fatal";

export function classifyAttempt(attempt: Pick<AttemptOutcome, "completed" | "error" | "httpStatus" | "stop">): AttemptClassification {
  if (attempt.error === "model-unavailable" || attempt.httpStatus === 404) return "model-unavailable";
  if (attempt.error === "refusal") return "refusal";
  if (attempt.httpStatus !== null && attempt.httpStatus >= 400 && attempt.httpStatus < 500 && attempt.httpStatus !== 429) return "fatal";
  if (attempt.error || !attempt.completed) return "retry";
  return "success";
}

/** Incomplete attempts are never promoted to a response during recovery. */
export function recoverAttempt(raw: Uint8Array, provider?: ModelProvider, options: { bytesRead?: number; error?: string } = {}): ModelAttemptRecord {
  const value = extractSse(raw, provider);
  return { text: value.text, tail: value.tail, bytesRead: options.bytesRead ?? raw.byteLength, completed: false,
    stop: null, usage: null, model: null, id: null, error: options.error ?? "interrupted" };
}

export function retryBudget(attempts: Pick<ModelAttemptRecord, "bytesRead">[]): { total: number; withBytes: number; available: boolean; delayMs: number } {
  const total = attempts.length, withBytes = attempts.filter(a => a.bytesRead > 0).length;
  return { total, withBytes, available: total < 6 && withBytes < 3, delayMs: RETRY_DELAYS_MS[Math.min(Math.max(0, total - 1), 4)] };
}

/** Execute exactly one provider request after the caller journals its start. */
export async function runModelAttempt(options: AttemptOptions): Promise<AttemptOutcome> {
  if (options.effort !== undefined && options.effort !== "high" || options.maxOutputTokens !== undefined && options.maxOutputTokens !== 64000) throw new Error("unsupported model parameters");
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES, timeoutMs = options.timeoutMs ?? MODEL_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_RESPONSE_BYTES || !(timeoutMs > 0) || timeoutMs > MODEL_TIMEOUT_MS) throw new Error("invalid model response bounds");
  const started = Date.now();
  let key = options.apiKey;
  if (!key) key = readProviderKeys()[options.provider];
  if (!key) return { text: "", tail: "", bytesRead: 0, completed: false, stop: null, usage: null, model: null, id: null,
    error: "provider-key-missing", httpStatus: null, durationMs: Date.now() - started, sdkText: "", requestSent: false, retryable: false };
  registerSecret(key);
  await mkdir(dirname(options.rawPath), { recursive: true });
  const file = await open(options.rawPath, "ax", 0o600);
  const controller = new AbortController(), redactor = new SecretByteRedactor();
  let timeout = false, limited = false, requestSent = false, bytesRead = 0, persistedBytes = 0, httpStatus: number | null = null;
  let sdkText = "", sdkMessage: any = null, failure: unknown = null, reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let pendingWrite: Promise<void> = Promise.resolve();
  const timer = setTimeout(() => { timeout = true; controller.abort(new Error("model-timeout")); }, timeoutMs);
  timer.unref();
  const persist = (bytes: Uint8Array): Promise<void> => {
    pendingWrite = pendingWrite.then(async () => {
      if (bytes.byteLength) { await file.writeFile(bytes); await file.sync(); persistedBytes += bytes.byteLength; }
      await options.onChunk?.({ bytesRead, persistedBytes });
    });
    return pendingWrite;
  };
  const nativeFetch = options.fetch ?? globalThis.fetch;
  const boundedFetch: typeof globalThis.fetch = async (input, init) => {
    requestSent = true;
    const signals = [controller.signal, init?.signal, options.signal].filter((s): s is AbortSignal => s !== undefined && s !== null);
    const response = await nativeFetch(input, { ...init, signal: AbortSignal.any(signals) });
    httpStatus = response.status;
    if (!response.body) return response;
    reader = response.body.getReader();
    let ended = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(output) {
        try {
          if (ended) return;
          if (limited) { ended = true; output.error(new Error("harness-byte-limit")); return; }
          const result = await reader!.read();
          if (result.done) {
            ended = true; const final = redactor.finish(); await persist(final);
            if (final.byteLength) output.enqueue(final); output.close(); return;
          }
          const accepted = result.value.subarray(0, Math.max(0, maxBytes - bytesRead));
          bytesRead += accepted.byteLength;
          limited = bytesRead >= maxBytes;
          const transformed = redactor.push(accepted, limited); await persist(transformed);
          if (transformed.byteLength) output.enqueue(transformed);
          if (limited) {
            try { await reader!.cancel("harness-byte-limit"); } catch {}
            controller.abort(new Error("harness-byte-limit"));
          }
        } catch (error) {
          ended = true;
          const final = redactor.finish(); await persist(final);
          if (final.byteLength) output.enqueue(final);
          output.error(error);
        }
      },
      async cancel(reason) { ended = true; try { await reader!.cancel(reason); } catch {} },
    });
    const headers = new Headers(response.headers); headers.delete("content-length"); headers.delete("content-encoding");
    return new Response(stream, { status: response.status, statusText: response.statusText, headers });
  };
  try {
    if (options.provider === "anthropic") {
      const client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: timeoutMs, fetch: boundedFetch,
        baseURL: options.baseURL ?? OFFICIAL_PROVIDER_ENDPOINTS.anthropic });
      const stream = client.messages.stream({ model: options.model, max_tokens: 64000, system: options.system,
        messages: [{ role: "user", content: options.user }], output_config: { effort: "high" } });
      for await (const event of stream) if (event.type === "content_block_delta" && event.delta.type === "text_delta") sdkText += event.delta.text;
      sdkMessage = await stream.finalMessage();
    } else if (options.provider === "openai") {
      const client = new OpenAI({ apiKey: key, maxRetries: 0, timeout: timeoutMs, fetch: boundedFetch,
        baseURL: options.baseURL ?? OFFICIAL_PROVIDER_ENDPOINTS.openai });
      const stream = await client.responses.create({ model: options.model, instructions: options.system, input: options.user,
        max_output_tokens: 64000, reasoning: { effort: "high" }, stream: true });
      for await (const event of stream) {
        if (event.type === "response.output_text.delta") sdkText += event.delta;
        if (["response.completed", "response.incomplete", "response.failed"].includes(event.type)) sdkMessage = (event as any).response;
      }
    } else throw new Error("unsupported model provider");
  } catch (error) { failure = error; }
  finally {
    clearTimeout(timer);
    try { await (reader as ReadableStreamDefaultReader<Uint8Array> | null)?.cancel(); } catch {}
    await pendingWrite;
    const final = redactor.finish(); if (final.byteLength) { await file.writeFile(final); await file.sync(); }
    await file.close();
  }
  const raw = await readFile(options.rawPath), extracted = extractSse(raw, options.provider);
  let message = sdkMessage;
  if (!message) {
    if (options.provider === "openai") message = extracted.frames.map((v: any) => v?.response).filter(Boolean).at(-1) ?? null;
    else {
      const start: any = extracted.frames.find((v: any) => v?.type === "message_start"), delta: any = [...extracted.frames].reverse().find((v: any) => v?.type === "message_delta");
      if (start?.message && extracted.completed) message = { ...start.message, ...(delta?.delta ?? {}), usage: { ...start.message.usage, ...(delta?.usage ?? {}) } };
    }
  }
  const terminal = options.provider === "anthropic" ? extracted.completed : extracted.frames.some((v: any) => ["response.completed", "response.incomplete", "response.failed"].includes(v?.type));
  const model = terminal && typeof message?.model === "string" ? message.model : null;
  const id = terminal && typeof message?.id === "string" ? message.id : null;
  const usage = terminal ? canonicalMetadata(message?.usage ?? null) : null;
  const stop = limited ? "harness-byte-limit" : options.provider === "anthropic"
    ? terminal ? { reason: message?.stop_reason ?? null, details: canonicalMetadata(message?.stop_details ?? null) } : null
    : terminal ? { status: message?.status ?? null, incompleteDetails: canonicalMetadata(message?.incomplete_details ?? null) } : null;
  const refusal = message?.stop_reason === "refusal" || message?.output?.some((v: any) => v?.content?.some((part: any) => part?.type === "refusal"));
  let error: string | null = null;
  if (limited) error = "harness-byte-limit";
  else if (timeout) error = "model-timeout";
  else if (httpStatus === 404) error = "model-unavailable";
  else if (refusal) error = "refusal";
  else if (terminal && (!model || !model.startsWith(options.model))) error = "model-mismatch";
  else if (message?.stop_reason === "max_tokens" || message?.status === "incomplete") error = "max_tokens";
  else if (message?.status === "failed") error = "provider-failed";
  else if (failure) error = safeError(failure);
  else if (!terminal) error = "incomplete-response";
  const completed = terminal && !limited && !timeout && (options.provider === "anthropic" || message?.status === "completed");
  const outcome: AttemptOutcome = redactValue({ text: extracted.text, tail: extracted.tail, bytesRead, completed, stop, usage, model, id, error,
    httpStatus, durationMs: Date.now() - started, sdkText, requestSent, retryable: false });
  outcome.retryable = classifyAttempt(outcome) === "retry";
  return outcome;
}
