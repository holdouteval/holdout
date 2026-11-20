<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/readme/holdout-dark.svg">
    <img src=".github/readme/holdout-light.svg" alt="holdout" width="248">
  </picture>
</p>

<h3 align="center">Build the contracts that seal each decision before the feed rounds that grade it.</h3>

<p align="center">
  <a href="https://repo.sourcify.dev/4663/0x173b1998fa57c81eeb3ed9df3eff25fca3b3f188"><img alt="sourcify" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fsourcify.dev%2Fserver%2Fv2%2Fcontract%2F4663%2F0x173b1998fa57c81eeb3ed9df3eff25fca3b3f188&query=%24.match&label=sourcify&style=flat&labelColor=171715"></a>
  <a href="LICENSE"><img alt="license MIT" src="https://img.shields.io/badge/license-MIT-696760?style=flat&labelColor=171715"></a>
</p>

<p align="center">
  <a href="https://holdout.codes">Site</a> ·
  <a href="https://github.com/holdouteval/holdout-records">Records</a> ·
  <a href="#verify-the-bytes">Verify the bytes</a>
</p>

holdout is a public eval on Robinhood Chain whose test set has not happened yet. A lane is a contract that holds a fixed USDG principal and lets one agent key trade listed stock tokens. Each decision is a record of what the agent read and what it answered. Its sha256 goes on chain in the transaction that trades on it, or before, so every Chainlink round that values those trades comes after the record is fixed. `harness/` is the house harness that asks one frontier model per lane for a decision each trading day; `mcp/` is the MCP server that puts your own agent on a lane; `contracts/` and `packages/core/` are what both stand on.

```sh
rpc=https://rpc.mainnet.chain.robinhood.com
# seconds a sealed decision stays executable
cast call 0x173b1998fa57c81eeb3ed9df3eff25fca3b3f188 'actWindow()(uint256)' --rpc-url $rpc
# when the house models decide
curl -s https://data.holdout.codes/d/harness.json | jq '{decisionTime}'
```

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/readme/fig1-seal-dark.svg">
    <img src=".github/readme/fig1-seal-light.svg" width="880" alt="FIG. 1. The RHNVDA / USD feed around one 10:00 New York decision. On the left, on paper, the ten session closes and the current answer that a house model's prompt contains, one column per session. The seam is the first block at or after 10:00, where the prompt's data stops. Above the carbon side: answer, record, sha256, then the seal or trade, in amber. On the right, on carbon, every round the feed posted after that block until the next session's 10:00, on a log time scale; the model read none of them.">
  </picture>
</p>

<sub>FIG. 1. The RHNVDA / USD feed on Robinhood Chain around 10:00 New York on Tuesday 17 November 2026, read from the chain. Left of the seam, one column per session: the ten closes and the answer at the first block at or after 10:00, which is what a house prompt contains. A house record names that block and is sealed once the model answers; the rounds after its trade are the ones that grade it. Right of the seam, on a log time scale, every round the feed posted until the next session's 10:00. No lane existed that day, so nothing was sealed: the figure places the harness's decision time on a real day of the feed.</sub>

```text
block 116666099              2026-11-17 15:00:00 UTC, the first at or after 10:00 New York
round 18446744073709553664   answer 15560102213, updated 14:46:19 UTC: "now" at that block
round 18446744073709553665   answer 15470282642, updated 15:06:07 UTC: the first after it
```

```sh
cast block 116666099 --field timestamp --rpc-url $rpc   # 1794927600, 15:00:00 UTC
nvda=0x379ec4f7c378f34a1b47e4f3cbebcbac3e8e9f15         # the RHNVDA / USD proxy
cast call $nvda 'getRoundData(uint80)(uint80,int256,uint256,uint256,uint80)' \
  18446744073709553665 --rpc-url $rpc
```

## Contracts

Robinhood Chain, chain id 4663, deployed in block `118782094`.

| Contract | Address |
|---|---|
| `LaneFactory` | `0x173b1998fa57c81eeb3ed9df3eff25fca3b3f188` |
| `Lane` implementation | `0x85db54a5bd818a6109d6bd8ac5e4c46aeab6e19e` |

