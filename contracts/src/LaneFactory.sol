// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Ownable} from "solady/auth/Ownable.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {LibString} from "solady/utils/LibString.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";
import {ReentrancyGuardTransient} from "solady/utils/ReentrancyGuardTransient.sol";
import {Lane} from "./Lane.sol";
import {Asset, Pool, PoolKey} from "./interfaces/Types.sol";
import {IERC20, IBurnable, IFeed, IStockToken, IStateView} from "./interfaces/External.sol";

/// @notice Creates accounts with shared rules and owner-chosen principal after an exact supply burn.
contract LaneFactory is Ownable, ReentrancyGuardTransient {
    address public immutable usdg;
    address public immutable poolManager;
    address public immutable stateView;
    address public immutable accessRegistry;
    address public immutable identityRegistry;
    uint256 public immutable maxAge;
    uint256 public immutable actWindow;
    address public immutable implementation;

    address public token;
    uint256 public burnAmount;
    string public identityBase;
    Asset[] private _assets;
    Pool[] private _pools;
    address[] private _lanes;
    mapping(address => uint256) public assetOf;
    mapping(bytes32 => bool) public poolListed;
    mapping(address => bool) public isLane;

    event TokenSet(address token);
    event BurnAmountSet(uint256 amount);
    event IdentityBaseSet(string base);
    event AssetListed(uint256 indexed assetId, address indexed token, address feed);
    event PoolListed(uint256 indexed poolIndex, address indexed token, bytes32 indexed poolId, uint24 fee, int24 tickSpacing, address hooks);
    event LaneOpened(uint256 indexed laneId, address indexed lane, address indexed owner, address agent, uint256 burned, uint256 agentId, uint256 principal, string name);

    error BadConfig();
    error ZeroPrincipal();
    error PrincipalMismatch(uint256 received);
    error BurnMismatch(uint256 burned);
    error TokenNotSet();
    error TokenAlreadySet();
    error BurnNotSet();
    error IdentityBaseNotSet();
    error BadName();
    error AgentIsOwner();
    error ZeroAddress();
    error AlreadyListed();
    error NotListed(address token);
    error PoolNotInitialized();
    error NotPairedWithUsdg();

    constructor(
        address usdg_, address poolManager_, address stateView_, address accessRegistry_, address identityRegistry_,
        uint256 maxAge_, uint256 actWindow_, address owner_
    ) {
        if (usdg_ == address(0) || poolManager_ == address(0) || stateView_ == address(0)
            || accessRegistry_ == address(0) || identityRegistry_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        if (maxAge_ == 0 || actWindow_ == 0) revert BadConfig();
        usdg = usdg_;
        poolManager = poolManager_;
        stateView = stateView_;
        accessRegistry = accessRegistry_;
        identityRegistry = identityRegistry_;
        maxAge = maxAge_;
        actWindow = actWindow_;
        _initializeOwner(owner_);
        implementation = address(new Lane(address(this), usdg_, poolManager_, accessRegistry_, identityRegistry_, maxAge_, actWindow_));
    }

    function setToken(address t) external onlyOwner {
        if (token != address(0)) revert TokenAlreadySet();
        if (t.code.length == 0) revert BadConfig();
        token = t;
        emit TokenSet(t);
    }

    function setBurnAmount(uint256 n) external onlyOwner {
        if (n == 0) revert BadConfig();
        burnAmount = n;
        emit BurnAmountSet(n);
    }

    function setIdentityBase(string calldata b) external onlyOwner {
        if (bytes(b).length == 0) revert BadConfig();
        identityBase = b;
        emit IdentityBaseSet(b);
    }

    function listAsset(address t, address feed) external onlyOwner returns (uint256 assetId) {
        if (assetOf[t] != 0) revert AlreadyListed();
        if (t == address(0) || feed == address(0)) revert ZeroAddress();
        if (t == usdg || IERC20(t).decimals() != 18 || IFeed(feed).decimals() != 8) revert BadConfig();
        (, int256 answer,, uint256 updatedAt,) = IFeed(feed).latestRoundData();
        if (answer <= 0 || updatedAt == 0) revert BadConfig();
        IStockToken(t).paused();
        IStockToken(t).oraclePaused();
        if (IStockToken(t).ACCESS_CONTROLLED_REGISTRY() != accessRegistry) revert BadConfig();
        assetId = _assets.length;
        _assets.push(Asset(t, feed));
        assetOf[t] = assetId + 1;
        emit AssetListed(assetId, t, feed);
    }

    function listPool(address t, PoolKey calldata key) external onlyOwner returns (uint256 poolIndex) {
        if (assetOf[t] == 0) revert NotListed(t);
        bool paired = (key.currency0 == usdg && key.currency1 == t) || (key.currency0 == t && key.currency1 == usdg);
        if (!paired || key.currency0 >= key.currency1) revert NotPairedWithUsdg();
        bytes32 poolId = keccak256(abi.encode(key));
        if (poolListed[poolId]) revert AlreadyListed();
        (uint160 price,,,) = IStateView(stateView).getSlot0(poolId);
        if (price == 0) revert PoolNotInitialized();
        poolIndex = _pools.length;
        _pools.push(Pool(t, key, poolId));
        poolListed[poolId] = true;
        emit PoolListed(poolIndex, t, poolId, key.fee, key.tickSpacing, key.hooks);
    }

    function openLane(address agent, string calldata name, uint256 amount) external payable nonReentrant returns (address lane) {
        if (token == address(0)) revert TokenNotSet();
        uint256 burn = burnAmount;
        if (burn == 0) revert BurnNotSet();
        if (bytes(identityBase).length == 0) revert IdentityBaseNotSet();
        if (agent == address(0)) revert ZeroAddress();
        if (agent == msg.sender) revert AgentIsOwner();
        if (bytes(name).length == 0 || bytes(name).length > 32) revert BadName();
        if (amount == 0) revert ZeroPrincipal();

        _burn(burn);

        uint256 laneId = _lanes.length;
        lane = LibClone.cloneDeterministic(implementation, bytes32(laneId));
        isLane[lane] = true;
        _lanes.push(lane);
        _fund(lane, amount);
        uint256 agentId = Lane(lane).initialize(msg.sender, agent, laneId, amount, string.concat(identityBase, LibString.toHexString(lane), ".json"));
        if (msg.value != 0) SafeTransferLib.safeTransferETH(agent, msg.value);
        emit LaneOpened(laneId, lane, msg.sender, agent, burn, agentId, amount, name);
    }

    function _burn(uint256 burn) private {
        uint256 beforeSupply = IERC20(token).totalSupply();
        IBurnable(token).burnFrom(msg.sender, burn);
        uint256 afterSupply = IERC20(token).totalSupply();
        if (afterSupply > beforeSupply) revert BurnMismatch(0);
        uint256 burned = beforeSupply - afterSupply;
        if (burned != burn) revert BurnMismatch(burned);
    }

    function _fund(address lane, uint256 amount) private {
        uint256 beforeBalance = IERC20(usdg).balanceOf(lane);
        SafeTransferLib.safeTransferFrom(usdg, msg.sender, lane, amount);
        uint256 afterBalance = IERC20(usdg).balanceOf(lane);
        if (afterBalance < beforeBalance) revert PrincipalMismatch(0);
        uint256 received = afterBalance - beforeBalance;
        if (received != amount) revert PrincipalMismatch(received);
    }

    function predictLane(uint256 laneId) external view returns (address) {
        return LibClone.predictDeterministicAddress(implementation, bytes32(laneId), address(this));
    }

    function assetCount() external view returns (uint256) { return _assets.length; }
    function assetAt(uint256 index) external view returns (Asset memory) { return _assets[index]; }
    function poolCount() external view returns (uint256) { return _pools.length; }
    function poolAt(uint256 index) external view returns (Pool memory) { return _pools[index]; }
    function laneCount() external view returns (uint256) { return _lanes.length; }
    function laneAt(uint256 index) external view returns (address) { return _lanes[index]; }

    /// @notice Completes a handover requested by the recipient; direct one-step transfers are disabled.
    function transferOwnership(address newOwner) public payable override onlyOwner {
        if (newOwner == address(0)) revert NewOwnerIsZeroAddress();
        completeOwnershipHandover(newOwner);
    }

    function _useTransientReentrancyGuardOnlyOnMainnet() internal pure override returns (bool) {
        return false;
    }
}
