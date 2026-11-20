// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {PoolKey, ModifyLiquidityParams} from "../../src/interfaces/Types.sol";
import {IPoolManager, IERC20} from "../../src/interfaces/External.sol";

contract ForkLiquidity {
    IPoolManager public immutable manager;

    constructor(address manager_) {
        manager = IPoolManager(manager_);
    }

    function add(PoolKey memory key, int24 lower, int24 upper, int256 liquidity) external {
        manager.unlock(abi.encode(key, lower, upper, liquidity));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "manager");
        (PoolKey memory key, int24 lower, int24 upper, int256 liquidity) =
            abi.decode(data, (PoolKey, int24, int24, int256));
        (int256 delta,) = manager.modifyLiquidity(
            key, ModifyLiquidityParams(lower, upper, liquidity, bytes32(0)), ""
        );
        _settle(key.currency0, int128(delta >> 128));
        _settle(key.currency1, int128(delta));
        return "";
    }

    function _settle(address currency, int128 delta) private {
        if (delta < 0) {
            uint256 amount = uint256(-int256(delta));
            manager.sync(currency);
            require(IERC20(currency).transfer(address(manager), amount), "transfer");
            manager.settle();
        } else if (delta > 0) {
            manager.take(currency, address(this), uint256(uint128(delta)));
        }
    }
}
