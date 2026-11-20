// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {Lane} from "../../src/Lane.sol";
import {LaneFactory} from "../../src/LaneFactory.sol";
import {PoolKey} from "../../src/interfaces/Types.sol";
import {LocalSetup} from "../utils/LocalSetup.sol";
import {LocalToken, LocalStock, LocalFeed} from "../utils/LocalMocks.sol";

contract LocalLaneHandler is Test {
    Lane public lane;
    Lane[] public lanes;
    LaneFactory public immutable factory;
    LocalToken public immutable project;
    LocalToken public immutable cash;
    LocalStock public immutable stock;
    LocalStock public immutable secondStock;
    LocalFeed public immutable feed;
    LocalFeed public immutable secondFeed;
    mapping(address => uint256) public returned;
    mapping(address => uint256) public openingPrincipal;
    uint256 public decisions;
    uint256 public successfulTrades;
    uint256 public successfulCloses;
    mapping(address => uint8) public lastStatus;
    bool public statusWentBack;

    constructor(Lane lane_, LocalToken cash_, LocalStock stock_, LocalFeed feed_, LocalStock secondStock_, LocalFeed secondFeed_) {
        lane = lane_;
        lanes.push(lane_);
        factory = LaneFactory(lane_.factory());
        project = LocalToken(factory.token());
        cash = cash_;
        stock = stock_;
        feed = feed_;
        secondStock = secondStock_;
        secondFeed = secondFeed_;
        lastStatus[address(lane_)] = uint8(lane_.status());
        openingPrincipal[address(lane_)] = lane_.principal();
    }

    function open(uint256 principalSeed) external {
        uint256 amount = bound(principalSeed, 1, 1e24);
        address owner = lane.owner();
        address agent = lane.agent();
        cash.mint(owner, amount);
        project.mint(owner, factory.burnAmount());
        vm.prank(owner);
        lane = Lane(factory.openLane(agent, "random principal", amount));
        lanes.push(lane);
        openingPrincipal[address(lane)] = amount;
        lastStatus[address(lane)] = uint8(lane.status());
    }

    function laneCount() external view returns (uint256) { return lanes.length; }

    function buy(uint256 amountSeed) external {
        uint256 pool = amountSeed & 1;
        (pool == 0 ? feed : secondFeed).set(50e8, block.timestamp);
        uint256 amount = bound(amountSeed, 2, 50e6);
        Lane.Leg[] memory legs = new Lane.Leg[](1);
        legs[0] = Lane.Leg(pool, true, amount, 0);
        vm.prank(lane.agent());
        try lane.trade(_hash(), legs) { ++successfulTrades; } catch {}
        _observeStatus();
    }

    function sell(uint256 amountSeed) external {
        uint256 pool = amountSeed & 1;
        uint256 held = lane.tracked(address(pool == 0 ? stock : secondStock));
        uint256 amount = held == 0 ? 1 : bound(amountSeed, 1, held);
        Lane.Leg[] memory legs = new Lane.Leg[](1);
        legs[0] = Lane.Leg(pool, false, amount, 0);
        vm.prank(lane.agent());
        try lane.trade(_hash(), legs) { ++successfulTrades; } catch {}
        _observeStatus();
    }

    function seal(uint256 salt) external {
        vm.prank(lane.agent());
        try lane.seal(keccak256(abi.encode(salt, ++decisions)), 0) {} catch {}
        _observeStatus();
    }

    function close(uint256 amountSeed, bool exitStock) external {
        uint256 pool = amountSeed & 1;
        uint256 held = lane.tracked(address(pool == 0 ? stock : secondStock));
        Lane.Exit[] memory exits = new Lane.Exit[](exitStock && held != 0 ? 1 : 0);
        if (exits.length != 0) exits[0] = Lane.Exit(pool, bound(amountSeed, 1, held), 0);
        uint256 before = cash.balanceOf(lane.owner());
        vm.prank(lane.owner());
        try lane.close(exits) {
            returned[address(lane)] += cash.balanceOf(lane.owner()) - before;
            ++successfulCloses;
        } catch {}
        _observeStatus();
    }

    function donate(uint256 cashSeed, uint256 stockSeed) external {
        cash.mint(address(lane), bound(cashSeed, 1, 1e9));
        stock.mint(address(lane), bound(stockSeed, 1, 1e18));
        secondStock.mint(address(lane), bound(stockSeed, 1, 1e18));
        _observeStatus();
    }

    function rescue(uint8 tokenSeed) external {
        address token = tokenSeed % 3 == 0 ? address(cash) : (tokenSeed % 3 == 1 ? address(stock) : address(secondStock));
        vm.prank(lane.owner());
        try lane.rescue(token) {} catch {}
        _observeStatus();
    }

    function advance(uint256 secondsSeed) external {
        vm.warp(block.timestamp + bound(secondsSeed, 1, 100_000));
        _observeStatus();
    }

    function _hash() internal returns (bytes32) { return keccak256(abi.encode(address(this), ++decisions)); }
    function _observeStatus() internal {
        uint8 current = uint8(lane.status());
        if (current < lastStatus[address(lane)]) statusWentBack = true;
        lastStatus[address(lane)] = current;
    }
}

