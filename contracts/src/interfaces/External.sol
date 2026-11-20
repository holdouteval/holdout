// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {PoolKey, SwapParams, ModifyLiquidityParams} from "./Types.sol";

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function decimals() external view returns (uint8);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IBurnable {
    function burnFrom(address account, uint256 amount) external;
}

interface IStockToken {
    function paused() external view returns (bool);
    function oraclePaused() external view returns (bool);
    function ACCESS_CONTROLLED_REGISTRY() external view returns (address);
}

interface IFeed {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

interface IAccessRegistry {
    function isBlocked(address account) external view returns (bool);
}

interface IIdentityRegistry {
    function register(string calldata uri) external returns (uint256);
    function setAgentURI(uint256 agentId, string calldata uri) external;
    function ownerOf(uint256 agentId) external view returns (address);
    function tokenURI(uint256 agentId) external view returns (string memory);
}

interface IStateView {
    function getSlot0(bytes32 poolId) external view returns (uint160, int24, uint24, uint24);
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey calldata key, SwapParams calldata params, bytes calldata hookData) external returns (int256);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
    function initialize(PoolKey calldata key, uint160 sqrtPriceX96) external returns (int24);
    function modifyLiquidity(PoolKey calldata key, ModifyLiquidityParams calldata params, bytes calldata hookData)
        external returns (int256 callerDelta, int256 feesAccrued);
    function extsload(bytes32 slot) external view returns (bytes32);
}