Every lane is a minimal proxy that delegates every call to the implementation (Solady `LibClone`), deployed at `predictLane(laneId)`. Nothing upgrades and nothing pauses. The factory's `usdg`, `poolManager`, `stateView`, `accessRegistry`, `identityRegistry`, `maxAge`, `actWindow` and `implementation` are immutable, and each lane carries the same `maxAge` and `actWindow`.

## The seal

[`trade`](contracts/src/Lane.sol#L125-L140) either seals and swaps in one call, or executes a seal made earlier:

```solidity
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
```

- `recordHash` is the sha256 of the decision record. [`_seal`](contracts/src/Lane.sol#L242-L247) stores the block time and `legsHash` under it once (`AlreadySealed` otherwise) and emits `Sealed(recordHash, legsHash)`.
- With no earlier seal, `trade` seals and swaps in the same transaction. A Claude house lane with orders to place, and `holdout_decide`, work this way.
- [`seal(recordHash, legsHash)`](contracts/src/Lane.sol#L121-L123) commits first. A later `trade` must carry exactly the sealed legs, `keccak256(abi.encode(legs))`, no more than `actWindow` seconds after the seal, and only once. The GPT house lanes work this way: the harness seals once the model answers, and an operator sends or skips the sealed legs inside that window.
- A seal with a zero `legsHash` can never trade (`NotTradable`). That is how a lane, house or agent, records a session it holds still.
- Each leg emits `Traded(recordHash, pool, tokenIn, tokenOut, amountIn, amountOut)`.

Only the lane's agent can call `seal` or `trade`, and only while the lane is open.

## Records

A record is canonical JSON, schema `holdout.record/1`: UTF-8, keys sorted, no whitespace, no trailing newline, numbers only as safe integers ([`canonicalize`](packages/core/src/canonical.ts#L17-L58)). A house record holds the snapshot the model was shown, the request as sent, every answer attempt, the decision, the orders and the harness version ([`createRecord`](harness/src/record.ts#L20-L31)). A record written by the MCP server holds the agent's input and output, its weights and the orders. The contract only ever sees the hash, never the bytes; the binding is yours to check:

```sh
h=0x...   # reasoningHash of a Sealed or Traded log, or a decision's h in /d/lanes.json
curl -s https://data.holdout.codes/r/$h.json | sha256sum    # prints h without 0x
# the seal: block time, executed, legsHash
cast call <lane> 'seals(bytes32)(uint64,bool,bytes32)' $h --rpc-url $rpc
```

Each record names its lane. Once its seal is final, the same bytes are added to https://github.com/holdouteval/holdout-records, which only ever adds files.

## Opening a lane

[`openLane(agent, name, amount)`](contracts/src/LaneFactory.sol#L123-L143) is one transaction. The caller first approves the factory for `amount` USDG and `burnAmount()` $HOLDOUT. The call reverts unless the burn token, burn amount and identity base are set, the agent is neither zero nor the caller, the name is 1 to 32 bytes and `amount` is above zero. Then it:

1. burns `burnAmount()` of `token()` from the caller with `burnFrom`, and reverts unless total supply fell by exactly that much ([`_burn`](contracts/src/LaneFactory.sol#L145-L152));
2. clones the implementation at `predictLane(laneId)`;
3. moves exactly `amount` USDG from the caller into the lane ([`_fund`](contracts/src/LaneFactory.sol#L154-L161)). That is the principal, fixed for the lane's life. A lane has no deposit function;
4. registers the lane with the ERC-8004 identity registry under `identityBase()` + lane address + `.json`;
5. forwards any ETH sent with the call to the agent, for gas;

and emits `LaneOpened`. The caller becomes the lane's owner.
[`setToken`](contracts/src/LaneFactory.sol#L75-L80) sets `token()` once; until it does, `openLane` reverts with `TokenNotSet`.

## Gates

A buy leg reverts unless the token passes [`_checkBuy`](contracts/src/Lane.sol#L280-L292):

- `NotListed`: the token is not on the factory's asset list.
- `TokenPaused`: the issuer paused the token.
- `OracleFlagged`: the token reports `oraclePaused`.
- `LaneBlocked`: the token's access registry blocks the lane.
- `BadFeed`: the feed's answer is not above zero, or it has no update time.
- `StaleFeed`: the feed was last updated more than `maxAge` seconds ago.

After the swap, a buy reverts with `DiscountToFeed` if the tokens it bought, valued at the feed, add more to the lane's value than the USDG it paid ([the buy check in `_tradeLeg`](contracts/src/Lane.sol#L261-L265)). Every leg must spend exactly its `amountIn` (`PartialFill`) and return at least `minOut` (`MinOut`), or the transaction reverts. Sells and closing exits skip `_checkBuy`, so a lane can leave a position unless the issuer stops the token.

## Closing

Only the owner can [`close`](contracts/src/Lane.sol#L142-L174):

```solidity
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
```

The first `close` that goes through ends trading: from then on the lane is `Closing`, and the agent can neither seal nor trade. Each call pays the lane's tracked USDG to the owner, then sells each listed exit and pays the proceeds to the owner; one failed exit reverts the call, and the owner can call again. When nothing is held the lane is `Closed`, and `finalUsdg` is everything it returned. After that, [`rescue(token)`](contracts/src/Lane.sol#L176-L181) sends the lane's whole balance of any token, including tokens sent to it directly, to the owner. Closed lanes stay in the factory's list.

## Who moves what

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/readme/fig2-lane-dark.svg">
    <img src=".github/readme/fig2-lane-light.svg" width="880" alt="FIG. 2. Who can move what in one lane. In the middle, the lane and the USDG and stock tokens it tracks. The owner funds it once through openLane and is the only account it pays outside swaps, through close and, after closing, rescue; the owner can also call setAgentURI. Above, the agent calls seal and trade, in amber, and the lane pays it nothing. To the right, tokens move only in swaps with the Uniswap v4 PoolManager, for trade legs and close exits. Below, dashed reads: the feed's latestRoundData for the buy gate and value(), and the factory's asset and pool lists, read live. The factory owner calls only the factory: it lists assets and pools, sets the burn amount and identity base, and sets the token once.">
  </picture>
</p>

<sub>FIG. 2. Who can move a lane's tokens and who sets its rules, from the access checks in `Lane.sol` and `LaneFactory.sol`. Solid arrows move tokens, thin arrows are calls, dashed arrows are reads. How factory ownership moves is below.</sub>

The lane's ledger counts its principal and its own swaps; tokens sent to it directly stay out of it. [`value()`](contracts/src/Lane.sol#L196-L208) is the tracked USDG plus each tracked token amount × its feed answer / 1e20, in six-decimal USDG.

The factory owner's asset and pool lists only grow, and open lanes read them live, so a newly listed pool is tradable in every open lane. `burnAmount` and `identityBase` apply to lanes opened afterwards. Factory ownership moves in two steps, `requestOwnershipHandover` by the recipient and then `completeOwnershipHandover` or `transferOwnership` by the owner ([`LaneFactory.sol`](contracts/src/LaneFactory.sol#L174-L178)), or is renounced.

## House harness

`harness/` decides for the house lanes, one frontier model each. `https://data.holdout.codes/d/harness.json` publishes its system prompt, decision time, lineup and each model's stated cutoff ([`publicConfig`](harness/src/public-config.ts#L6-L21)).

```sh
curl -s https://data.holdout.codes/d/harness.json | jq -r .system
```

- Each NYSE trading day at 10:00 New York, 30 minutes after the open, the harness reads the chain at the first block at or after that time ([`sessionTime`](harness/src/engine.ts#L39-L44), [`blockAtTime`](packages/core/src/time.ts#L12-L24)). FIG. 1 is that moment.
- The prompt ([`buildPrompt`](harness/src/prompt.ts#L21-L57)) gives the lane's value, cash and holdings, its principal and opening date, and its last three decisions; and for every listed token its buy and sell cost, gate, feed age, answer now and closing answers for the last ten sessions. The request carries no tools.
- The model answers with one JSON object, `{"weights": {"SYM": weight, ...}, "reason": "..."}`. Weights run from 0 to 1 and sum to at most 1; the rest stays in USDG. Sells go first, then buys, in one transaction, and each order must fill completely for at least its quote minus 0.5%. A buy whose gate is not open is dropped. Differences under 1 USDG are not traded, but a weight of 0 sells the whole position.
- `claude-fable-5-2`, `claude-opus-5-5` and `claude-haiku-5-5` trade with one `trade` call when there are orders to place, and seal otherwise; a trade not sent by 10:30 is dropped, and the decision is sealed alone. For `gpt-6-astra` and `gpt-6.1-sol` the harness seals once the model answers, and an operator sends or skips the sealed legs within `actWindow` of that seal ([`config.ts`](harness/src/config.ts#L44)). A skipped decision keeps its seal.
- Models run at high effort with a 64,000-token output limit and no provider fallback.

The indexer that serves the public data and the site are not in this repository. The logs, feed rounds and records they show can be read without them.

## Put your agent on a lane

Build the MCP server and create an agent key:

```sh
git clone https://github.com/holdouteval/holdout holdout && cd holdout
npm ci && npm run build
node mcp/dist/holdout-mcp.js init --name agent --site https://holdout.codes
```

`init` writes a new key under `~/.holdout/agents/` and prints its address and an opening link, `https://holdout.codes/#open?agent=<address>`. With the lane's address, add the server to your agent:

```sh
claude mcp add holdout -- node "$PWD/mcp/dist/holdout-mcp.js" --lane <lane> \
  --data https://data.holdout.codes --site https://holdout.codes
```

The key file has mode `600` and stays on your machine. With it the server signs only `seal` and `trade` for that lane; the owner's wallet never touches it. `holdout_decide` commits a decision with target weights and trades toward them in the same `trade` call, or only seals when nothing is left to trade; `holdout_seal` commits a decision that holds still. `mcp/README.md` covers the tools and storage, and `mcp/skill/SKILL.md` is the daily procedure for the agent. An agent with its own signer can call `Lane.seal` and `Lane.trade` directly.

## Verify the bytes

You need Node.js 26, Foundry installed by `foundryup` under `~/.foundry` (the fixture step calls it to fetch solc 0.8.26), python3, curl, tar and jq.

```sh
git clone https://github.com/holdouteval/holdout holdout && cd holdout
npm ci && npm run build
npm test                 # first runs contracts/install-deps.sh and forge build
cd contracts && forge test --no-match-path 'test/fork/*'
```

`install-deps.sh` fetches forge-std, solady, v4-core and solmate at the commits in `deps.txt`, then compiles an unmodified Uniswap v4 PoolManager with solc 0.8.26 as a test-only fixture. `forge build` compiles the contracts with solc 0.8.35, Cancun, 200 optimizer runs and no IR (`foundry.toml`).

Sourcify holds the verified source of both contracts. The bytes `forge build` writes are the bytes it recompiled; at the address, only the immutables are filled in:

```sh
sourcify=https://sourcify.dev/server/v2/contract/4663
jq -r .deployedBytecode.object out/Lane.sol/Lane.json > lane.hex
curl -s "$sourcify/0x85db54a5bd818a6109d6bd8ac5e4c46aeab6e19e?fields=runtimeBytecode" \
  | jq -r .runtimeBytecode.recompiledBytecode | cmp - lane.hex   # silent if equal
curl -s "$sourcify/0x173b1998fa57c81eeb3ed9df3eff25fca3b3f188" \
  | jq '{match, runtimeMatch, creationMatch}'
```

The same check with `out/LaneFactory.sol/LaneFactory.json` and `0x173b1998fa57c81eeb3ed9df3eff25fca3b3f188` covers the factory.

## What it relies on

| You rely on | For |
|---|---|
| Each listed token's Chainlink feed | The buy gate and `value()`. A stale feed blocks buys; `value()` still prices holdings at its last answer. |
| Each stock token's issuer | Pause, oracle flag and access registry: whether a buy passes, and whether the token moves at all |
| Uniswap v4 pools | Fill prices. The feed gates buys and values holdings; it never sets a fill. |
| The factory owner | Which assets and pools are listed (only added, read live by open lanes), and the burn amount and identity base for lanes opened later |
| Each lane's agent | Its decisions, and which model made them. A record names its model; the chain fixes the record's bytes and seal time, not its author. |
| The house operator | Whether each sealed GPT decision is sent or skipped inside `actWindow` |
| The site | Building the approvals and the `openLane` call you sign, against the factory above |
| Robinhood Chain's sequencer | The block time that `maxAge` and `actWindow` are measured against |

## License

MIT
