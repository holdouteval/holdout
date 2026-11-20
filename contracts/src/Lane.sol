// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ReentrancyGuardTransient} from "solady/utils/ReentrancyGuardTransient.sol";
import {Asset, Pool, PoolKey, SwapParams} from "./interfaces/Types.sol";
import {IERC20, IFeed, IStockToken, IAccessRegistry, IIdentityRegistry, IPoolManager} from "./interfaces/External.sol";
import {ILaneFactory} from "./interfaces/ILaneFactory.sol";

/// @notice A trading account whose owner-chosen opening principal stays fixed, with an agent key and an owner-only exit.
contract Lane is ReentrancyGuardTransient {
    enum Status { Uninitialized, Open, Closing, Closed }

    struct Seal { uint64 at; bool acted; bytes32 legsHash; }
    struct Leg { uint256 pool; bool buy; uint256 amountIn; uint256 minOut; }
    struct Exit { uint256 pool; uint256 amount; uint256 minOut; }

    address public immutable factory;
    address public immutable usdg;
    IPoolManager public immutable poolManager;
    IAccessRegistry public immutable accessRegistry;
    IIdentityRegistry public immutable identityRegistry;
    uint256 public principal;
    uint256 public immutable maxAge;
    uint256 public immutable actWindow;

    address public owner;
    address public agent;
    uint256 public laneId;
    uint256 public agentId;
    Status public status;
    mapping(address => uint256) public tracked;
    mapping(bytes32 => Seal) public seals;
    uint256 public heldCount;
    uint256 public returnedUsdg;
    uint256 public finalUsdg;

    // Consumed before external settlement calls. Only our pending unlock can use the callback.
    bytes32 private _pendingSwap;
    uint160 private constant MIN_PRICE = 4295128740;
    uint160 private constant MAX_PRICE = 1461446703485210103287273052203988822378723970341;

    event Sealed(bytes32 indexed reasoningHash, bytes32 legsHash);
    event Traded(bytes32 indexed reasoningHash, uint256 indexed pool, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut);
    event CloseStarted();
    event Exited(uint256 indexed pool, address indexed token, uint256 amountIn, uint256 usdgOut);
    event Returned(uint256 usdg);
    event Closed(uint256 finalUsdg);
    event Rescued(address indexed token, uint256 amount);

    error NotAuthorized();
    error WrongStatus();
    error NotListed(address token);
    error OverTracked();
    error ZeroAmount();
    error ZeroHash();
    error NoLegs();
    error AlreadySealed(bytes32 recordHash);
    error AlreadyActed(bytes32 recordHash);
    error ActWindowPassed(bytes32 recordHash, uint256 at);
    error LegsMismatch(bytes32 recordHash);
    error NotTradable(bytes32 recordHash);
    error DiscountToFeed(address token, uint256 valued, uint256 paid);
    error StaleFeed(address token, uint256 age);
    error BadFeed(address token);
    error TokenPaused(address token);
    error OracleFlagged(address token);
    error LaneBlocked();
    error MinOut(uint256 got, uint256 minOut);
    error PartialFill(address token, uint256 paid, uint256 wanted);
    error NothingToExit(address token);
    error BadConfig();
    error PrincipalMismatch(uint256 received);

    constructor(
        address factory_, address usdg_, address poolManager_, address accessRegistry_,
        address identityRegistry_, uint256 maxAge_, uint256 actWindow_
    ) {
        factory = factory_;
        usdg = usdg_;
        poolManager = IPoolManager(poolManager_);
        accessRegistry = IAccessRegistry(accessRegistry_);
        identityRegistry = IIdentityRegistry(identityRegistry_);
        maxAge = maxAge_;
        actWindow = actWindow_;
        status = Status.Closed;
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAuthorized();
        _;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotAuthorized();
        _;
    }

    modifier onlyOpen() {
        if (status != Status.Open) revert WrongStatus();
        _;
    }

    function initialize(address owner_, address agent_, uint256 laneId_, uint256 principal_, string calldata uri)
        external returns (uint256 id)
    {
        if (msg.sender != factory) revert NotAuthorized();
        if (status != Status.Uninitialized) revert WrongStatus();
        owner = owner_;
        agent = agent_;
        laneId = laneId_;
        status = Status.Open;
        principal = principal_;
        tracked[usdg] = principal_;
        uint256 balance = IERC20(usdg).balanceOf(address(this));
        if (balance < principal_) revert PrincipalMismatch(balance);
        id = identityRegistry.register(uri);
        agentId = id;
    }

    function seal(bytes32 recordHash, bytes32 legsHash) external onlyAgent onlyOpen {
        _seal(recordHash, legsHash);
    }

    function trade(bytes32 recordHash, Leg[] calldata legs) external onlyAgent onlyOpen nonReentrant {
        if (legs.length == 0) revert NoLegs();
        bytes32 lh = keccak256(abi.encode(legs));
        if (lh == bytes32(0)) revert ZeroHash();
        Seal storage s = seals[recordHash];
        if (s.at == 0) {
            _seal(recordHash, lh);
        } else {
            if (s.legsHash == bytes32(0)) revert NotTradable(recordHash);
            if (s.legsHash != lh) revert LegsMismatch(recordHash);
            if (block.timestamp - s.at > actWindow) revert ActWindowPassed(recordHash, s.at);
            if (s.acted) revert AlreadyActed(recordHash);
        }
        s.acted = true;
        for (uint256 i; i < legs.length; ++i) _tradeLeg(recordHash, legs[i]);
    }

    function close(Exit[] calldata exits) external onlyOwner nonReentrant {
        if (status == Status.Open) {
            status = Status.Closing;
            emit CloseStarted();
        } else if (status != Status.Closing) {
            revert WrongStatus();
        }
        uint256 cash = tracked[usdg];
        if (cash != 0) {
            tracked[usdg] = 0;
            _returnUsdg(cash);
        }
        for (uint256 i; i < exits.length; ++i) {
            Exit calldata e = exits[i];
            Pool memory p = _pool(e.pool);
            uint256 balance = tracked[p.token];
            if (balance == 0) revert NothingToExit(p.token);
            uint256 n = e.amount == type(uint256).max ? balance : e.amount;
            if (n == 0 || n > balance) revert OverTracked();
            (uint256 paid, uint256 got) = _swap(p.key, p.token, n);
            if (paid != n) revert PartialFill(p.token, paid, n);
            if (got < e.minOut) revert MinOut(got, e.minOut);
            tracked[p.token] = balance - n;
            if (balance == n) --heldCount;
            emit Exited(e.pool, p.token, n, got);
            _returnUsdg(got);
        }
        if (heldCount == 0) {
            status = Status.Closed;
            finalUsdg = returnedUsdg;
            emit Closed(finalUsdg);
        }
    }

    function rescue(address t) external onlyOwner nonReentrant {
        if (status != Status.Closed) revert WrongStatus();
        uint256 n = IERC20(t).balanceOf(address(this));
        SafeTransferLib.safeTransfer(t, owner, n);
        emit Rescued(t, n);
    }

    function setAgentURI(string calldata uri) external onlyOwner {
        identityRegistry.setAgentURI(agentId, uri);
    }

    function checkBuy(address t) external view {
        _checkBuy(t);
    }

    function sellable(address t) external view returns (bool) {
        return !IStockToken(t).paused() && !accessRegistry.isBlocked(address(this));
    }

    /// @notice Ledger value in six-decimal USDG; the feed already includes UI scaling.
    function value() external view returns (uint256 v) {
        v = tracked[usdg];
        ILaneFactory f = ILaneFactory(factory);
        uint256 count = f.assetCount();
        for (uint256 i; i < count; ++i) {
            Asset memory a = f.assetAt(i);
            uint256 n = tracked[a.token];
            if (n == 0) continue;
            (, int256 answer,, uint256 updatedAt,) = IFeed(a.feed).latestRoundData();
            if (answer <= 0 || updatedAt == 0) revert BadFeed(a.token);
            v += n * uint256(answer) / 1e20;
        }
    }

    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != address(identityRegistry)) revert NotAuthorized();
        return this.onERC721Received.selector;
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || _pendingSwap == bytes32(0) || keccak256(data) != _pendingSwap) {
            revert NotAuthorized();
        }
        _pendingSwap = bytes32(0);
        (PoolKey memory key, bool zeroForOne, uint256 amountIn) = abi.decode(data, (PoolKey, bool, uint256));
        int256 delta = poolManager.swap(
            key, SwapParams(zeroForOne, -int256(amountIn), zeroForOne ? MIN_PRICE : MAX_PRICE), ""
        );
        int128 d0 = int128(delta >> 128);
        int128 d1 = int128(delta);
        int128 dIn = zeroForOne ? d0 : d1;
        int128 dOut = zeroForOne ? d1 : d0;
        if (dIn > 0 || dOut < 0) revert BadConfig();
        uint256 paid = uint256(-int256(dIn));
        uint256 got = uint256(uint128(dOut));
        if (paid > amountIn) revert BadConfig();
        if (paid != 0) {
            address tokenIn = zeroForOne ? key.currency0 : key.currency1;
            poolManager.sync(tokenIn);
            SafeTransferLib.safeTransfer(tokenIn, address(poolManager), paid);
            if (poolManager.settle() != paid) revert BadConfig();
        }
        if (got != 0) poolManager.take(zeroForOne ? key.currency1 : key.currency0, address(this), got);
        return abi.encode(paid, got);
    }

    function _seal(bytes32 recordHash, bytes32 legsHash) private {
        if (recordHash == bytes32(0)) revert ZeroHash();
        if (seals[recordHash].at != 0) revert AlreadySealed(recordHash);
        seals[recordHash] = Seal(uint64(block.timestamp), false, legsHash);
        emit Sealed(recordHash, legsHash);
    }

    function _tradeLeg(bytes32 recordHash, Leg calldata leg) private {
        Pool memory p = _pool(leg.pool);
        address tokenIn = leg.buy ? usdg : p.token;
        address tokenOut = leg.buy ? p.token : usdg;
        uint256 answer = 0;
        if (leg.buy) answer = _checkBuy(p.token);
        uint256 amountIn = leg.amountIn == type(uint256).max ? tracked[tokenIn] : leg.amountIn;
        if (amountIn == 0) revert ZeroAmount();
        if (amountIn > tracked[tokenIn]) revert OverTracked();
        (uint256 paid, uint256 got) = _swap(p.key, tokenIn, amountIn);
        if (paid != amountIn) revert PartialFill(tokenIn, paid, amountIn);
        if (got < leg.minOut) revert MinOut(got, leg.minOut);
        if (leg.buy) {
            uint256 previous = tracked[p.token];
            uint256 valued = (previous + got) * answer / 1e20 - previous * answer / 1e20;
            if (valued > paid) revert DiscountToFeed(p.token, valued, paid);
            if (previous == 0 && got != 0) ++heldCount;
        } else if (paid == tracked[p.token]) {
            --heldCount;
        }
        tracked[tokenIn] -= paid;
        tracked[tokenOut] += got;
        emit Traded(recordHash, leg.pool, tokenIn, tokenOut, paid, got);
    }

    function _pool(uint256 index) private view returns (Pool memory) {
        ILaneFactory f = ILaneFactory(factory);
        if (index >= f.poolCount()) revert NotListed(address(0));
        return f.poolAt(index);
    }

    function _checkBuy(address t) private view returns (uint256) {
        ILaneFactory f = ILaneFactory(factory);
        uint256 slot = f.assetOf(t);
        if (slot == 0) revert NotListed(t);
        if (IStockToken(t).paused()) revert TokenPaused(t);
        if (IStockToken(t).oraclePaused()) revert OracleFlagged(t);
        if (accessRegistry.isBlocked(address(this))) revert LaneBlocked();
        (, int256 answer,, uint256 updatedAt,) = IFeed(f.assetAt(slot - 1).feed).latestRoundData();
        if (answer <= 0 || updatedAt == 0) revert BadFeed(t);
        uint256 age = block.timestamp > updatedAt ? block.timestamp - updatedAt : 0;
        if (age > maxAge) revert StaleFeed(t, age);
        return uint256(answer);
    }

    function _swap(PoolKey memory key, address tokenIn, uint256 amountIn) private returns (uint256 paid, uint256 got) {
        if (amountIn > uint256(uint128(type(int128).max))) revert OverTracked();
        bytes memory data = abi.encode(key, tokenIn == key.currency0, amountIn);
        _pendingSwap = keccak256(data);
        bytes memory result = poolManager.unlock(data);
        if (_pendingSwap != bytes32(0)) revert BadConfig();
        (paid, got) = abi.decode(result, (uint256, uint256));
    }

    function _returnUsdg(uint256 n) private {
        returnedUsdg += n;
        SafeTransferLib.safeTransfer(usdg, owner, n);
        emit Returned(n);
    }

    function _useTransientReentrancyGuardOnlyOnMainnet() internal pure override returns (bool) {
        return false;
    }
}
