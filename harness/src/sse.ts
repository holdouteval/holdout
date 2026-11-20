export type ModelProvider = "anthropic" | "openai";
export interface ExtractedSse { text: string; tail: string; frames: unknown[]; completed: boolean }

/** Parse only frames terminated by an empty line, retaining the untouched suffix. */
export function extractSse(bytes: Uint8Array, provider?: ModelProvider): ExtractedSse {
  const source = Buffer.from(bytes), frames: unknown[] = [];
  let start = 0, at = 0, text = "", completed = false;
  while (at < source.length) {
    let ending = 0;
    if (source[at] === 10 || source[at] === 13) {
      const first = source[at] === 13 && source[at + 1] === 10 ? 2 : 1;
      const next = at + first;
      if (source[next] === 10 || source[next] === 13) ending = first + (source[next] === 13 && source[next + 1] === 10 ? 2 : 1);
    }
    if (!ending) { at++; continue; }
    const raw = source.subarray(start, at).toString("utf8");
    const data = raw.split(/\r\n|\r|\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (data && data !== "[DONE]") {
      try {
        const event = JSON.parse(data); frames.push(event);
        if ((!provider || provider === "anthropic") && event.type === "content_block_delta" && event.delta?.type === "text_delta" && typeof event.delta.text === "string") text += event.delta.text;
        if ((!provider || provider === "openai") && event.type === "response.output_text.delta" && typeof event.delta === "string") text += event.delta;
        if ((!provider || provider === "anthropic") && event.type === "message_stop" || (!provider || provider === "openai") && event.type === "response.completed") completed = true;
      } catch { /* An invalid complete frame cannot contribute text or completion. */ }
    }
    at += ending; start = at;
  }
  return { text, tail: source.subarray(start).toString("base64"), frames, completed };
}

export const recoverAttempt = extractSse;

/** Convert provider metadata into values accepted by canonical JSON. */
export function canonicalMetadata(value: unknown): any {
  if (value === undefined || value === null) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isSafeInteger(value) && !Object.is(value, -0) ? value : String(value);
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(canonicalMetadata);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, canonicalMetadata(item)]));
  return String(value);
}
