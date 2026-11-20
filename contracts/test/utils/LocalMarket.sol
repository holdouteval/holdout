// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IPoolManager, IERC20} from "../../src/interfaces/External.sol";
import {PoolKey, ModifyLiquidityParams} from "../../src/interfaces/Types.sol";

contract LocalStateView {
    IPoolManager public immutable manager;
    constructor(address manager_) { manager = IPoolManager(manager_); }
    function getSlot0(bytes32 poolId) external view returns (uint160 price, int24 tick, uint24 protocol, uint24 fee) {
        uint256 data = uint256(manager.extsload(keccak256(abi.encode(poolId, uint256(6)))));
        price = uint160(data);
        tick = int24(uint24(data >> 160));
        protocol = uint24(data >> 184);
        fee = uint24(data >> 208);
    }
}

contract LocalLiquidity {
    IPoolManager public immutable manager;
    constructor(address manager_) { manager = IPoolManager(manager_); }
    function add(PoolKey memory key, int24 lower, int24 upper, int256 liquidity) external {
        manager.unlock(abi.encode(key, lower, upper, liquidity));
    }
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "manager only");
        (PoolKey memory key, int24 lower, int24 upper, int256 liquidity) =
            abi.decode(data, (PoolKey, int24, int24, int256));
        (int256 delta,) = manager.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, liquidity, 0), "");
        _settle(key.currency0, int128(delta >> 128));
        _settle(key.currency1, int128(delta));
        return "";
    }
    function _settle(address currency, int128 delta) internal {
        if (delta < 0) {
            manager.sync(currency);
            IERC20(currency).transfer(address(manager), uint256(uint128(-delta)));
            manager.settle();
        } else if (delta > 0) {
            manager.take(currency, address(this), uint256(uint128(delta)));
        }
    }
}
