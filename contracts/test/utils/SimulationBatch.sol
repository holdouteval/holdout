// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @notice Stateless account code for collecting individual simulation call results.
contract SimulationBatch {
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    error SelfOnly();

    event CallResult(uint256 indexed index, bool success, uint256 gasUsed, bytes returnData);

    receive() external payable {}

    /// @dev Install as account code and invoke from that same account during simulation.
    function run(Call[] calldata calls) external {
        if (msg.sender != address(this)) revert SelfOnly();
        for (uint256 i; i < calls.length; ++i) {
            Call calldata item = calls[i];
            uint256 beforeGas = gasleft();
            (bool success, bytes memory result) = item.target.call{value: item.value}(item.data);
            uint256 used = beforeGas - gasleft();
            emit CallResult(i, success, used, result);
        }
    }
}
