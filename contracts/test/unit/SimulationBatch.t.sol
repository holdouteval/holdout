// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test, Vm} from "forge-std/Test.sol";
import {SimulationBatch} from "../utils/SimulationBatch.sol";

contract SimulationTarget {
    address public lastCaller;
    uint256 public total;
    uint256 public received;

    error TargetFailure(uint256 delta);
    event Observed(uint256 delta, uint256 value);

    function change(uint256 delta) external payable returns (uint256) {
        lastCaller = msg.sender;
        total += delta;
        received += msg.value;
        emit Observed(delta, msg.value);
        return total;
    }

    function fail(uint256 delta) external payable {
        lastCaller = msg.sender;
        total += delta;
        received += msg.value;
        revert TargetFailure(delta);
    }
}

contract SimulationBatchTest is Test {
    address payable private constant ACTOR = payable(address(0xA6702));
    bytes32 private constant RESULT = keccak256("CallResult(uint256,bool,uint256,bytes)");
    bytes32 private constant OBSERVED = keccak256("Observed(uint256,uint256)");
    SimulationTarget private target;

    function setUp() public {
        vm.etch(ACTOR, type(SimulationBatch).runtimeCode);
        target = new SimulationTarget();
    }

    function test_OnlyTheAccountCanRunItsBatch() public {
        SimulationBatch.Call[] memory calls = new SimulationBatch.Call[](1);
        calls[0] = SimulationBatch.Call(address(target), 0, abi.encodeCall(target.change, (7)));
        vm.expectRevert(SimulationBatch.SelfOnly.selector);
        SimulationBatch(ACTOR).run(calls);
        assertEq(target.total(), 0);
        assertEq(target.lastCaller(), address(0));
    }

    function test_CallerRollbackResultsAndEventBoundaries() public {
        SimulationBatch.Call[] memory calls = _calls(0, 0, 0);
        vm.recordLogs();
        vm.prank(ACTOR);
        SimulationBatch(ACTOR).run(calls);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(target.lastCaller(), ACTOR);
        assertEq(target.total(), 10);
        assertEq(logs.length, 5);
        _observed(logs[0], 7, 0);
        _result(logs[1], 0, true, abi.encode(uint256(7)));
        _result(logs[2], 1, false, abi.encodeWithSelector(SimulationTarget.TargetFailure.selector, 99));
        _observed(logs[3], 3, 0);
        _result(logs[4], 2, true, abi.encode(uint256(10)));
    }

    function test_ValueForwardingAndFailedValueRollback() public {
        vm.deal(ACTOR, 1_000);
        SimulationBatch.Call[] memory calls = _calls(30, 40, 20);
        vm.recordLogs();
        vm.prank(ACTOR);
        SimulationBatch(ACTOR).run(calls);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(ACTOR.balance, 950);
        assertEq(address(target).balance, 50);
        assertEq(target.received(), 50);
        assertEq(target.lastCaller(), ACTOR);
        assertEq(target.total(), 10);
        assertEq(logs.length, 5);
        _observed(logs[0], 7, 30);
        _result(logs[1], 0, true, abi.encode(uint256(7)));
        _result(logs[2], 1, false, abi.encodeWithSelector(SimulationTarget.TargetFailure.selector, 99));
        _observed(logs[3], 3, 20);
        _result(logs[4], 2, true, abi.encode(uint256(10)));

        vm.deal(address(this), 200);
        (bool accepted,) = ACTOR.call{value: 200}("");
        assertTrue(accepted);
        assertEq(ACTOR.balance, 1_150);
    }

    function _calls(uint256 first, uint256 failed, uint256 last)
        private view returns (SimulationBatch.Call[] memory calls)
    {
        calls = new SimulationBatch.Call[](3);
        calls[0] = SimulationBatch.Call(address(target), first, abi.encodeCall(target.change, (7)));
        calls[1] = SimulationBatch.Call(address(target), failed, abi.encodeCall(target.fail, (99)));
        calls[2] = SimulationBatch.Call(address(target), last, abi.encodeCall(target.change, (3)));
    }

    function _observed(Vm.Log memory entry, uint256 delta, uint256 value) private view {
        assertEq(entry.emitter, address(target));
        assertEq(entry.topics.length, 1);
        assertEq(entry.topics[0], OBSERVED);
        assertEq(entry.data, abi.encode(delta, value));
    }

    function _result(Vm.Log memory entry, uint256 index, bool success, bytes memory returnData) private pure {
        assertEq(entry.emitter, ACTOR);
        assertEq(entry.topics.length, 2);
        assertEq(entry.topics[0], RESULT);
        assertEq(uint256(entry.topics[1]), index);
        (bool actualSuccess, uint256 gasUsed, bytes memory actualReturn) =
            abi.decode(entry.data, (bool, uint256, bytes));
        assertEq(actualSuccess, success);
        assertGt(gasUsed, 0);
        assertEq(actualReturn, returnData);
    }
}
