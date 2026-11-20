// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ERC721} from "solady/tokens/ERC721.sol";

contract LocalAccessRegistry {
    mapping(address => bool) public isBlocked;
    bool public paused;

    function blockAccount(address account, bool flag) external { isBlocked[account] = flag; }
    function setPaused(bool flag) external { paused = flag; }
}

contract LocalToken {
    uint8 public decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => mapping(address => uint256)) public sent;
    mapping(address => address[]) internal _destinations;
    mapping(address => mapping(address => bool)) internal _seenDestination;
    uint256 public transferShortfall;
    uint256 public burnShortfall;
    address public callbackTarget;
    bytes public callbackData;
    bool internal _calling;

    constructor(uint8 decimals_) { decimals = decimals_; }
    function setDecimals(uint8 value) external { decimals = value; }
    function setTransferShortfall(uint256 value) external { transferShortfall = value; }
    function setBurnShortfall(uint256 value) external { burnShortfall = value; }
    function setCallback(address target, bytes calldata data) external {
        callbackTarget = target;
        callbackData = data;
    }
    function mint(address account, uint256 amount) external {
        totalSupply += amount;
        balanceOf[account] += amount;
    }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 approved = allowance[from][msg.sender];
        if (approved != type(uint256).max) allowance[from][msg.sender] = approved - amount;
        _move(from, to, amount);
        return true;
    }
    function burnFrom(address from, uint256 amount) external {
        uint256 approved = allowance[from][msg.sender];
        if (approved != type(uint256).max) allowance[from][msg.sender] = approved - amount;
        uint256 burned = amount - burnShortfall;
        balanceOf[from] -= burned;
        totalSupply -= burned;
    }
    function sentToCount(address from) external view returns (uint256) { return _destinations[from].length; }
    function sentTo(address from, uint256 index) external view returns (address) { return _destinations[from][index]; }
    function _move(address from, address to, uint256 amount) internal virtual {
        _beforeMove(from, to);
        uint256 received = amount - transferShortfall;
        balanceOf[from] -= amount;
        balanceOf[to] += received;
        totalSupply -= transferShortfall;
        sent[from][to] += received;
        if (!_seenDestination[from][to]) {
            _seenDestination[from][to] = true;
            _destinations[from].push(to);
        }
        if (callbackTarget != address(0) && !_calling) {
            _calling = true;
            (bool ok,) = callbackTarget.call(callbackData);
            require(ok, "nested call rejected");
            _calling = false;
        }
    }
    function _beforeMove(address, address) internal view virtual {}
}

contract LocalStock is LocalToken {
    address public ACCESS_CONTROLLED_REGISTRY;
    bool public tokenPaused;
    bool internal _oraclePaused;
    bool public failPaused;
    bool public failOracle;

    constructor(address registry) LocalToken(18) { ACCESS_CONTROLLED_REGISTRY = registry; }
    function setRegistry(address registry) external { ACCESS_CONTROLLED_REGISTRY = registry; }
    function setPaused(bool flag) external { tokenPaused = flag; }
    function setOraclePaused(bool flag) external { _oraclePaused = flag; }
    function setQueryFailures(bool pausedFailure, bool oracleFailure) external {
        failPaused = pausedFailure;
        failOracle = oracleFailure;
    }
    function paused() external view returns (bool) {
        require(!failPaused, "paused unavailable");
        return tokenPaused || LocalAccessRegistry(ACCESS_CONTROLLED_REGISTRY).paused();
    }
    function oraclePaused() external view returns (bool) {
        require(!failOracle, "oracle unavailable");
        return _oraclePaused;
    }
    function _beforeMove(address from, address to) internal view override {
        LocalAccessRegistry registry = LocalAccessRegistry(ACCESS_CONTROLLED_REGISTRY);
        require(!tokenPaused && !registry.paused(), "stock paused");
        require(!registry.isBlocked(from) && !registry.isBlocked(to), "account blocked");
    }
}

contract LocalFeed {
    uint8 public decimals = 8;
    int256 public answer;
    uint256 public updatedAt;
    constructor(int256 answer_, uint256 updatedAt_) { set(answer_, updatedAt_); }
    function setDecimals(uint8 value) external { decimals = value; }
    function set(int256 answer_, uint256 updatedAt_) public { answer = answer_; updatedAt = updatedAt_; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

contract LocalIdentityRegistry is ERC721 {
    uint256 public nextId = 1;
    bool public failRegister;
    mapping(uint256 => string) internal _uris;
    function name() public pure override returns (string memory) { return "Agent Identity"; }
    function symbol() public pure override returns (string memory) { return "AGENT"; }
    function setFailRegister(bool flag) external { failRegister = flag; }
    function register(string calldata uri) external returns (uint256 id) {
        require(!failRegister, "registration failed");
        id = nextId++;
        _uris[id] = uri;
        _safeMint(msg.sender, id);
    }
    function tokenURI(uint256 id) public view override returns (string memory) {
        ownerOf(id);
        return _uris[id];
    }
    function setAgentURI(uint256 id, string calldata uri) external {
        require(ownerOf(id) == msg.sender, "identity owner only");
        _uris[id] = uri;
    }
}

contract LocalNonReceiver {
    function register(address registry) external { LocalIdentityRegistry(registry).register("uri"); }
}

contract LocalRejectEther {}
