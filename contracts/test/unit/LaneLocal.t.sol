// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {LibString} from "solady/utils/LibString.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Lane} from "../../src/Lane.sol";
import {LaneFactory} from "../../src/LaneFactory.sol";
import {PoolKey, Asset, Pool} from "../../src/interfaces/Types.sol";
import {LocalSetup} from "../utils/LocalSetup.sol";
import {LocalToken, LocalStock, LocalFeed, LocalNonReceiver, LocalRejectEther, LocalAccessRegistry} from "../utils/LocalMocks.sol";

contract LaneLocalTest is LocalSetup {
    event Sealed(bytes32 indexed reasoningHash, bytes32 legsHash);
    event Traded(bytes32 indexed reasoningHash, uint256 indexed pool, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut);
    event LaneOpened(uint256 indexed laneId, address indexed lane, address indexed owner, address agent, uint256 burned, uint256 agentId, uint256 principal, string name);

    function test_U1LaneAuthorizationMatrix() public {
        address[3] memory unauthorizedAgent = [OWNER, STRANGER, address(factory)];
        for (uint256 i; i < unauthorizedAgent.length; ++i) {
            vm.startPrank(unauthorizedAgent[i]);
            vm.expectRevert(Lane.NotAuthorized.selector);
            lane.seal(bytes32(uint256(1)), 0);
            vm.expectRevert(Lane.NotAuthorized.selector);
            lane.trade(bytes32(uint256(1)), _legs(0, true, 1e6, 0));
            vm.stopPrank();
        }
        address[3] memory unauthorizedOwner = [AGENT, STRANGER, address(factory)];
        for (uint256 i; i < unauthorizedOwner.length; ++i) {
            vm.startPrank(unauthorizedOwner[i]);
            vm.expectRevert(Lane.NotAuthorized.selector);
            lane.close(new Lane.Exit[](0));
            vm.expectRevert(Lane.NotAuthorized.selector);
            lane.rescue(address(cash));
            vm.expectRevert(Lane.NotAuthorized.selector);
            lane.setAgentURI("bad");
            vm.stopPrank();
        }
        vm.prank(OWNER);
        lane.setAgentURI("https://example.invalid/new");
        assertEq(identity.tokenURI(lane.agentId()), "https://example.invalid/new");
        vm.prank(AGENT);
        lane.seal(bytes32(uint256(1)), 0);
    }

    function test_U1FactoryAuthorizationMatrix() public {
        address[4] memory callers = [OWNER, AGENT, STRANGER, address(factory)];
        for (uint256 i; i < callers.length; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(Ownable.Unauthorized.selector); factory.setToken(address(project));
            vm.expectRevert(Ownable.Unauthorized.selector); factory.setBurnAmount(1);
            vm.expectRevert(Ownable.Unauthorized.selector); factory.setIdentityBase("bad");
            vm.expectRevert(Ownable.Unauthorized.selector); factory.listAsset(address(stock), address(feed));
            vm.expectRevert(Ownable.Unauthorized.selector); factory.listPool(address(stock), key);
            vm.expectRevert(Ownable.Unauthorized.selector); factory.transferOwnership(callers[i]);
            vm.expectRevert(Ownable.Unauthorized.selector); factory.renounceOwnership();
            vm.expectRevert(Ownable.Unauthorized.selector); factory.completeOwnershipHandover(callers[i]);
            vm.stopPrank();
        }
    }

    function test_U1InitializeAndCallbackBoundaries() public {
        Lane implementation = Lane(factory.implementation());
        vm.expectRevert(Lane.NotAuthorized.selector);
        lane.initialize(OWNER, AGENT, 0, PRINCIPAL, "bad");
        vm.prank(address(factory));
        vm.expectRevert(Lane.WrongStatus.selector);
        lane.initialize(OWNER, AGENT, 0, PRINCIPAL, "bad");
        vm.prank(address(factory));
        vm.expectRevert(Lane.WrongStatus.selector);
        implementation.initialize(OWNER, AGENT, 0, PRINCIPAL, "bad");
        vm.expectRevert(Lane.NotAuthorized.selector);
        lane.unlockCallback("");
        vm.prank(address(manager));
        vm.expectRevert();
        lane.unlockCallback("");
        vm.expectRevert(Lane.NotAuthorized.selector);
        lane.onERC721Received(address(this), address(this), 1, "");
        vm.prank(address(identity));
        assertEq(lane.onERC721Received(address(this), address(this), 1, ""), bytes4(0x150b7a02));
    }

    function test_U2StateMachineClosingAndClosed() public {
        assertEq(uint8(lane.status()), 1);
        _buy(100e6);
        uint256 ownerBefore = cash.balanceOf(OWNER);
        _close(new Lane.Exit[](0));
        assertEq(uint8(lane.status()), 2);
        assertEq(cash.balanceOf(OWNER) - ownerBefore, PRINCIPAL - 100e6);
        assertEq(lane.returnedUsdg(), PRINCIPAL - 100e6);
        vm.startPrank(AGENT);
        vm.expectRevert(Lane.WrongStatus.selector); lane.seal(_hash(), 0);
        vm.expectRevert(Lane.WrongStatus.selector); lane.trade(_hash(), _legs(0, false, MAX, 0));
        vm.stopPrank();
        vm.prank(OWNER);
        vm.expectRevert(Lane.WrongStatus.selector); lane.rescue(address(stock));
        _close(_exits(0, MAX, 0));
        assertEq(uint8(lane.status()), 3);
        assertEq(lane.finalUsdg(), lane.returnedUsdg());
        assertEq(lane.finalUsdg(), cash.balanceOf(OWNER) - ownerBefore);
        assertEq(lane.value(), 0);
        _assertLedger();
        vm.startPrank(AGENT);
        vm.expectRevert(Lane.WrongStatus.selector); lane.seal(_hash(), 0);
        vm.expectRevert(Lane.WrongStatus.selector); lane.trade(_hash(), _legs(0, true, 1, 0));
        vm.stopPrank();
        vm.startPrank(OWNER);
        vm.expectRevert(Lane.WrongStatus.selector); lane.close(new Lane.Exit[](0));
        lane.setAgentURI("closed-uri");
        vm.stopPrank();
        assertEq(identity.tokenURI(lane.agentId()), "closed-uri");
    }

    function test_U2UninitializedCloneAndImplementation() public {
        assertEq(uint8(Lane(factory.implementation()).status()), 3);
        assertEq(lane.owner(), OWNER);
        assertEq(lane.agent(), AGENT);
        assertEq(lane.laneId(), 0);
        assertEq(identity.ownerOf(lane.agentId()), address(lane));
        assertEq(identity.tokenURI(lane.agentId()), string.concat("https://example.invalid/a/", LibString.toHexString(address(lane)), ".json"));
        assertEq(lane.tracked(address(cash)), PRINCIPAL);
        assertEq(lane.value(), PRINCIPAL);
        Lane freshClone = Lane(LibClone.clone(factory.implementation()));
        assertEq(uint8(freshClone.status()), 0);
        vm.prank(address(factory));
        vm.expectRevert(abi.encodeWithSelector(Lane.PrincipalMismatch.selector, 0));
        freshClone.initialize(OWNER, AGENT, 99, PRINCIPAL, "clone-uri");
        assertEq(uint8(freshClone.status()), 0);
        cash.mint(address(freshClone), PRINCIPAL);
        vm.prank(address(factory)); freshClone.initialize(OWNER, AGENT, 99, PRINCIPAL, "clone-uri");
        assertEq(uint8(freshClone.status()), 1);
        assertEq(freshClone.tracked(address(cash)), PRINCIPAL);
    }

    function test_U3InlineSealPrecedesTradeAndCannotRepeat() public {
        bytes32 h = _hash();
        Lane.Leg[] memory legs = _legs(0, true, 10e6, 0);
        vm.recordLogs();
        vm.prank(AGENT);
        lane.trade(h, legs);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 sealPosition = MAX;
        uint256 tradePosition = MAX;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(lane)) continue;
            if (logs[i].topics[0] == keccak256("Sealed(bytes32,bytes32)")) sealPosition = i;
            if (logs[i].topics[0] == keccak256("Traded(bytes32,uint256,address,address,uint256,uint256)")) tradePosition = i;
        }
        assertLt(sealPosition, tradePosition);
        (uint64 at, bool acted, bytes32 legsHash) = lane.seals(h);
        assertEq(at, block.timestamp);
        assertTrue(acted);
        assertEq(legsHash, keccak256(abi.encode(legs)));
        vm.startPrank(AGENT);
        vm.expectRevert(abi.encodeWithSelector(Lane.AlreadyActed.selector, h)); lane.trade(h, legs);
        vm.expectRevert(abi.encodeWithSelector(Lane.AlreadySealed.selector, h)); lane.seal(h, legsHash);
        vm.stopPrank();
    }

    function test_U3SealWindowExactBoundary() public {
        bytes32 h = _hash();
        Lane.Leg[] memory legs = _legs(0, true, 10e6, 0);
        vm.prank(AGENT); lane.seal(h, keccak256(abi.encode(legs)));
        vm.warp(block.timestamp + 1800);
        vm.prank(AGENT); lane.trade(h, legs);
        bytes32 late = _hash();
        uint256 sealedAt = block.timestamp;
        vm.prank(AGENT); lane.seal(late, keccak256(abi.encode(legs)));
        vm.warp(block.timestamp + 1801);
        vm.prank(AGENT);
        vm.expectRevert(abi.encodeWithSelector(Lane.ActWindowPassed.selector, late, sealedAt));
        lane.trade(late, legs);
    }

    function test_U3ZeroHashNoLegsAndNoTradeDecision() public {
        vm.startPrank(AGENT);
        vm.expectRevert(Lane.ZeroHash.selector); lane.seal(0, 0);
        vm.expectRevert(Lane.ZeroHash.selector); lane.trade(0, _legs(0, true, 1e6, 0));
        vm.expectRevert(Lane.NoLegs.selector); lane.trade(bytes32(uint256(1)), new Lane.Leg[](0));
        bytes32 h = bytes32(uint256(2));
        lane.seal(h, 0);
        vm.expectRevert(abi.encodeWithSelector(Lane.NotTradable.selector, h));
        lane.trade(h, _legs(0, true, 1e6, 0));
        vm.stopPrank();
    }

    function test_U3bEveryLegFieldAndOrderBound() public {
        Lane.Leg[] memory original = new Lane.Leg[](2);
        original[0] = Lane.Leg(0, true, 2e6, 0);
        original[1] = Lane.Leg(0, true, 3e6, 0);
        bytes32 h = _hash();
        vm.prank(AGENT); lane.seal(h, keccak256(abi.encode(original)));
        for (uint256 mode; mode < 5; ++mode) {
            Lane.Leg[] memory changed = abi.decode(abi.encode(original), (Lane.Leg[]));
            if (mode == 0) changed[0].pool = 1;
            if (mode == 1) changed[0].buy = false;
            if (mode == 2) ++changed[0].amountIn;
            if (mode == 3) ++changed[0].minOut;
            if (mode == 4) (changed[0], changed[1]) = (changed[1], changed[0]);
            vm.prank(AGENT);
            vm.expectRevert(abi.encodeWithSelector(Lane.LegsMismatch.selector, h));
            lane.trade(h, changed);
        }
        vm.prank(AGENT); lane.trade(h, original);
        assertEq(lane.tracked(address(cash)), PRINCIPAL - 5e6);
    }

    function test_U4BuyGateOrderAndFutureTimestamp() public {
        address unlisted = address(new LocalStock(address(registry)));
        stock.setPaused(true);
        stock.setOraclePaused(true);
        registry.blockAccount(address(lane), true);
        feed.set(0, 0);
        vm.expectRevert(abi.encodeWithSelector(Lane.NotListed.selector, unlisted)); lane.checkBuy(unlisted);
        vm.expectRevert(abi.encodeWithSelector(Lane.TokenPaused.selector, address(stock))); lane.checkBuy(address(stock));
        stock.setPaused(false);
        vm.expectRevert(abi.encodeWithSelector(Lane.OracleFlagged.selector, address(stock))); lane.checkBuy(address(stock));
        stock.setOraclePaused(false);
        vm.expectRevert(Lane.LaneBlocked.selector); lane.checkBuy(address(stock));
        registry.blockAccount(address(lane), false);
        vm.expectRevert(abi.encodeWithSelector(Lane.BadFeed.selector, address(stock))); lane.checkBuy(address(stock));
        feed.set(-1, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(Lane.BadFeed.selector, address(stock))); lane.checkBuy(address(stock));
        feed.set(50e8, 0);
        vm.expectRevert(abi.encodeWithSelector(Lane.BadFeed.selector, address(stock))); lane.checkBuy(address(stock));
        feed.set(50e8, block.timestamp - 90_001);
        vm.expectRevert(abi.encodeWithSelector(Lane.StaleFeed.selector, address(stock), 90_001)); lane.checkBuy(address(stock));
        feed.set(50e8, block.timestamp - 90_000);
        lane.checkBuy(address(stock));
        feed.set(50e8, block.timestamp + 3600);
        lane.checkBuy(address(stock));
    }

    function test_U4DiscountAtFreshAndOldFeedAndRollback() public {
        for (uint256 i; i < 2; ++i) {
            feed.set(200e8, block.timestamp - (i == 0 ? 0 : 3600));
            uint256 cashBefore = cash.balanceOf(address(lane));
            bytes32 h = _hash();
            vm.prank(AGENT);
            vm.expectPartialRevert(Lane.DiscountToFeed.selector);
            lane.trade(h, _legs(0, true, 10e6, 0));
            assertEq(cash.balanceOf(address(lane)), cashBefore);
            assertEq(stock.balanceOf(address(lane)), 0);
            assertEq(lane.tracked(address(cash)), PRINCIPAL);
            (uint64 at,,) = lane.seals(h);
            assertEq(at, 0);
        }
        feed.set(50e8, block.timestamp - 89_999);
        uint256 beforeValue = lane.value();
        _buy(10e6);
        assertLe(lane.value(), beforeValue);
    }

    function test_U4DiscountEqualityBoundaryAndRepeatedRounding() public {
        PoolKey memory roundingPool = _key(address(stock), 500, 20);
        uint256 adjustment = roundingPool.currency0 == address(cash) ? 1e12 - 360 : 1e12 + 360;
        uint160 sqrtPrice = uint160(uint256(_price(roundingPool, 90)) * adjustment / 1e12);
        manager.initialize(roundingPool, sqrtPrice);
        cash.mint(address(liquidity), 1e40);
        stock.mint(address(liquidity), 1e40);
        liquidity.add(roundingPool, -887260, 887260, 1e24);
        uint256 pool = factory.listPool(address(stock), roundingPool);
        feed.set(240e8, block.timestamp);
        uint256 beforeValue = lane.value();
        _trade(lane, pool, true, 2);
        uint256 quantity = lane.tracked(address(stock));
        assertEq(quantity, 11_111_111_103);
        assertEq(quantity * 240e8 / 1e20, 2);
        assertEq(lane.value(), beforeValue);
        uint256 cashBefore = cash.balanceOf(address(lane));
        uint256 stockBefore = stock.balanceOf(address(lane));
        vm.prank(AGENT);
        vm.expectRevert(abi.encodeWithSelector(Lane.DiscountToFeed.selector, address(stock), 3, 2));
        lane.trade(_hash(), _legs(pool, true, 2, 0));
        assertEq(lane.tracked(address(stock)), quantity);
        assertEq(cash.balanceOf(address(lane)), cashBefore);
        assertEq(stock.balanceOf(address(lane)), stockBefore);
    }

    function test_U4SellAndCloseIgnoreOracleAndAge() public {
        _buy(100e6);
        stock.setOraclePaused(true);
        feed.set(200e8, block.timestamp - 90_001);
        _trade(lane, 0, false, lane.tracked(address(stock)) / 2);
        _close(_exits(0, MAX, 0));
        assertEq(uint8(lane.status()), 3);
    }

    function test_U4ValueRejectsBadHeldFeedAndIgnoresUnheldFeed() public {
        feed.set(0, 0);
        assertEq(lane.value(), PRINCIPAL);
        feed.set(50e8, block.timestamp);
        _buy(100e6);
        feed.set(-1, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(Lane.BadFeed.selector, address(stock))); lane.value();
        feed.set(50e8, 0);
        vm.expectRevert(abi.encodeWithSelector(Lane.BadFeed.selector, address(stock))); lane.value();
    }

    function test_U5ThinPoolPartialFillAndSplitExit() public {
        PoolKey memory thin = _key(address(stock), 100, 10);
        uint160 sqrtPrice = _price(thin, 90);
        int24 tick = TickMath.getTickAtSqrtPrice(sqrtPrice);
        int24 lower = ((tick / 10) * 10) - 20;
        int24 upper = lower + 50;
        _market(thin, 90, 1e12, lower, upper);
        uint256 thinIndex = factory.listPool(address(stock), thin);
        vm.prank(AGENT);
        vm.expectPartialRevert(Lane.PartialFill.selector);
        lane.trade(_hash(), _legs(thinIndex, true, PRINCIPAL, 0));
        _buy(200e6);
        uint256 total = lane.tracked(address(stock));
        uint256 ownerBefore = cash.balanceOf(OWNER);
        vm.prank(OWNER);
        vm.expectPartialRevert(Lane.PartialFill.selector);
        lane.close(_exits(thinIndex, MAX, 0));
        assertEq(uint8(lane.status()), 1);
        assertEq(lane.tracked(address(stock)), total);
        uint256 small = 1e12;
        vm.recordLogs();
        _close(_exits(thinIndex, small, 0));
        uint256 returnedEvents = _sumReturned(vm.getRecordedLogs());
        assertEq(uint8(lane.status()), 2);
        assertEq(lane.tracked(address(stock)), total - small);
        assertGt(lane.returnedUsdg(), PRINCIPAL - 200e6);
        vm.recordLogs();
        _close(_exits(0, MAX, 0));
        returnedEvents += _sumReturned(vm.getRecordedLogs());
        assertEq(uint8(lane.status()), 3);
        assertEq(lane.finalUsdg(), cash.balanceOf(OWNER) - ownerBefore);
        assertEq(lane.finalUsdg(), lane.returnedUsdg());
        assertEq(lane.finalUsdg(), returnedEvents);
    }

    function test_U5MinOutOverTrackedAndZeroAmount() public {
        vm.startPrank(AGENT);
        vm.expectRevert(Lane.ZeroAmount.selector); lane.trade(_hash(), _legs(0, true, 0, 0));
        vm.expectRevert(Lane.OverTracked.selector); lane.trade(_hash(), _legs(0, true, PRINCIPAL + 1, 0));
        vm.expectPartialRevert(Lane.MinOut.selector); lane.trade(_hash(), _legs(0, true, 10e6, MAX));
        vm.expectPartialRevert(Lane.NotListed.selector); lane.trade(_hash(), _legs(999, true, 1, 0));
        vm.stopPrank();
        _buy(10e6);
        vm.startPrank(OWNER);
        vm.expectPartialRevert(Lane.MinOut.selector); lane.close(_exits(0, MAX, MAX));
        vm.expectRevert(Lane.OverTracked.selector); lane.close(_exits(0, 0, 0));
        vm.expectRevert(Lane.OverTracked.selector); lane.close(_exits(0, MAX - 1, 0));
        vm.stopPrank();
        assertEq(uint8(lane.status()), 1);
        assertEq(lane.returnedUsdg(), 0);
        _close(_exits(0, MAX, 0));
    }

    function test_U5NothingToExitAndBlockedStockPartialClose() public {
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(Lane.NothingToExit.selector, address(stock)));
        lane.close(_exits(0, MAX, 0));
        _buy(10e6);
        stock.setPaused(true);
        assertFalse(lane.sellable(address(stock)));
        _close(new Lane.Exit[](0));
        assertEq(uint8(lane.status()), 2);
        vm.prank(OWNER); vm.expectRevert(); lane.close(_exits(0, MAX, 0));
        stock.setPaused(false);
        registry.blockAccount(address(lane), true);
        assertFalse(lane.sellable(address(stock)));
        registry.blockAccount(address(lane), false);
        assertTrue(lane.sellable(address(stock)));
        _close(_exits(0, MAX, 0));
    }

    function test_U6BurnMismatchAtomicity() public {
        project.setBurnShortfall(1);
        cash.mint(OWNER, PRINCIPAL);
        project.mint(OWNER, BURN);
        uint256 beforeSupply = project.totalSupply();
        address predicted = factory.predictLane(1);
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(LaneFactory.BurnMismatch.selector, BURN - 1));
        factory.openLane(AGENT, "bad-burn", PRINCIPAL);
        assertEq(project.totalSupply(), beforeSupply);
        assertEq(factory.laneCount(), 1);
        assertEq(predicted.code.length, 0);
        assertFalse(factory.isLane(predicted));
    }

    function test_U6PrincipalMismatchAtomicity() public {
        cash.setTransferShortfall(1);
        uint256[3] memory amounts = [uint256(1), PRINCIPAL, uint256(1e24)];
        for (uint256 i; i < amounts.length; ++i) {
            uint256 amount = amounts[i];
            cash.mint(OWNER, amount);
            project.mint(OWNER, BURN);
            uint256 beforeSupply = project.totalSupply();
            uint256 ownerCash = cash.balanceOf(OWNER);
            vm.prank(OWNER);
            vm.expectRevert(abi.encodeWithSelector(LaneFactory.PrincipalMismatch.selector, amount - 1));
            factory.openLane(AGENT, "bad-principal", amount);
            assertEq(project.totalSupply(), beforeSupply);
            assertEq(cash.balanceOf(OWNER), ownerCash);
            assertEq(factory.laneCount(), 1);
            assertEq(factory.predictLane(1).code.length, 0);
            assertFalse(factory.isLane(factory.predictLane(1)));
        }
    }

    function test_P1DifferentOpeningPrincipalsAreStoredTrackedAndEmitted() public {
        uint256[3] memory amounts = [uint256(1), PRINCIPAL, uint256(1e24)];
        for (uint256 i; i < amounts.length; ++i) {
            vm.recordLogs();
            Lane opened = _open(factory, OWNER, AGENT, amounts[i]);
            assertEq(opened.principal(), amounts[i]);
            assertEq(opened.tracked(address(cash)), amounts[i]);
            assertEq(cash.balanceOf(address(opened)), amounts[i]);
            Vm.Log[] memory logs = vm.getRecordedLogs();
            bool found;
            for (uint256 j; j < logs.length; ++j) {
                if (logs[j].emitter != address(factory) || logs[j].topics[0] != keccak256("LaneOpened(uint256,address,address,address,uint256,uint256,uint256,string)")) continue;
                assertEq(uint256(logs[j].topics[1]), opened.laneId());
                assertEq(address(uint160(uint256(logs[j].topics[2]))), address(opened));
                assertEq(address(uint160(uint256(logs[j].topics[3]))), OWNER);
                (address agent, uint256 burned, uint256 id, uint256 principal, string memory name) =
                    abi.decode(logs[j].data, (address, uint256, uint256, uint256, string));
                assertEq(agent, AGENT);
                assertEq(burned, BURN);
                assertEq(id, opened.agentId());
                assertEq(principal, amounts[i]);
                assertEq(name, "local");
                found = true;
            }
            assertTrue(found, "opening principal event");
        }
    }

    function test_P2ZeroPrincipalHasNoBurnTransferOrCreation() public {
        cash.mint(OWNER, PRINCIPAL);
        project.mint(OWNER, BURN);
        uint256 supply = project.totalSupply();
        uint256 ownerProject = project.balanceOf(OWNER);
        uint256 ownerCash = cash.balanceOf(OWNER);
        uint256 nextIdentity = identity.nextId();
        address predicted = factory.predictLane(1);
        vm.recordLogs();
        vm.prank(OWNER);
        vm.expectRevert(LaneFactory.ZeroPrincipal.selector);
        factory.openLane(AGENT, "zero", 0);
        assertEq(project.totalSupply(), supply);
        assertEq(project.balanceOf(OWNER), ownerProject);
        assertEq(cash.balanceOf(OWNER), ownerCash);
        assertEq(cash.balanceOf(predicted), 0);
        assertEq(cash.sent(OWNER, predicted), 0);
        assertEq(factory.laneCount(), 1);
        assertEq(predicted.code.length, 0);
        assertFalse(factory.isLane(predicted));
        assertEq(identity.nextId(), nextIdentity);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_P3DifferentPrincipalsKeepTradesAndFinalReturnsIsolated() public {
        Lane first = _open(factory, OWNER, AGENT, 10e6);
        Lane second = _open(factory, STRANGER, AGENT, 250e6);
        _trade(first, 0, true, 2e6);
        assertEq(second.tracked(address(cash)), 250e6);
        assertEq(second.tracked(address(stock)), 0);
        uint256 firstStock = first.tracked(address(stock));
        _trade(second, 0, true, 50e6);
        assertEq(first.tracked(address(cash)), 8e6);
        assertEq(first.tracked(address(stock)), firstStock);
        uint256 secondCash = second.tracked(address(cash));
        uint256 secondStock = second.tracked(address(stock));
        uint256 firstOwnerCash = cash.balanceOf(OWNER);
        vm.prank(OWNER);
        first.close(_exits(0, MAX, 0));
        uint256 firstFinal = first.finalUsdg();
        assertEq(uint8(first.status()), 3);
        assertGt(firstFinal, 0);
        assertEq(firstFinal, cash.balanceOf(OWNER) - firstOwnerCash);
        assertEq(firstFinal, first.returnedUsdg());
        assertEq(first.tracked(address(cash)), 0);
        assertEq(first.tracked(address(stock)), 0);
        assertEq(second.tracked(address(cash)), secondCash);
        assertEq(second.tracked(address(stock)), secondStock);
        assertEq(second.returnedUsdg(), 0);
        uint256 secondOwnerCash = cash.balanceOf(STRANGER);
        vm.prank(STRANGER);
        second.close(_exits(0, MAX, 0));
        assertEq(uint8(second.status()), 3);
        assertGt(second.finalUsdg(), 0);
        assertEq(second.finalUsdg(), cash.balanceOf(STRANGER) - secondOwnerCash);
        assertEq(second.finalUsdg(), second.returnedUsdg());
        assertEq(first.finalUsdg(), firstFinal);
        assertEq(second.tracked(address(cash)), 0);
        assertEq(second.tracked(address(stock)), 0);
        assertEq(first.principal(), 10e6);
        assertEq(second.principal(), 250e6);
    }

    function test_P4ReinitializationCannotChangeAnOpeningPrincipal() public {
        Lane second = _open(factory, OWNER, AGENT, 37_500_000);
        Lane[2] memory opened = [lane, second];
        for (uint256 i; i < opened.length; ++i) {
            uint256 principal = opened[i].principal();
            uint256 trackedCash = opened[i].tracked(address(cash));
            vm.prank(STRANGER);
            vm.expectRevert(Lane.NotAuthorized.selector);
            opened[i].initialize(STRANGER, AGENT, 99, principal + 1, "changed");
            vm.prank(address(factory));
            vm.expectRevert(Lane.WrongStatus.selector);
            opened[i].initialize(STRANGER, AGENT, 99, principal + 1, "changed");
            assertEq(opened[i].principal(), principal);
            assertEq(opened[i].tracked(address(cash)), trackedCash);
            assertEq(opened[i].owner(), OWNER);
        }
    }

    function test_U6RegistrationFailureAtomicityAndSafeMintReceiver() public {
        identity.setFailRegister(true);
        cash.mint(OWNER, PRINCIPAL);
        project.mint(OWNER, BURN);
        uint256 beforeSupply = project.totalSupply();
        vm.prank(OWNER); vm.expectRevert(); factory.openLane(AGENT, "bad-identity", PRINCIPAL);
        assertEq(project.totalSupply(), beforeSupply);
        assertEq(factory.laneCount(), 1);
        assertEq(factory.predictLane(1).code.length, 0);
        identity.setFailRegister(false);
        LocalNonReceiver noReceiver = new LocalNonReceiver();
        vm.expectRevert(); noReceiver.register(address(identity));
        assertEq(identity.nextId(), 2);
    }

    function test_U7TradeReentryFromAuthorizedToken() public {
        Lane attackLane = _open(factory, OWNER, address(stock));
        stock.setCallback(address(attackLane), abi.encodeCall(Lane.trade, (bytes32(uint256(55)), _legs(0, true, 1e6, 0))));
        vm.prank(address(stock));
        vm.expectRevert();
        attackLane.trade(bytes32(uint256(54)), _legs(0, true, 10e6, 0));
        assertEq(attackLane.tracked(address(cash)), PRINCIPAL);
        assertEq(attackLane.tracked(address(stock)), 0);
    }

    function test_U7CloseReentryFromAuthorizedToken() public {
        Lane attackLane = _open(factory, address(cash), AGENT);
        cash.setCallback(address(attackLane), abi.encodeCall(Lane.close, (new Lane.Exit[](0))));
        vm.prank(address(cash));
        vm.expectRevert(); attackLane.close(new Lane.Exit[](0));
        assertEq(uint8(attackLane.status()), 1);
        assertEq(attackLane.tracked(address(cash)), PRINCIPAL);
        assertEq(attackLane.returnedUsdg(), 0);
    }

    function test_U7FactoryOpenReentryFromTransfer() public {
        cash.mint(OWNER, PRINCIPAL);
        project.mint(OWNER, BURN);
        cash.setCallback(address(factory), abi.encodeCall(LaneFactory.openLane, (AGENT, "nested", PRINCIPAL)));
        uint256 supply = project.totalSupply();
        vm.prank(OWNER);
        vm.expectRevert(); factory.openLane(AGENT, "outer", PRINCIPAL);
        assertEq(factory.laneCount(), 1);
        assertEq(project.totalSupply(), supply);
    }

    function test_U10OpenPrerequisitesAndBounds() public {
        LaneFactory fresh = _newFactory();
        vm.expectRevert(LaneFactory.TokenNotSet.selector); fresh.openLane(AGENT, "a", PRINCIPAL);
        vm.expectRevert(); fresh.setToken(address(0));
        vm.expectRevert(); fresh.setToken(STRANGER);
        fresh.setToken(address(project));
        vm.expectRevert(LaneFactory.TokenAlreadySet.selector); fresh.setToken(address(project));
        vm.expectRevert(LaneFactory.BurnNotSet.selector); fresh.openLane(AGENT, "a", PRINCIPAL);
        vm.expectRevert(LaneFactory.BadConfig.selector); fresh.setBurnAmount(0);
        fresh.setBurnAmount(BURN);
        vm.expectRevert(LaneFactory.IdentityBaseNotSet.selector); fresh.openLane(AGENT, "a", PRINCIPAL);
        vm.expectRevert(LaneFactory.BadConfig.selector); fresh.setIdentityBase("");
        fresh.setIdentityBase("https://example.invalid/");
        vm.expectRevert(LaneFactory.ZeroAddress.selector); fresh.openLane(address(0), "a", PRINCIPAL);
        vm.expectRevert(LaneFactory.AgentIsOwner.selector); fresh.openLane(address(this), "a", PRINCIPAL);
        vm.expectRevert(LaneFactory.BadName.selector); fresh.openLane(AGENT, "", PRINCIPAL);
        vm.expectRevert(LaneFactory.BadName.selector); fresh.openLane(AGENT, "123456789012345678901234567890123", PRINCIPAL);
        Lane second = _open(factory, OWNER, AGENT);
        assertEq(address(second), factory.predictLane(1));
        assertTrue(factory.isLane(address(second)));
        assertEq(factory.laneAt(1), address(second));
    }

    function test_U10EtherForwardingAndRejectingAgentAtomicity() public {
        vm.deal(OWNER, 1 ether);
        cash.mint(OWNER, PRINCIPAL * 2);
        project.mint(OWNER, BURN * 2);
        uint256 agentBefore = AGENT.balance;
        vm.prank(OWNER);
        factory.openLane{value: 0.0002 ether}(AGENT, "gas", PRINCIPAL);
        assertEq(AGENT.balance - agentBefore, 0.0002 ether);
        assertEq(address(factory).balance, 0);
        LocalRejectEther reject = new LocalRejectEther();
        uint256 supply = project.totalSupply();
        uint256 ownerCash = cash.balanceOf(OWNER);
        vm.prank(OWNER);
        vm.expectRevert(); factory.openLane{value: 1}(address(reject), "reject", PRINCIPAL);
        assertEq(project.totalSupply(), supply);
        assertEq(cash.balanceOf(OWNER), ownerCash);
        assertEq(factory.laneCount(), 2);
    }

    function test_U11ListAssetAllChecks() public {
        vm.expectRevert(LaneFactory.AlreadyListed.selector); factory.listAsset(address(stock), address(feed));
        vm.expectRevert(); factory.listAsset(address(0), address(feed));
        vm.expectRevert(); factory.listAsset(address(cash), address(feed));
        LocalStock candidate = new LocalStock(address(registry));
        vm.expectRevert(LaneFactory.ZeroAddress.selector); factory.listAsset(address(candidate), address(0));
        candidate.setDecimals(6);
        vm.expectRevert(LaneFactory.BadConfig.selector); factory.listAsset(address(candidate), address(feed));
        candidate.setDecimals(18);
        feed.setDecimals(18);
        vm.expectRevert(LaneFactory.BadConfig.selector); factory.listAsset(address(candidate), address(feed));
        feed.setDecimals(8);
        feed.set(0, block.timestamp);
        vm.expectRevert(); factory.listAsset(address(candidate), address(feed));
        feed.set(50e8, 0);
        vm.expectRevert(); factory.listAsset(address(candidate), address(feed));
        feed.set(50e8, block.timestamp);
        candidate.setQueryFailures(true, false);
        vm.expectRevert(); factory.listAsset(address(candidate), address(feed));
        candidate.setQueryFailures(false, true);
        vm.expectRevert(); factory.listAsset(address(candidate), address(feed));
        candidate.setQueryFailures(false, false);
        candidate.setRegistry(address(new LocalAccessRegistry()));
        vm.expectRevert(LaneFactory.BadConfig.selector); factory.listAsset(address(candidate), address(feed));
        candidate.setRegistry(address(registry));
        assertEq(factory.listAsset(address(candidate), address(feed)), 1);
        assertEq(factory.assetOf(address(candidate)), 2);
        Asset memory entry = factory.assetAt(1);
        assertEq(entry.token, address(candidate));
        assertEq(entry.feed, address(feed));
    }

    function test_U11PoolChecksAndImmediateNewPool() public {
        vm.expectRevert(LaneFactory.AlreadyListed.selector); factory.listPool(address(stock), key);
        vm.expectPartialRevert(LaneFactory.NotListed.selector); factory.listPool(STRANGER, key);
        PoolKey memory bad = key;
        bad.currency0 = address(project);
        vm.expectRevert(LaneFactory.NotPairedWithUsdg.selector); factory.listPool(address(stock), bad);
        bad = key;
        (bad.currency0, bad.currency1) = (bad.currency1, bad.currency0);
        vm.expectRevert(LaneFactory.NotPairedWithUsdg.selector); factory.listPool(address(stock), bad);
        PoolKey memory another = _key(address(stock), 1000, 10);
        vm.expectRevert(LaneFactory.PoolNotInitialized.selector); factory.listPool(address(stock), another);
        _market(another, 90, 1e24, -887270, 887270);
        assertEq(factory.listPool(address(stock), another), 1);
        assertEq(factory.poolCount(), 2);
        assertTrue(factory.poolListed(keccak256(abi.encode(another))));
        Pool memory entry = factory.poolAt(1);
        assertEq(entry.token, address(stock));
        assertEq(entry.poolId, keccak256(abi.encode(another)));
        _trade(lane, 1, true, 100e6);
        assertEq(lane.heldCount(), 1);
        _trade(lane, 0, false, MAX);
        assertEq(lane.heldCount(), 0);
    }

    function test_ExternalInflowsAndRescuePreserveFinalRecord() public {
        uint256 valueBefore = lane.value();
        cash.mint(address(lane), 100e6);
        stock.mint(address(lane), 1e18);
        assertEq(lane.value(), valueBefore);
        assertEq(lane.tracked(address(cash)), PRINCIPAL);
        assertEq(lane.tracked(address(stock)), 0);
        _close(new Lane.Exit[](0));
        assertEq(lane.finalUsdg(), PRINCIPAL);
        vm.startPrank(OWNER);
        lane.rescue(address(cash));
        lane.rescue(address(stock));
        vm.stopPrank();
        assertEq(lane.finalUsdg(), PRINCIPAL);
        assertEq(lane.returnedUsdg(), PRINCIPAL);
        assertEq(cash.balanceOf(address(lane)), 0);
        assertEq(stock.balanceOf(address(lane)), 0);
    }

    function test_OpenEventFieldsAndFutureConfigOnly() public {
        cash.mint(OWNER, PRINCIPAL);
        project.mint(OWNER, BURN);
        address predicted = factory.predictLane(1);
        uint256 beforeSupply = project.totalSupply();
        uint256 ownerBefore = cash.balanceOf(OWNER);
        vm.expectEmit(true, true, true, true, address(factory));
        emit LaneOpened(1, predicted, OWNER, AGENT, BURN, 2, PRINCIPAL, "12345678901234567890123456789012");
        vm.prank(OWNER);
        factory.openLane(AGENT, "12345678901234567890123456789012", PRINCIPAL);
        assertEq(project.totalSupply(), beforeSupply - BURN);
        assertEq(cash.balanceOf(OWNER), ownerBefore - PRINCIPAL);
        assertEq(cash.balanceOf(predicted), PRINCIPAL);
        string memory prior = identity.tokenURI(lane.agentId());
        factory.setBurnAmount(BURN / 2);
        factory.setIdentityBase("https://example.invalid/changed/");
        assertEq(lane.tracked(address(cash)), PRINCIPAL);
        assertEq(identity.tokenURI(lane.agentId()), prior);
    }

    function test_TwoStepOwnershipAndRenounce() public {
        vm.expectRevert(); factory.transferOwnership(STRANGER);
        vm.prank(STRANGER); factory.requestOwnershipHandover();
        factory.completeOwnershipHandover(STRANGER);
        assertEq(factory.owner(), STRANGER);
        vm.expectRevert(Ownable.Unauthorized.selector); factory.setBurnAmount(1);
        vm.prank(STRANGER); factory.renounceOwnership();
        assertEq(factory.owner(), address(0));
        vm.prank(STRANGER);
        vm.expectRevert(Ownable.Unauthorized.selector); factory.listAsset(address(stock), address(feed));
    }

    function testFuzz_U8AmountsLegCountAndOrderMatchLedgerBalancesEvents(uint256 seed, uint8 countSeed) public {
        uint256 count = bound(countSeed, 1, 8);
        _buy(100e6);
        Lane.Leg[] memory legs = new Lane.Leg[](count);
        for (uint256 i; i < count; ++i) {
            bool buy = (uint256(keccak256(abi.encode(seed, i))) & 1) == 0;
            uint256 amount = buy ? bound(uint256(keccak256(abi.encode(seed, i, true))), 1e4, 10e6) : 1e15;
            legs[i] = Lane.Leg(0, buy, amount, 0);
        }
        uint256 cashBefore = cash.balanceOf(address(lane));
        uint256 stockBefore = stock.balanceOf(address(lane));
        vm.recordLogs();
        vm.prank(AGENT); lane.trade(_hash(), legs);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        int256 cashDelta;
        int256 stockDelta;
        uint256 seen;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory entry = logs[i];
            if (entry.emitter != address(lane) || entry.topics[0] != keccak256("Traded(bytes32,uint256,address,address,uint256,uint256)")) continue;
            (address tokenIn, address tokenOut, uint256 paid, uint256 got) = abi.decode(entry.data, (address, address, uint256, uint256));
            assertEq(uint256(entry.topics[2]), 0);
            assertEq(paid, legs[seen].amountIn);
            assertEq(tokenIn, legs[seen].buy ? address(cash) : address(stock));
            assertEq(tokenOut, legs[seen].buy ? address(stock) : address(cash));
            cashDelta += tokenIn == address(cash) ? -int256(paid) : int256(got);
            stockDelta += tokenIn == address(stock) ? -int256(paid) : int256(got);
            ++seen;
        }
        assertEq(seen, count);
        assertEq(int256(cash.balanceOf(address(lane))) - int256(cashBefore), cashDelta);
        assertEq(int256(stock.balanceOf(address(lane))) - int256(stockBefore), stockDelta);
        assertEq(lane.tracked(address(cash)), cash.balanceOf(address(lane)));
        assertEq(lane.tracked(address(stock)), stock.balanceOf(address(lane)));
        _assertLedger();
    }

    function _sumReturned(Vm.Log[] memory logs) internal view returns (uint256 sum) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(lane) && logs[i].topics[0] == keccak256("Returned(uint256)")) {
                sum += abi.decode(logs[i].data, (uint256));
            }
        }
    }
}
