// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {LibString} from "solady/utils/LibString.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Lane} from "../../src/Lane.sol";
import {LaneFactory} from "../../src/LaneFactory.sol";
import {PoolKey, Pool} from "../../src/interfaces/Types.sol";
import {IPoolManager} from "../../src/interfaces/External.sol";
import {LocalToken, LocalStock, LocalFeed, LocalIdentityRegistry, LocalAccessRegistry} from "./LocalMocks.sol";
import {LocalStateView, LocalLiquidity} from "./LocalMarket.sol";

abstract contract LocalSetup is Test {
    uint256 internal constant PRINCIPAL = 1_000_000_000;
    uint256 internal constant BURN = 100_000e18;
    uint256 internal constant MAX = type(uint256).max;
    address internal constant OWNER = address(0xA11CE);
    address internal constant AGENT = address(0xA6E17);
    address internal constant STRANGER = address(0xBAD);
    LocalToken internal cash;
    LocalToken internal project;
    LocalStock internal stock;
    LocalFeed internal feed;
    LocalAccessRegistry internal registry;
    LocalIdentityRegistry internal identity;
    IPoolManager internal manager;
    LocalStateView internal stateView;
    LocalLiquidity internal liquidity;
    LaneFactory internal factory;
    Lane internal lane;
    PoolKey internal key;
    uint256 internal nonce;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        registry = new LocalAccessRegistry();
        cash = new LocalToken(6);
        project = new LocalToken(18);
        stock = new LocalStock(address(registry));
        feed = new LocalFeed(50e8, block.timestamp);
        identity = new LocalIdentityRegistry();
        bytes memory creation = abi.encodePacked(vm.getCode("PoolManager.fixture.sol:PoolManager"), abi.encode(address(this)));
        address deployed;
        assembly ("memory-safe") { deployed := create(0, add(creation, 32), mload(creation)) }
        require(deployed != address(0), "manager deployment failed");
        manager = IPoolManager(deployed);
        stateView = new LocalStateView(deployed);
        liquidity = new LocalLiquidity(deployed);
        factory = _newFactory();
        _configure(factory);
        factory.listAsset(address(stock), address(feed));
        key = _key(address(stock), 500, 10);
        _market(key, 90, 1e24, -887270, 887270);
        factory.listPool(address(stock), key);
        lane = _open(factory, OWNER, AGENT);
    }

    function _newFactory() internal returns (LaneFactory) {
        return new LaneFactory(address(cash), address(manager), address(stateView), address(registry), address(identity), 90_000, 1_800, address(this));
    }
    function _configure(LaneFactory target) internal {
        target.setToken(address(project));
        target.setBurnAmount(BURN);
        target.setIdentityBase("https://example.invalid/a/");
    }
    function _open(LaneFactory target, address owner, address agent) internal returns (Lane result) {
        return _open(target, owner, agent, PRINCIPAL);
    }
    function _open(LaneFactory target, address owner, address agent, uint256 amount) internal returns (Lane result) {
        cash.mint(owner, amount);
        project.mint(owner, BURN);
        vm.startPrank(owner);
        cash.approve(address(target), MAX);
        project.approve(address(target), MAX);
        result = Lane(target.openLane(agent, "local", amount));
        vm.stopPrank();
    }
    function _key(address token, uint24 fee, int24 spacing) internal view returns (PoolKey memory result) {
        (address a, address b) = address(cash) < token ? (address(cash), token) : (token, address(cash));
        result = PoolKey(a, b, fee, spacing, address(0));
    }
    function _price(PoolKey memory pool, uint256 price) internal view returns (uint160) {
        uint256 ratio = pool.currency0 == address(cash) ? (uint256(1e12) << 192) / price : (price << 192) / 1e12;
        return uint160(FixedPointMathLib.sqrt(ratio));
    }
    function _market(PoolKey memory pool, uint256 price, int256 size, int24 lower, int24 upper) internal {
        manager.initialize(pool, _price(pool, price));
        LocalToken(pool.currency0).mint(address(liquidity), 1e40);
        LocalToken(pool.currency1).mint(address(liquidity), 1e40);
        liquidity.add(pool, lower, upper, size);
    }
    function _legs(uint256 pool, bool buy, uint256 amount, uint256 minOut) internal pure returns (Lane.Leg[] memory legs) {
        legs = new Lane.Leg[](1);
        legs[0] = Lane.Leg(pool, buy, amount, minOut);
    }
    function _exits(uint256 pool, uint256 amount, uint256 minOut) internal pure returns (Lane.Exit[] memory exits) {
        exits = new Lane.Exit[](1);
        exits[0] = Lane.Exit(pool, amount, minOut);
    }
    function _hash() internal returns (bytes32) { return keccak256(abi.encode(++nonce)); }
    function _trade(Lane target, uint256 pool, bool buy, uint256 amount) internal {
        vm.prank(target.agent());
        target.trade(_hash(), _legs(pool, buy, amount, 0));
    }
    function _buy(uint256 amount) internal { _trade(lane, 0, true, amount); }
    function _close(Lane.Exit[] memory exits) internal {
        vm.prank(lane.owner());
        lane.close(exits);
    }
    function _assertLedger() internal view {
        assertLe(lane.tracked(address(cash)), cash.balanceOf(address(lane)));
        assertLe(lane.tracked(address(stock)), stock.balanceOf(address(lane)));
        assertEq(lane.heldCount(), lane.tracked(address(stock)) > 0 ? 1 : 0);
    }
}