contract LaneInvariantTest is LocalSetup {
    LocalLaneHandler internal handler;
    LocalStock internal secondStock;

    function setUp() public override {
        super.setUp();
        _buy(100e6);
        secondStock = new LocalStock(address(registry));
        LocalFeed secondFeed = new LocalFeed(50e8, block.timestamp);
        factory.listAsset(address(secondStock), address(secondFeed));
        PoolKey memory secondKey = _key(address(secondStock), 500, 10);
        _market(secondKey, 90, 1e24, -887270, 887270);
        factory.listPool(address(secondStock), secondKey);
        _trade(lane, 1, true, 100e6);
        handler = new LocalLaneHandler(lane, cash, stock, feed, secondStock, secondFeed);
        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = handler.buy.selector;
        selectors[1] = handler.sell.selector;
        selectors[2] = handler.seal.selector;
        selectors[3] = handler.close.selector;
        selectors[4] = handler.donate.selector;
        selectors[5] = handler.rescue.selector;
        selectors[6] = handler.advance.selector;
        selectors[7] = handler.open.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_U9TrackedNeverExceedsActualBalances() public view {
        for (uint256 i; i < handler.laneCount(); ++i) {
            Lane current = handler.lanes(i);
            assertLe(current.tracked(address(cash)), cash.balanceOf(address(current)));
            assertLe(current.tracked(address(stock)), stock.balanceOf(address(current)));
            assertLe(current.tracked(address(secondStock)), secondStock.balanceOf(address(current)));
        }
    }

    function invariant_U9StatusOnlyMovesForward() public view {
        assertFalse(handler.statusWentBack());
        for (uint256 i; i < handler.laneCount(); ++i) {
            assertGe(uint8(handler.lanes(i).status()), 1);
            assertLe(uint8(handler.lanes(i).status()), 3);
        }
    }

    function invariant_U9ReturnedMatchesActualOwnerPayments() public view {
        for (uint256 i; i < handler.laneCount(); ++i) {
            Lane current = handler.lanes(i);
            assertEq(current.returnedUsdg(), handler.returned(address(current)));
            if (uint8(current.status()) == 3) assertEq(current.finalUsdg(), handler.returned(address(current)));
        }
    }

    function invariant_U9OnlyManagerAndOwnerReceiveLaneAssets() public view {
        for (uint256 i; i < handler.laneCount(); ++i) {
            Lane current = handler.lanes(i);
            _allowedRecipients(cash, current);
            _allowedRecipients(stock, current);
            _allowedRecipients(secondStock, current);
        }
    }

    function invariant_U9HeldCountMatchesTrackedStock() public view {
        for (uint256 i; i < handler.laneCount(); ++i) {
            Lane current = handler.lanes(i);
            uint256 held = (current.tracked(address(stock)) == 0 ? 0 : 1) + (current.tracked(address(secondStock)) == 0 ? 0 : 1);
            assertEq(current.heldCount(), held);
        }
    }

    function invariant_P1EveryOpeningPrincipalStaysFixedWithinTheFuzzedRange() public view {
        for (uint256 i; i < handler.laneCount(); ++i) {
            Lane current = handler.lanes(i);
            assertEq(current.principal(), handler.openingPrincipal(address(current)));
            assertGe(current.principal(), 1);
            assertLe(current.principal(), 1e24);
        }
    }

    function _allowedRecipients(LocalToken token, Lane current) internal view {
        for (uint256 i; i < token.sentToCount(address(current)); ++i) {
            address recipient = token.sentTo(address(current), i);
            assertTrue(recipient == address(manager) || recipient == current.owner());
        }
    }
}
