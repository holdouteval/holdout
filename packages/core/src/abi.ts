import { readFileSync } from "node:fs";
import { parseAbi, type Abi } from "viem";

function generated(name: string): Abi {
  try { return JSON.parse(readFileSync(new URL("./abi/" + name + ".json", import.meta.url), "utf8")) as Abi; }
  catch { throw new Error("generated ABI unavailable"); }
}

export const FACTORY_ABI = generated("LaneFactory");
export const LANE_ABI = generated("Lane");
export const PROXY_ABI = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function aggregator() view returns (address)",
  "function phaseId() view returns (uint16)",
  "function phaseAggregators(uint16) view returns (address)",
  "function decimals() view returns (uint8)",
]);
export const AGGREGATOR_ABI = parseAbi([
  "event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function getRoundData(uint80) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);
export const MULTICALL_ABI = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);
export const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
]);
export const STOCK_ABI = parseAbi([
  "function paused() view returns (bool)", "function oraclePaused() view returns (bool)",
]);
export const ACCESS_ABI = parseAbi(["function isBlocked(address) view returns (bool)"]);
