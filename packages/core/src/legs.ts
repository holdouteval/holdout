import { encodeAbiParameters, keccak256 } from "viem";

export interface Leg {
  pool: bigint | number | string;
  buy: boolean;
  amountIn: bigint | number | string;
  minOut: bigint | number | string;
}

function uint(value: bigint | number | string): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("unsafe integer");
  if (typeof value === "string" && !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("invalid unsigned amount");
  const n = BigInt(value);
  if (n < 0n || n >= 1n << 256n) throw new Error("uint256 out of range");
  return n;
}

export function legsHash(legs: readonly Leg[]): `0x${string}` {
  const encoded = encodeAbiParameters([{
    type: "tuple[]", components: [
      { name: "pool", type: "uint256" }, { name: "buy", type: "bool" },
      { name: "amountIn", type: "uint256" }, { name: "minOut", type: "uint256" },
    ],
  }], [legs.map((leg) => {
    if (typeof leg.buy !== "boolean") throw new Error("invalid side");
    return { pool: uint(leg.pool), buy: leg.buy, amountIn: uint(leg.amountIn), minOut: uint(leg.minOut) };
  })]);
  return keccak256(encoded);
}
