import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

export async function temporary(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "model-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export interface ReceivedRequest { path: string; body: Record<string, any>; headers: IncomingMessage["headers"] }
export async function fakeProvider(t: TestContext, handler: (response: ServerResponse, request: ReceivedRequest) => void | Promise<void>): Promise<{ baseURL: string; requests: ReceivedRequest[] }> {
  const requests: ReceivedRequest[] = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const entry = { path: request.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString()), headers: request.headers };
    requests.push(entry);
    try { await handler(response, entry); } catch { response.destroy(); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("local server address missing");
  return { baseURL: `http://127.0.0.1:${address.port}`, requests };
}

export function frame(event: Record<string, unknown>): string { return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`; }
export function anthropicFrames(texts: string[], options: { model?: string; reason?: string; details?: unknown } = {}): string[] {
  return [
    frame({ type: "message_start", message: { id: "message-test", type: "message", role: "assistant", model: options.model ?? "claude-fable-5-2", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } }),
    frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    ...texts.map(text => frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })),
    frame({ type: "content_block_stop", index: 0 }),
    frame({ type: "message_delta", delta: { stop_reason: options.reason ?? "end_turn", stop_sequence: null, stop_details: options.details ?? null }, usage: { output_tokens: 29 } }),
    frame({ type: "message_stop" }),
  ];
}
export function openaiFrames(texts: string[], options: { model?: string; status?: string; refusal?: boolean; usage?: unknown } = {}): string[] {
  const response = { id: "response-test", object: "response", created_at: 1, status: options.status ?? "completed", model: options.model ?? "gpt-6.1-sol-2026-11-01",
    incomplete_details: options.status === "incomplete" ? { reason: "max_output_tokens" } : null,
    usage: options.usage ?? { input_tokens: 12, output_tokens: 29, total_tokens: 41, output_tokens_details: { reasoning_tokens: 17 } },
    output: options.refusal ? [{ type: "message", content: [{ type: "refusal", refusal: "refused" }] }] : [],
  };
  return [...texts.map((delta, index) => frame({ type: "response.output_text.delta", item_id: "item-test", output_index: 0, content_index: 0, sequence_number: index, delta })),
    frame({ type: response.status === "completed" ? "response.completed" : "response.incomplete", sequence_number: texts.length, response })];
}

export function stream(response: ServerResponse, chunks: string[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) response.write(chunk);
  response.end();
}
