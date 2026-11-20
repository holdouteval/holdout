// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {LibString} from "solady/utils/LibString.sol";
import {Ownable} from "solady/auth/Ownable.sol";
import {LaneFactory} from "../../src/LaneFactory.sol";
import {Lane} from "../../src/Lane.sol";
import {PoolKey} from "../../src/interfaces/Types.sol";
import {
    IERC20, IStockToken, IFeed, IStateView, IIdentityRegistry, IPoolManager
} from "../../src/interfaces/External.sol";
import {ForkCatalog} from "../utils/ForkCatalog.sol";
import {ForkLiquidity} from "../utils/ForkLiquidity.sol";

interface ForkStockAdmin {
    function pause() external;
    function unpause() external;
    function pauseOracle() external;
    function unpauseOracle() external;
}

interface ForkRegistryAdmin {
    function blockAccounts(address[] calldata accounts) external;
    function unblockAccounts(address[] calldata accounts) external;
    function pause() external;
}

interface ForkLaunchToken {
    function launchFactory() external view returns (address);
}

struct ForkQuoteParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 exactAmount;
    bytes hookData;
}

interface ForkQuoter {
    function quoteExactInputSingle(ForkQuoteParams calldata params) external returns (uint256, uint256);
}

contract LaneForkTest is Test {
    address internal constant USDG = address(bytes20(hex"5fc5360d0400a0fd4f2af552add042d716f1d168"));
    address internal constant PM = address(bytes20(hex"8366a39cc670b4001a1121b8f6a443a643e40951"));
    address internal constant STATE = address(bytes20(hex"f3334192d15450cdd385c8b70e03f9a6bd9e673b"));
    address internal constant QUOTER = address(bytes20(hex"8dc178efb8111bb0973dd9d722ebeff267c98f94"));
    address internal constant REG = address(bytes20(hex"e10b6f6b275de231345c20d14ab812db62151b00"));
    address internal constant IDENTITY = address(bytes20(hex"8004a169fb4a3325136eb29fa0ceb6d2e539a432"));
    address internal constant OOS = address(bytes20(hex"9949e514cf30efdb2da30b1561d5d3553568a387"));
    address internal constant TOKEN_PAUSER = address(bytes20(hex"fccf56b674113d9c4eb0f9b3370930ced9e6ab23"));
    address internal constant ORACLE_PAUSER = address(bytes20(hex"7369d100c00f28e45d779ac9d4b1c7afa61e4abc"));
    address internal constant BLOCKER = address(bytes20(hex"913ca87347391218e5de2c17c5a0aeba8b0b28fd"));
    address internal constant PAUSER = address(bytes20(hex"e7bcb188254bc6ebbff63014dfed4cd4a024f22a"));
    uint256 internal constant PRINCIPAL = 1_000e6;
    uint256 internal constant BURN = 100_000e18;
    uint256 internal constant MAX_AGE = 90_000;
    uint256 internal constant WINDOW = 1_800;
    bytes32 internal constant TRADED = keccak256("Traded(bytes32,uint256,address,address,uint256,uint256)");
    bytes32 internal constant RETURNED = keccak256("Returned(uint256)");
    bytes32 internal constant OPENED = keccak256("LaneOpened(uint256,address,address,address,uint256,uint256,uint256,string)");
    address internal constant OWNER = address(0xA11CE);
    address internal constant AGENT = address(0xA63E);
    address internal constant STRANGER = address(0xBAD);

    LaneFactory internal factory;
    Lane internal lane;
    uint256 internal forkBlock;
    uint256[19] internal poolIndex;
    bool[19] internal listed;
    int256[19] internal actualAnswer;
    uint256 internal serial;

    function setUp() public {
        forkBlock = vm.envUint("RHC_FORK_BLOCK");
        vm.createSelectFork(vm.envString("RHC_TEST_RPC"), forkBlock);
        assertEq(block.chainid, 4663, "chain");
        factory = _factory(address(this));
        _fundUsdg(OWNER, 20_000e6);
        deal(OOS, OWNER, 1_000_000e18);
        vm.deal(OWNER, 1 ether);
        vm.startPrank(OWNER);
        IERC20(USDG).approve(address(factory), type(uint256).max);
        IERC20(OOS).approve(address(factory), type(uint256).max);
        vm.stopPrank();
        console2.log("fork block", forkBlock, "timestamp", block.timestamp);
        console2.log("state overrides: USDG balance slot 1; OOS balance via stdstore; owner ETH");
    }

    function _factory(address factoryOwner) internal returns (LaneFactory f) {
        f = new LaneFactory(USDG, PM, STATE, REG, IDENTITY, MAX_AGE, WINDOW, factoryOwner);
        if (factoryOwner == address(this)) {
            f.setToken(OOS);
            f.setBurnAmount(BURN);
            f.setIdentityBase("https://example.invalid/a/");
        }
    }

    function _fundUsdg(address account, uint256 amount) internal {
        vm.store(USDG, keccak256(abi.encode(account, uint256(1))), bytes32(amount));
        assertEq(IERC20(USDG).balanceOf(account), amount, "USDG slot 1");
    }

    function _register(uint256 catalogIndex) internal {
        if (listed[catalogIndex]) return;
        ForkCatalog.Entry memory e = ForkCatalog.at(catalogIndex);
        (, actualAnswer[catalogIndex],,,) = IFeed(e.feed).latestRoundData();
        factory.listAsset(e.token, e.feed);
        poolIndex[catalogIndex] = factory.listPool(e.token, e.key);
        listed[catalogIndex] = true;
    }

    function _open() internal returns (Lane result) {
        _register(18);
        _register(9);
        _register(17);
        _register(10);
        vm.prank(OWNER);
        result = Lane(factory.openLane(AGENT, "fork lane", PRINCIPAL));
        lane = result;
    }

    function _hash() internal returns (bytes32) {
        return keccak256(abi.encode("fork decision", ++serial));
    }

    function _legs(uint256 index, bool buy, uint256 amount, uint256 minOut)
        internal pure returns (Lane.Leg[] memory legs)
    {
        legs = new Lane.Leg[](1);
        legs[0] = Lane.Leg(index, buy, amount, minOut);
    }

    function _exits(uint256 index, uint256 amount, uint256 minOut)
        internal pure returns (Lane.Exit[] memory exits)
    {
        exits = new Lane.Exit[](1);
        exits[0] = Lane.Exit(index, amount, minOut);
    }

    function _mockFeed(uint256 catalogIndex, int256 answer, uint256 updatedAt) internal {
        address feed = ForkCatalog.at(catalogIndex).feed;
        (uint80 round,, uint256 started,, uint80 answered) = IFeed(feed).latestRoundData();
        vm.mockCall(feed, abi.encodeCall(IFeed.latestRoundData, ()), abi.encode(round, answer, started, updatedAt, answered));
    }

    function _quote(PoolKey memory key, uint256 amount) internal returns (bool ok, uint256 out) {
        bytes memory result;
        (ok, result) = QUOTER.call(abi.encodeCall(ForkQuoter.quoteExactInputSingle,
            (ForkQuoteParams(key, key.currency0 == USDG, uint128(amount), bytes("")))));
        if (ok && result.length >= 64) (out,) = abi.decode(result, (uint256, uint256));
        else ok = false;
    }

    function _prepareBuy(uint256 catalogIndex, uint256 amount) internal {
        _prepareBuyKey(catalogIndex, amount, ForkCatalog.at(catalogIndex).key);
    }

    function _prepareBuyKey(uint256 catalogIndex, uint256 amount, PoolKey memory key) internal {
        ForkCatalog.Entry memory e = ForkCatalog.at(catalogIndex);
        int256 actual = actualAnswer[catalogIndex];
        uint256 update = block.timestamp - 60;
        _mockFeed(catalogIndex, actual, update);
        console2.log("feed updatedAt refreshed", e.symbol);
        (bool ok, uint256 out) = _quote(key, amount);
        require(ok && out != 0, "buy quote");
        uint256 prior = address(lane) == address(0) ? 0 : lane.tracked(e.token);
        uint256 valued = (prior + out) * uint256(actual) / 1e20 - prior * uint256(actual) / 1e20;
        if (valued > amount) {
            uint256 allowed = amount * 1e20 / out * 999 / 1000;
            console2.log("discount at actual answer", e.symbol);
            console2.log("actual answer", uint256(actual), "mock answer", allowed);
            _mockFeed(catalogIndex, int256(allowed), update);
        }
    }

    function _buy(uint256 catalogIndex, uint256 amount) internal {
        _prepareBuy(catalogIndex, amount);
        vm.prank(AGENT);
        lane.trade(_hash(), _legs(poolIndex[catalogIndex], true, amount, 0));
    }

    function _fourBuys() internal {
        _prepareBuy(18, 300e6);
        _prepareBuy(9, 300e6);
        _prepareBuy(17, 150e6);
        _prepareBuy(10, 150e6);
        Lane.Leg[] memory legs = new Lane.Leg[](4);
        legs[0] = Lane.Leg(poolIndex[18], true, 300e6, 0);
        legs[1] = Lane.Leg(poolIndex[9], true, 300e6, 0);
        legs[2] = Lane.Leg(poolIndex[17], true, 150e6, 0);
        legs[3] = Lane.Leg(poolIndex[10], true, 150e6, 0);
        vm.prank(AGENT);
        lane.trade(_hash(), legs);
    }

    function _fourExits() internal view returns (Lane.Exit[] memory exits) {
        exits = new Lane.Exit[](4);
        exits[0] = Lane.Exit(poolIndex[18], type(uint256).max, 0);
        exits[1] = Lane.Exit(poolIndex[9], type(uint256).max, 0);
        exits[2] = Lane.Exit(poolIndex[17], type(uint256).max, 0);
        exits[3] = Lane.Exit(poolIndex[10], type(uint256).max, 0);
    }

    function _sumReturned(Vm.Log[] memory logs) internal view returns (uint256 sum) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(lane) && logs[i].topics[0] == RETURNED) {
                sum += abi.decode(logs[i].data, (uint256));
            }
        }
    }

    function _jsonArray(string[] memory rows) internal pure returns (string memory encoded) {
        encoded = "[";
        for (uint256 i; i < rows.length; ++i) encoded = string.concat(encoded, i == 0 ? "" : ",", rows[i]);
        return string.concat(encoded, "]");
    }

    function inspectAndList(LaneFactory target, uint256 catalogIndex) external returns (uint256) {
        require(msg.sender == address(this), "self");
        ForkCatalog.Entry memory e = ForkCatalog.at(catalogIndex);
        require(keccak256(abi.encode(e.key)) == e.poolId, "pool id");
        (uint160 sqrtPrice,,,) = IStateView(STATE).getSlot0(e.poolId);
        require(sqrtPrice != 0, "pool uninitialized");
        require(IERC20(e.token).decimals() == 18, "token decimals");
        require(IFeed(e.feed).decimals() == 8, "feed decimals");
        (, int256 answer,, uint256 updated,) = IFeed(e.feed).latestRoundData();
        require(answer > 0 && updated > 0, "feed data");
        require(IStockToken(e.token).ACCESS_CONTROLLED_REGISTRY() == REG, "registry");
        target.listAsset(e.token, e.feed);
        return target.listPool(e.token, e.key);
    }

    function testF0_catalogAndRegistry() public {
        LaneFactory target = _factory(address(this));
        string[] memory rows = new string[](19);
        for (uint256 i; i < 19; ++i) {
            ForkCatalog.Entry memory e = ForkCatalog.at(i);
            string memory object = string.concat("f0-", vm.toString(i));
            vm.serializeString(object, "symbol", e.symbol);
            vm.serializeAddress(object, "token", e.token);
            vm.serializeAddress(object, "feed", e.feed);
            vm.serializeBytes32(object, "poolId", e.poolId);
            try this.inspectAndList(target, i) returns (uint256 index) {
                console2.log("F0 OK", i, e.symbol);
                console2.log("ACCESS_CONTROLLED_REGISTRY", IStockToken(e.token).ACCESS_CONTROLLED_REGISTRY());
                vm.serializeBool(object, "ok", true);
                vm.serializeAddress(object, "registry", IStockToken(e.token).ACCESS_CONTROLLED_REGISTRY());
                vm.serializeUint(object, "tokenDecimals", IERC20(e.token).decimals());
                vm.serializeUint(object, "feedDecimals", IFeed(e.feed).decimals());
                (, int256 answer,, uint256 updated,) = IFeed(e.feed).latestRoundData();
                vm.serializeUint(object, "answer", uint256(answer));
                vm.serializeUint(object, "updatedAt", updated);
                (uint160 sqrtPrice,,,) = IStateView(STATE).getSlot0(e.poolId);
                vm.serializeUint(object, "sqrtPriceX96", sqrtPrice);
                rows[i] = vm.serializeUint(object, "poolIndex", index);
            } catch (bytes memory reason) {
                console2.log("F0 MISMATCH", i, e.symbol);
                console2.logBytes(reason);
                vm.serializeBool(object, "ok", false);
                rows[i] = vm.serializeBytes(object, "reason", reason);
            }
        }
        vm.writeJson(string.concat('{"block":', vm.toString(forkBlock), ',"timestamp":',
            vm.toString(block.timestamp), ',"assets":', _jsonArray(rows), '}'), "./out_logs/f0.json");
    }

    function testF1_openBurnIdentityEthAndEvent() public {
        uint256 supply = IERC20(OOS).totalSupply();
        uint256 ownerUsdg = IERC20(USDG).balanceOf(OWNER);
        uint256 agentEth = AGENT.balance;
        address predicted = factory.predictLane(0);
        vm.recordLogs();
        vm.prank(OWNER);
        lane = Lane(factory.openLane{value: 0.0002 ether}(AGENT, "identity lane", PRINCIPAL));
        assertEq(address(lane), predicted, "deterministic clone");
        assertEq(supply - IERC20(OOS).totalSupply(), BURN, "exact burn");
        assertEq(ownerUsdg - IERC20(USDG).balanceOf(OWNER), PRINCIPAL);
        assertEq(IERC20(USDG).balanceOf(address(lane)), PRINCIPAL);
        assertEq(lane.tracked(USDG), PRINCIPAL);
        assertEq(lane.value(), PRINCIPAL);
        assertEq(AGENT.balance - agentEth, 0.0002 ether);
        assertEq(IIdentityRegistry(IDENTITY).ownerOf(lane.agentId()), address(lane));
        assertEq(IIdentityRegistry(IDENTITY).tokenURI(lane.agentId()),
            string.concat("https://example.invalid/a/", LibString.toHexString(address(lane)), ".json"));
        assertEq(ForkLaunchToken(OOS).launchFactory(), address(bytes20(hex"7ed598bcef8bd9edd8c97a195c6d13f40801ec7e")));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(factory) || logs[i].topics[0] != OPENED) continue;
            assertEq(uint256(logs[i].topics[1]), 0);
            assertEq(address(uint160(uint256(logs[i].topics[2]))), address(lane));
            assertEq(address(uint160(uint256(logs[i].topics[3]))), OWNER);
            (address agent, uint256 burned, uint256 id, uint256 principal, string memory name) =
                abi.decode(logs[i].data, (address, uint256, uint256, uint256, string));
            assertEq(agent, AGENT);
            assertEq(burned, BURN);
            assertEq(id, lane.agentId());
            assertEq(principal, PRINCIPAL);
            assertEq(name, "identity lane");
            found = true;
        }
        assertTrue(found, "LaneOpened");
        console2.log("OOS burn and contract ERC-8004 registration passed");
    }

    function testF1b_twoOwnerChosenPrincipalsUseActualUsdg() public {
        uint256[2] memory amounts = [uint256(37_500_000), uint256(250_000_000)];
        uint256 ownerBefore = IERC20(USDG).balanceOf(OWNER);
        uint256 supplyBefore = IERC20(OOS).totalSupply();
        string[] memory rows = new string[](2);
        for (uint256 i; i < amounts.length; ++i) {
            vm.prank(OWNER);
            Lane opened = Lane(factory.openLane(AGENT, "chosen principal", amounts[i]));
            assertEq(opened.principal(), amounts[i], "lane principal");
            assertEq(opened.tracked(USDG), amounts[i], "lane ledger");
            assertEq(IERC20(USDG).balanceOf(address(opened)), amounts[i], "actual USDG");
            assertEq(opened.value(), amounts[i], "opening value");
            assertEq(opened.laneId(), i);
            string memory object = string.concat("chosen-principal-", vm.toString(i));
            vm.serializeAddress(object, "lane", address(opened));
            vm.serializeUint(object, "principal", opened.principal());
            vm.serializeUint(object, "tracked", opened.tracked(USDG));
            rows[i] = vm.serializeUint(object, "balance", IERC20(USDG).balanceOf(address(opened)));
            console2.log("owner-chosen principal", i, amounts[i]);
        }
        assertEq(ownerBefore - IERC20(USDG).balanceOf(OWNER), amounts[0] + amounts[1]);
        assertEq(supplyBefore - IERC20(OOS).totalSupply(), BURN * 2);
        assertEq(factory.laneCount(), 2);
        vm.writeJson(string.concat('{"block":', vm.toString(forkBlock), ',"lanes":', _jsonArray(rows), '}'), "./out_logs/principal-lanes.json");
    }

    function testF2_fourLegsDeltasAndSell() public {
        _open();
        uint256 startingUsdg = IERC20(USDG).balanceOf(address(lane));
        vm.recordLogs();
        _fourBuys();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 count;
        uint256 paidTotal;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(lane) || logs[i].topics[0] != TRADED) continue;
            (address tokenIn, address tokenOut, uint256 paid, uint256 got) =
                abi.decode(logs[i].data, (address, address, uint256, uint256));
            assertEq(tokenIn, USDG);
            assertEq(lane.tracked(tokenOut), got);
            assertEq(IERC20(tokenOut).balanceOf(address(lane)), got);
            paidTotal += paid;
            ++count;
        }
        assertEq(count, 4);
        assertEq(paidTotal, 900e6);
        assertEq(startingUsdg - IERC20(USDG).balanceOf(address(lane)), paidTotal);
        assertEq(lane.tracked(USDG), 100e6);
        address nvda = ForkCatalog.at(9).token;
        uint256 amount = lane.tracked(nvda) / 2;
        uint256 before = lane.tracked(USDG);
        vm.prank(AGENT);
        lane.trade(_hash(), _legs(poolIndex[9], false, amount, 0));
        assertGt(lane.tracked(USDG), before);
        assertEq(lane.tracked(nvda), IERC20(nvda).balanceOf(address(lane)));
        vm.prank(AGENT);
        vm.expectPartialRevert(Lane.NotListed.selector);
        lane.trade(_hash(), _legs(999, true, 1, 0));
        uint256 overTracked = lane.tracked(nvda) + 1;
        vm.prank(AGENT);
        vm.expectRevert(Lane.OverTracked.selector);
        lane.trade(_hash(), _legs(poolIndex[9], false, overTracked, 0));
        vm.prank(AGENT);
        vm.expectPartialRevert(Lane.MinOut.selector);
        lane.trade(_hash(), _legs(poolIndex[9], false, 1e12, type(uint256).max));
        vm.prank(OWNER);
        vm.expectRevert(Lane.NotAuthorized.selector);
        lane.trade(_hash(), _legs(poolIndex[9], false, 1, 0));
        vm.prank(STRANGER);
        vm.expectRevert(Lane.NotAuthorized.selector);
        lane.trade(_hash(), _legs(poolIndex[9], false, 1, 0));
    }

    function testF2_allHookPoolsAllowDirectLaneSwap() public {
        uint256[6] memory indices = [uint256(5), 6, 7, 9, 10, 17];
        for (uint256 i; i < indices.length; ++i) {
            _register(indices[i]);
            _open();
            _buy(indices[i], 500e6);
            assertGt(lane.tracked(ForkCatalog.at(indices[i]).token), 0);
            console2.log("direct hook swap passed", ForkCatalog.at(indices[i]).symbol);
        }
    }

    function testF3_unsolicitedBalancesAndRescue() public {
        _open();
        _buy(18, 500e6);
        address spy = ForkCatalog.at(18).token;
        uint256 stock = lane.tracked(spy);
        uint256 usdg = lane.tracked(USDG);
        uint256 value = lane.value();
        vm.prank(PM);
        assertTrue(IERC20(spy).transfer(address(lane), 1e18));
        _fundUsdg(STRANGER, 250e6);
        vm.prank(STRANGER);
        assertTrue(IERC20(USDG).transfer(address(lane), 250e6));
        assertEq(lane.tracked(spy), stock);
        assertEq(lane.tracked(USDG), usdg);
        assertEq(lane.value(), value);
        vm.prank(OWNER);
        lane.close(_exits(poolIndex[18], type(uint256).max, 0));
        assertEq(IERC20(spy).balanceOf(address(lane)), 1e18);
        assertEq(IERC20(USDG).balanceOf(address(lane)), 250e6);
        uint256 finalResult = lane.finalUsdg();
        uint256 ownerBalance = IERC20(USDG).balanceOf(OWNER);
        vm.startPrank(OWNER);
        lane.rescue(spy);
        lane.rescue(USDG);
        vm.stopPrank();
        assertEq(IERC20(spy).balanceOf(address(lane)), 0);
        assertEq(IERC20(USDG).balanceOf(OWNER) - ownerBalance, 250e6);
        assertEq(lane.finalUsdg(), finalResult);
    }

    function testF4_stalenessBoundarySellAndClose() public {
        _open();
        _buy(18, 300e6);
        _prepareBuy(18, 300e6);
        (, int256 answer,,,) = IFeed(ForkCatalog.at(18).feed).latestRoundData();
        uint256 updated = block.timestamp - 60;
        _mockFeed(18, answer, updated);
        vm.warp(updated + MAX_AGE);
        lane.checkBuy(ForkCatalog.at(18).token);
        vm.prank(AGENT);
        lane.trade(_hash(), _legs(poolIndex[18], true, 300e6, 0));
        vm.warp(updated + MAX_AGE + 1);
        vm.prank(AGENT);
        vm.expectRevert(abi.encodeWithSelector(Lane.StaleFeed.selector, ForkCatalog.at(18).token, MAX_AGE + 1));
        lane.trade(_hash(), _legs(poolIndex[18], true, 1e6, 0));
        uint256 half = lane.tracked(ForkCatalog.at(18).token) / 2;
        vm.prank(AGENT);
        lane.trade(_hash(), _legs(poolIndex[18], false, half, 0));
        vm.prank(OWNER);
        lane.close(_exits(poolIndex[18], type(uint256).max, 0));
        assertEq(uint256(lane.status()), uint256(Lane.Status.Closed));
    }

    function testF4b_discountIgnoresAgeAndAllowsExits() public {
        _open();
        address spy = ForkCatalog.at(18).token;
        (, int256 original,,,) = IFeed(ForkCatalog.at(18).feed).latestRoundData();
        _buy(18, 300e6);
        for (uint256 i; i < 2; ++i) {
            _mockFeed(18, original * 105 / 100, block.timestamp - (i == 0 ? 30 : 3_600));
            uint256 balance = IERC20(USDG).balanceOf(address(lane));
            uint256 tracked = lane.tracked(spy);
            vm.prank(AGENT);
            vm.expectPartialRevert(Lane.DiscountToFeed.selector);
            lane.trade(_hash(), _legs(poolIndex[18], true, 300e6, 0));
            assertEq(IERC20(USDG).balanceOf(address(lane)), balance);
            assertEq(lane.tracked(spy), tracked);
        }
        uint256 quarter = lane.tracked(spy) / 4;
        vm.prank(AGENT);
        lane.trade(_hash(), _legs(poolIndex[18], false, quarter, 0));
        _mockFeed(18, original, block.timestamp - 30);
        {
            (bool ok, uint256 out) = _quote(ForkCatalog.at(18).key, 300e6);
            require(ok && out != 0, "buy quote");
            uint256 prior = lane.tracked(spy);
            uint256 valued = (prior + out) * uint256(original) / 1e20 - prior * uint256(original) / 1e20;
            console2.log("observe: actual answer buy passes", valued <= 300e6);
            console2.log("actual answer", uint256(original), "ledger increase", valued);
        }
        _prepareBuy(18, 300e6);
        uint256 value = lane.value();
        vm.prank(AGENT);
        lane.trade(_hash(), _legs(poolIndex[18], true, 300e6, 0));
        assertLe(lane.value(), value);
        _mockFeed(18, original * 105 / 100, block.timestamp - 30);
        vm.prank(OWNER);
        lane.close(_exits(poolIndex[18], type(uint256).max, 0));
        assertEq(uint256(lane.status()), uint256(Lane.Status.Closed));
    }

    function testF4c_oracleFlagOnlyBlocksAffectedBuy() public {
        _open();
        _buy(18, 300e6);
        address spy = ForkCatalog.at(18).token;
        vm.prank(ORACLE_PAUSER);
        ForkStockAdmin(spy).pauseOracle();
        vm.prank(AGENT);
        vm.expectRevert(abi.encodeWithSelector(Lane.OracleFlagged.selector, spy));
        lane.trade(_hash(), _legs(poolIndex[18], true, 1e6, 0));
        _buy(9, 300e6);
        vm.prank(AGENT);
        lane.trade(_hash(), _legs(poolIndex[18], false, type(uint256).max, 0));
        assertEq(lane.tracked(spy), 0);
    }

    function testF4d_tokenPauseAndPerAssetClose() public {
        _open();
        _buy(18, 300e6);
        _buy(9, 300e6);
        address spy = ForkCatalog.at(18).token;
        vm.prank(TOKEN_PAUSER);
        ForkStockAdmin(spy).pause();
        assertFalse(lane.sellable(spy));
        vm.prank(AGENT);
        vm.expectRevert(abi.encodeWithSelector(Lane.TokenPaused.selector, spy));
        lane.trade(_hash(), _legs(poolIndex[18], true, 1e6, 0));
        uint256 ownerBefore = IERC20(USDG).balanceOf(OWNER);
        vm.recordLogs();
        vm.prank(OWNER);
        lane.close(_exits(poolIndex[9], type(uint256).max, 0));
        uint256 returned = _sumReturned(vm.getRecordedLogs());
        assertEq(uint256(lane.status()), uint256(Lane.Status.Closing));
        assertEq(lane.tracked(USDG), 0);
        assertEq(lane.tracked(ForkCatalog.at(9).token), 0);
        assertGt(lane.tracked(spy), 0);
        vm.prank(TOKEN_PAUSER);
        ForkStockAdmin(spy).unpause();
        assertTrue(lane.sellable(spy));
        vm.recordLogs();
        vm.prank(OWNER);
        lane.close(_exits(poolIndex[18], type(uint256).max, 0));
        returned += _sumReturned(vm.getRecordedLogs());
        assertEq(uint256(lane.status()), uint256(Lane.Status.Closed));
        assertEq(lane.finalUsdg(), returned);
        assertEq(IERC20(USDG).balanceOf(OWNER) - ownerBefore, returned);
    }

    function testF4e_blockedLaneReturnsUsdgFirst() public {
        _open();
        _buy(18, 300e6);
        address[] memory accounts = new address[](1);
        accounts[0] = address(lane);
        vm.prank(BLOCKER);
        ForkRegistryAdmin(REG).blockAccounts(accounts);
        assertFalse(lane.sellable(ForkCatalog.at(18).token));
        vm.prank(AGENT);
        vm.expectRevert(Lane.LaneBlocked.selector);
        lane.trade(_hash(), _legs(poolIndex[18], true, 1e6, 0));
        uint256 ownerBefore = IERC20(USDG).balanceOf(OWNER);
        vm.prank(OWNER);
        lane.close(new Lane.Exit[](0));
        assertEq(IERC20(USDG).balanceOf(OWNER) - ownerBefore, 700e6);
        assertEq(uint256(lane.status()), uint256(Lane.Status.Closing));
        vm.prank(BLOCKER);
        ForkRegistryAdmin(REG).unblockAccounts(accounts);
        vm.prank(OWNER);
        lane.close(_exits(poolIndex[18], type(uint256).max, 0));
        assertEq(lane.finalUsdg(), IERC20(USDG).balanceOf(OWNER) - ownerBefore);
    }

    function testF4f_globalPauseDoesNotTrapUsdg() public {
        _open();
        vm.prank(PAUSER);
        ForkRegistryAdmin(REG).pause();
        vm.prank(OWNER);
        lane.close(new Lane.Exit[](0));
        assertEq(uint256(lane.status()), uint256(Lane.Status.Closed));
        assertEq(lane.finalUsdg(), PRINCIPAL);
    }

    function testF5_sealWindowReplayAndNoTrade() public {
        _open();
        _prepareBuy(18, 300e6);
        Lane.Leg[] memory legs = _legs(poolIndex[18], true, 300e6, 0);
        bytes32 record = _hash();
        bytes32 legsHash = keccak256(abi.encode(legs));
        vm.prank(AGENT);
        lane.seal(record, legsHash);
        (uint64 at, bool acted, bytes32 committed) = lane.seals(record);
        assertFalse(acted);
        assertEq(committed, legsHash);
        vm.warp(uint256(at) + WINDOW);
        vm.prank(AGENT);
        lane.trade(record, legs);
        vm.prank(AGENT);
        vm.expectRevert(abi.encodeWithSelector(Lane.AlreadyActed.selector, record));
        lane.trade(record, legs);
        bytes32 late = _hash();
        vm.prank(AGENT);
        lane.seal(late, legsHash);
        (uint64 lateAt,,) = lane.seals(late);
        vm.warp(uint256(lateAt) + WINDOW + 1);
        vm.prank(AGENT);
        vm.expectRevert(abi.encodeWithSelector(Lane.ActWindowPassed.selector, late, uint256(lateAt)));
        lane.trade(late, legs);
        bytes32 note = _hash();
        vm.prank(AGENT);
        lane.seal(note, 0);
        vm.prank(AGENT);
        vm.expectRevert(abi.encodeWithSelector(Lane.NotTradable.selector, note));
        lane.trade(note, legs);
        vm.prank(AGENT);
        vm.expectRevert(abi.encodeWithSelector(Lane.AlreadySealed.selector, note));
        lane.seal(note, legsHash);
        vm.prank(AGENT);
        vm.expectRevert(Lane.ZeroHash.selector);
        lane.seal(0, 0);
        vm.prank(AGENT);
        vm.expectRevert(Lane.NoLegs.selector);
        lane.trade(_hash(), new Lane.Leg[](0));
        vm.prank(AGENT);
        vm.expectRevert(Lane.ZeroHash.selector);
        lane.trade(0, legs);
    }

    function testF5a_automaticSealPrecedesTrade() public {
        _open();
        _prepareBuy(18, 300e6);
        Lane.Leg[] memory legs = _legs(poolIndex[18], true, 300e6, 0);
        bytes32 record = _hash();
        vm.recordLogs();
        vm.prank(AGENT);
        lane.trade(record, legs);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 sealedAt = type(uint256).max;
        uint256 tradedAt = type(uint256).max;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(lane)) continue;
            if (logs[i].topics[0] == keccak256("Sealed(bytes32,bytes32)")) {
                assertEq(logs[i].topics[1], record);
                assertEq(abi.decode(logs[i].data, (bytes32)), keccak256(abi.encode(legs)));
                sealedAt = i;
            } else if (logs[i].topics[0] == TRADED) {
                assertEq(logs[i].topics[1], record);
                tradedAt = i;
            }
        }
        assertLt(sealedAt, tradedAt);
        (uint64 timestamp, bool acted, bytes32 commitment) = lane.seals(record);
        assertEq(timestamp, block.timestamp);
        assertTrue(acted);
        assertEq(commitment, keccak256(abi.encode(legs)));
    }

    function testF5b_eachLegFieldAndOrderAreCommitted() public {
        _open();
        _prepareBuy(18, 300e6);
        _prepareBuy(9, 300e6);
        Lane.Leg[] memory legs = new Lane.Leg[](2);
        legs[0] = Lane.Leg(poolIndex[18], true, 300e6, 0);
        legs[1] = Lane.Leg(poolIndex[9], true, 300e6, 0);
        bytes32 record = _hash();
        vm.prank(AGENT);
        lane.seal(record, keccak256(abi.encode(legs)));
        for (uint256 i; i < 5; ++i) {
            Lane.Leg[] memory changed = abi.decode(abi.encode(legs), (Lane.Leg[]));
            if (i == 0) changed[0].pool = poolIndex[9];
            if (i == 1) changed[0].buy = false;
            if (i == 2) changed[0].amountIn += 1;
            if (i == 3) changed[0].minOut += 1;
            if (i == 4) (changed[0], changed[1]) = (changed[1], changed[0]);
            vm.prank(AGENT);
            vm.expectRevert(abi.encodeWithSelector(Lane.LegsMismatch.selector, record));
            lane.trade(record, changed);
        }
        vm.prank(AGENT);
        lane.trade(record, legs);
        (, bool acted,) = lane.seals(record);
        assertTrue(acted);
    }

    function testF6_closeRollbackAndFinalRecord() public {
        _open();
        _fourBuys();
        address nvda = ForkCatalog.at(9).token;
        uint256 third = lane.tracked(nvda) / 3;
        vm.prank(AGENT);
        lane.trade(_hash(), _legs(poolIndex[9], false, third, 0));
        Lane.Exit[] memory exits = _fourExits();
        exits[0].minOut = type(uint256).max;
        uint256 ownerBalance = IERC20(USDG).balanceOf(OWNER);
        uint256 ledger = lane.tracked(USDG);
        vm.prank(OWNER);
        vm.expectPartialRevert(Lane.MinOut.selector);
        lane.close(exits);
        assertEq(uint256(lane.status()), uint256(Lane.Status.Open));
        assertEq(IERC20(USDG).balanceOf(OWNER), ownerBalance);
        assertEq(lane.tracked(USDG), ledger);
        vm.recordLogs();
        vm.prank(OWNER);
        lane.close(_fourExits());
        uint256 sum = _sumReturned(vm.getRecordedLogs());
        assertEq(lane.finalUsdg(), sum);
        assertEq(lane.returnedUsdg(), sum);
        assertEq(IERC20(USDG).balanceOf(OWNER) - ownerBalance, sum);
        assertEq(lane.value(), 0);
        assertEq(lane.heldCount(), 0);
        vm.prank(AGENT);
        vm.expectRevert(Lane.WrongStatus.selector);
        lane.seal(_hash(), 0);
        vm.prank(AGENT);
        vm.expectRevert(Lane.WrongStatus.selector);
        lane.trade(_hash(), _legs(poolIndex[18], true, 1, 0));
        vm.prank(OWNER);
        vm.expectRevert(Lane.WrongStatus.selector);
        lane.close(new Lane.Exit[](0));
        assertEq(lane.finalUsdg(), sum);
    }

    function testF7_valueMatchesExactBlockFeeds() public {
        _open();
        _fourBuys();
        vm.clearMockedCalls();
        uint256[4] memory indices = [uint256(18), 9, 17, 10];
        string[] memory assets = new string[](4);
        uint256 expected = lane.tracked(USDG);
        for (uint256 i; i < indices.length; ++i) {
            ForkCatalog.Entry memory e = ForkCatalog.at(indices[i]);
            (, int256 answer,, uint256 updated,) = IFeed(e.feed).latestRoundData();
            uint256 tracked = lane.tracked(e.token);
            expected += tracked * uint256(answer) / 1e20;
            assertEq(tracked, IERC20(e.token).balanceOf(address(lane)));
            string memory key = string.concat("value-", vm.toString(i));
            vm.serializeAddress(key, "token", e.token);
            vm.serializeAddress(key, "feed", e.feed);
            vm.serializeUint(key, "tracked", tracked);
            vm.serializeUint(key, "answer", uint256(answer));
            assets[i] = vm.serializeUint(key, "updatedAt", updated);
        }
        uint256 value = lane.value();
        assertEq(value, expected);
        vm.writeJson(string.concat('{"block":', vm.toString(forkBlock), ',"timestamp":',
            vm.toString(block.timestamp), ',"usdg":', vm.toString(lane.tracked(USDG)),
            ',"value":', vm.toString(value), ',"assets":', _jsonArray(assets), '}'), "./out_logs/value-check.json");
        console2.log("value uses original block answers and timestamps; all feed mocks cleared", value);
    }

    function _newPool(uint24 fee, int24 radius, int256 liquidity) internal returns (uint256 index) {
        ForkCatalog.Entry memory e = ForkCatalog.at(18);
        (uint160 price, int24 tick,,) = IStateView(STATE).getSlot0(e.poolId);
        // Bound empty-bitmap traversal when a swap exhausts this fork-only pool.
        int24 spacing = 200;
        int24 anchor = (tick / spacing) * spacing;
        if (tick < 0 && tick % spacing != 0) anchor -= spacing;
        PoolKey memory key = PoolKey(e.key.currency0, e.key.currency1, fee, spacing, address(0));
        IPoolManager(PM).initialize(key, price);
        ForkLiquidity provider = new ForkLiquidity(PM);
        _fundUsdg(address(provider), 100_000e6);
        deal(e.token, address(provider), 100e18);
        console2.log("state override: liquidity provider SPY balance via stdstore", uint256(100e18));
        provider.add(key, anchor - radius, anchor + radius, liquidity);
        index = factory.listPool(e.token, key);
        console2.log("new local-fork pool", index, "fee", uint256(fee));
        console2.log("tick spacing 200 bounds empty bitmap traversal");
    }

    function testF8_partialFillAndMeasuredSlices() public {
        _open();
        uint256 thin = _newPool(1234, 200, 2_500_000_000_000);
        _prepareBuy(18, 500e6);
        vm.prank(AGENT);
        vm.expectPartialRevert(Lane.PartialFill.selector);
        lane.trade(_hash(), _legs(thin, true, 500e6, 0));
        _buy(18, 500e6);
        address spy = ForkCatalog.at(18).token;
        uint256 stock = lane.tracked(spy);
        uint256 ownerBalance = IERC20(USDG).balanceOf(OWNER);
        vm.prank(OWNER);
        vm.expectPartialRevert(Lane.PartialFill.selector);
        lane.close(_exits(thin, type(uint256).max, 0));
        assertEq(uint256(lane.status()), uint256(Lane.Status.Open));
        assertEq(lane.tracked(spy), stock);
        vm.recordLogs();
        vm.prank(OWNER);
        lane.close(_exits(thin, 1e12, 0));
        uint256 sum = _sumReturned(vm.getRecordedLogs());
        assertEq(lane.tracked(spy), stock - 1e12);
        assertEq(uint256(lane.status()), uint256(Lane.Status.Closing));
        vm.recordLogs();
        vm.prank(OWNER);
        lane.close(_exits(poolIndex[18], type(uint256).max, 0));
        sum += _sumReturned(vm.getRecordedLogs());
        assertEq(uint256(lane.status()), uint256(Lane.Status.Closed));
        assertEq(lane.finalUsdg(), sum);
        assertEq(IERC20(USDG).balanceOf(OWNER) - ownerBalance, sum);
    }

    function testF9_secondPoolSharesStockLedger() public {
        _open();
        uint256 other = _newPool(2345, 1000, 1e16);
        _prepareBuyKey(18, 300e6, factory.poolAt(other).key);
        vm.prank(AGENT);
        lane.trade(_hash(), _legs(other, true, 300e6, 0));
        address spy = ForkCatalog.at(18).token;
        assertGt(lane.tracked(spy), 0);
        assertEq(lane.heldCount(), 1);
        vm.prank(AGENT);
        lane.trade(_hash(), _legs(poolIndex[18], false, type(uint256).max, 0));
        assertEq(lane.tracked(spy), 0);
        assertEq(lane.heldCount(), 0);
    }

    function testF10_ownerHandoverAndRenunciation() public {
        vm.prank(STRANGER);
        factory.requestOwnershipHandover();
        factory.completeOwnershipHandover(STRANGER);
        assertEq(factory.owner(), STRANGER);
        vm.expectRevert(Ownable.Unauthorized.selector);
        factory.setBurnAmount(1);
        vm.prank(STRANGER);
        factory.renounceOwnership();
        assertEq(factory.owner(), address(0));
        ForkCatalog.Entry memory e = ForkCatalog.at(0);
        vm.prank(STRANGER);
        vm.expectRevert(Ownable.Unauthorized.selector);
        factory.listAsset(e.token, e.feed);
    }

    function testF11_observeFeedAgeAndDiscountSizes() public {
        uint256[3] memory sizes = [uint256(100e6), 250e6, 500e6];
        for (uint256 i; i < 19; ++i) {
            ForkCatalog.Entry memory e = ForkCatalog.at(i);
            (, int256 answer,, uint256 updated,) = IFeed(e.feed).latestRoundData();
            uint256 age = block.timestamp > updated ? block.timestamp - updated : 0;
            console2.log("F11", i, e.symbol);
            console2.log("feed age", age);
            for (uint256 j; j < sizes.length; ++j) {
                (bool ok, uint256 out) = _quote(e.key, sizes[j]);
                console2.log("USDG input", sizes[j]);
                if (!ok || answer <= 0) {
                    console2.log("quote unavailable");
                    continue;
                }
                uint256 valued = out * uint256(answer) / 1e20;
                console2.log("DiscountToFeed", valued > sizes[j]);
                console2.log("feed value", valued, "quoted stock", out);
            }
        }
    }
}
