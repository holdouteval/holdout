import { encodeFunctionData, decodeFunctionResult } from "viem";
import { ADDRESSES } from "./chain.js";
import { QUOTER_ABI } from "./abi.js";
import { blockTag, type PoolKey, type ReadBlock, type ReadRpc } from "./lane.js";

export function normalizePoolKey(key: PoolKey): PoolKey {
  const [currency0, currency1] = [key.currency0.toLowerCase(), key.currency1.toLowerCase()].sort();
  if (!/^0x[0-9a-f]{40}$/.test(currency0) || !/^0x[0-9a-f]{40}$/.test(currency1) || currency0 === currency1) throw new Error("invalid pool currencies");
  return { ...key, currency0, currency1, hooks: key.hooks.toLowerCase() };
}
export async function quoteExactInput(rpc: ReadRpc, poolKey: PoolKey, zeroForOne: boolean, amount: bigint, block: ReadBlock): Promise<bigint> {
  if (amount <= 0n || amount >= 1n << 128n) throw new Error("quote amount out of range");
  const key = normalizePoolKey(poolKey);
  const data = encodeFunctionData({ abi: QUOTER_ABI, functionName: "quoteExactInputSingle", args: [{ poolKey: key as any, zeroForOne, exactAmount: amount, hookData: "0x" }] });
  const response = await rpc.request<`0x${string}`>("eth_call", [{ to: ADDRESSES.quoter, data }, blockTag(block)]);
  const result = decodeFunctionResult({ abi: QUOTER_ABI, functionName: "quoteExactInputSingle", data: response });
  return BigInt(result[0]);
}
