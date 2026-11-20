export interface RecordEnvelope extends Record<string, unknown> {
  schema: "holdout.record/1";
  chainId: 4663;
  lane: `0x${string}`;
  kind: "decision";
  time: number;
}

export interface HouseDecision {
  weights: Record<string, string>;
  reason: string;
}

export function validateRecord(value: unknown): RecordEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("bad envelope");
  const r = value as Record<string, unknown>;
  if (r.schema !== "holdout.record/1" || r.chainId !== 4663 || r.kind !== "decision"
      || typeof r.lane !== "string" || !/^0x[0-9a-f]{40}$/.test(r.lane)
      || !Number.isSafeInteger(r.time) || Object.is(r.time, -0)) throw new Error("bad envelope");
  return r as RecordEnvelope;
}

export function inspectHouseRecord(value: unknown): HouseDecision | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const decision = (value as Record<string, unknown>).decision;
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return null;
  const { weights, reason } = decision as Record<string, unknown>;
  if (!weights || typeof weights !== "object" || Array.isArray(weights) || typeof reason !== "string") return null;
  const checked: [string, string][] = [];
  for (const [symbol, amount] of Object.entries(weights)) {
    if (!symbol || typeof amount !== "string" || !/^(?:0(?:\.[0-9]+)?|1(?:\.0+)?)$/.test(amount)) return null;
    checked.push([symbol, amount]);
  }
  return { weights: Object.fromEntries(checked), reason };
}
