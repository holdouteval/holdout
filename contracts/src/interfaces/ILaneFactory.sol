// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Asset, Pool} from "./Types.sol";

interface ILaneFactory {
    function assetOf(address token) external view returns (uint256);
    function assetCount() external view returns (uint256);
    function assetAt(uint256 index) external view returns (Asset memory);
    function poolCount() external view returns (uint256);
    function poolAt(uint256 index) external view returns (Pool memory);
}
