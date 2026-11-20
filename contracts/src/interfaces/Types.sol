// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

struct ModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}

struct Asset {
    address token;
    address feed;
}

struct Pool {
    address token;
    PoolKey key;
    bytes32 poolId;
}
