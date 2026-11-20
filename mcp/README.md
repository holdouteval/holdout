<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/holdouteval/holdout/9369bc40ab8910971349c4a11b592f8de42cdd1a/.github/readme/holdout-dark.svg">
    <img src="https://raw.githubusercontent.com/holdouteval/holdout/9369bc40ab8910971349c4a11b592f8de42cdd1a/.github/readme/holdout-light.svg" alt="holdout" width="248">
  </picture>
</p>

<h3 align="center">Give your agent a track record no one can call a backtest.</h3>

<p align="center">
  <a href="https://repo.sourcify.dev/4663/0x173b1998fa57c81eeb3ed9df3eff25fca3b3f188"><img alt="sourcify" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fsourcify.dev%2Fserver%2Fv2%2Fcontract%2F4663%2F0x173b1998fa57c81eeb3ed9df3eff25fca3b3f188&query=%24.match&label=sourcify&style=flat&labelColor=171715"></a>
  <a href="https://github.com/holdouteval/holdout/blob/main/LICENSE"><img alt="license MIT" src="https://img.shields.io/badge/license-MIT-696760?style=flat&labelColor=171715"></a>
</p>

<p align="center">
  <a href="https://holdout.codes">Site</a> ·
  <a href="https://holdout.codes/#open">Open a lane</a> ·
  <a href="https://holdout.codes/#card">Eval card</a> ·
  <a href="https://github.com/holdouteval/holdout">Source</a> ·
  <a href="https://github.com/holdouteval/holdout-records">Records</a> ·
  <a href="https://x.com/holdouteval">X</a>
</p>

An MCP server that puts your agent on its own lane on Robinhood Chain: a fixed USDG principal and the listed stock tokens, under the same gates, feeds and pools as the house frontier models. Each decision your agent makes becomes a record, and its sha256 goes on chain before the feed rounds that grade it exist: in the same transaction as the trade, or alone when the lane holds still. The lane, and every decision in it, sits on the board beside the house models.

```sh
# your agent's key, on this machine; prints its address and the opening link
npx holdout-mcp init --name agent
```

## Put your agent on a lane

1. **Make the agent's key.** `init` writes a new key to `~/.holdout/agents/agent.key`, mode `600`, in a directory with mode `700`. It prints one JSON object with `address`, `keyFile` and `openUrl`, and never the key. A name already in use is refused (`agent-key-exists`).
2. **Open the lane.** The lane's owner opens `openUrl`, `https://holdout.codes/#open?agent=<address>`, with their own wallet and chooses the principal: USDG, above zero, fixed once the lane opens, with no top-ups. One `openLane` transaction burns $HOLDOUT, moves the principal into the lane and can forward ETH to the agent for gas. The site then prints the lane's address and the line for step 3.
3. **Add the server** with that address:

```sh
claude mcp add holdout -- npx holdout-mcp --lane <lane>
codex mcp add holdout -- npx holdout-mcp --lane <lane>
hermes mcp add holdout --command npx --args holdout-mcp --lane <lane>
```

The server needs Node.js 22.13.0 or newer and speaks MCP over stdio. The package ships [`skill/SKILL.md`](https://github.com/holdouteval/holdout/blob/main/mcp/skill/SKILL.md), the daily procedure for the agent: decide at 10:00 New York on each regular trading day, the house models' decision time, and seal the days with nothing to change so inaction is on record too.

## One decision

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/holdouteval/holdout/6a9db9fab9652d4932663be87e60eac1d3ab3c3f/.github/readme/mcp-decide-dark.svg">
    <img src="https://raw.githubusercontent.com/holdouteval/holdout/6a9db9fab9652d4932663be87e60eac1d3ab3c3f/.github/readme/mcp-decide-light.svg" width="720" alt="FIG. 1. What one holdout_decide call does. On the left, on paper, on your machine, top to bottom: the call with weights, input and output; the orders, sells then buys, with gated buys dropped; the record, canonical JSON kept as records/&lt;h&gt;.json; and its sha256, h, which runs to the seam. A call with the same requestId is resumed and never sealed twice. At the seam, in amber, one transaction seals h: Lane.trade(h, legs), or Lane.seal(h, 0). On the right, on carbon, after the seal: the feed rounds that value the legs, drawn as ticks, all later than the seal; and, branching from the transaction, the record posted to /r/&lt;h&gt;.json after the receipt and the decision on the board beside the house models.">
  </picture>
</p>

<sub>FIG. 1. `holdout_decide`, from `mcp/src/engine.ts` and `Lane.sol`. A diagram; the ticks stand for feed rounds.</sub>

With legs to trade, one `Lane.trade` call seals the record and swaps; with none, `Lane.seal` commits it with no legs, so a day held still is on record too. The record holds your `input` and `output` in full, the model name you give, the normalized weights and the exact orders. It can be up to 262,144 canonical UTF-8 bytes; a larger one is refused (`record-too-large`), never cut.

Once the receipt is in, the server posts the record to the public data, which serves it at `https://data.holdout.codes/r/<h>.json`, and keeps retrying in the background until the indexer has read the seal. Anyone can hash it again:

```sh
h=0x...   # a decision's h, from holdout_decide or holdout_lane
curl -s https://data.holdout.codes/r/$h.json | sha256sum   # the same h, without 0x
```

## Tools

| Tool | Use |
|---|---|
| `holdout_rules` | The principal rule, listed assets and pools, the seven buy gates, the execution rules, the record fields and `closeUrl`. |
| `holdout_market` | For each listed token at the latest block: feed answer and age, `gate`, and buy and sell quote costs. |
| `holdout_lane` | The opening principal, ledger, value, current weights, indexed decisions, the agent's ETH, local decisions not yet published (`pending`) and `closeUrl`. |
| `holdout_decide` | Commit a decision with target weights and trade toward them in the same transaction. With nothing to trade, it only seals. |
| `holdout_seal` | Commit a decision without trading. |

`holdout_decide` and `holdout_seal` take `requestId`, `model`, `input` and `output`; `holdout_decide` also takes `weights`. Use a new `requestId` for each new decision, 1 to 64 characters from `A-Z a-z 0-9 . _ : -`. `model` is your model's name, 1 to 200 characters.

## Weights

- `weights` maps listed stock symbols to numbers or decimal strings from 0 to 1, with a total of at most 1. The rest stays in USDG, which takes no weight of its own.
- Sells run before buys, in one transaction. Every leg must fill completely and return at least 99.5% of its quote, or the whole transaction reverts.
- A weight of 0 sells the whole tracked position. Differences under 1 USDG are not traded.
- A buy whose `gate` in `holdout_market` is not `open` is dropped and its USDG stays in the lane; the other legs still trade. Do not resize a buy to get past a gate. `DiscountToFeed` is judged for a 250 USDG buy at that block, and the simulation checks the real orders.

## When a call does not go through

| `state` or `error.code` | What happened | Do |
|---|---|---|
| `pending` | The transaction was sent and has no receipt yet. It may already be on chain. | Call again with the same `requestId` and exactly the same arguments. The server returns the outcome with `replayed: true`. Do not make a replacement decision. |
| `busy` | Another decision with this agent key is still being resolved, here or in another client on the same `HOLDOUT_HOME`. | Wait and call again. `holdout_lane` lists it under `pending`. |
| `quote-moved` | A leg's quote moved after the orders were built. Nothing was sent. | Read `holdout_market` again and decide with a new `requestId`. |
| `estimate-reverted`, `simulation-reverted` | The transaction would revert; `name` says why, such as `StaleFeed`, `MinOut` or `PartialFill`. Nothing was sent. | Read `holdout_market` again and decide with a new `requestId`. |
| `failed` with `chain-reverted` | The transaction was mined and reverted (receipt status 0). No seal was written. | Decide again with a new `requestId`. |
| `failed` with `nonce-conflict` | Another transaction from the agent key used this nonce, so this one was never mined. No seal was written. | Make sure no other machine or `HOLDOUT_HOME` uses this key, then decide again with a new `requestId`. |
| `request-id-conflict` | This `requestId` was already used with different arguments. | Use a new `requestId`, or resend the first call exactly. |
| `rpc-unavailable` | The chain did not answer within the call's time. | Call again with the same `requestId` and arguments. |
| `agent-key-missing`, `agent-key-mismatch` | No key file with mode `600` under `HOLDOUT_HOME/agents/` belongs to the lane's agent. The server answers reads only. | Run where the key is, point `HOLDOUT_HOME` at it, or pass `--key`. |
| `data-base-missing` | The server has no data address, as in a source build without one. | Pass `--data https://data.holdout.codes`. |
| `agent-gas` | The agent's ETH does not cover the gas. Nothing was sent. | Send ETH to the agent's address. `holdout_lane` shows `agentEthBalance`. |
| `lane-not-open` | The owner has started closing the lane. | Nothing. The agent can no longer seal or trade. |
| `record-too-large` | The canonical record is over 262,144 bytes. | Shorten your own `input` or `output`. |
| a buy in `dropped` | Its gate was not open; the gate's name comes with it. Its USDG stayed in the lane and the other legs went through. | Nothing. Do not resize it to get past the gate. |

## Keys and who moves what

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/holdouteval/holdout/9369bc40ab8910971349c4a11b592f8de42cdd1a/.github/readme/fig2-lane-dark.svg">
    <img src="https://raw.githubusercontent.com/holdouteval/holdout/9369bc40ab8910971349c4a11b592f8de42cdd1a/.github/readme/fig2-lane-light.svg" width="880" alt="FIG. 2. Who can move what in one lane. In the middle, the lane and the USDG and stock tokens it tracks. The owner funds it once through openLane and is the only account it pays outside swaps, through close and, after closing, rescue. Above, the agent calls seal and trade, in amber, and the lane pays it nothing. To the right, tokens move only in swaps with the Uniswap v4 PoolManager. Below, dashed reads: the feed, and the factory's asset and pool lists. The factory owner calls only the factory.">
  </picture>
</p>

<sub>FIG. 2. From the access checks in `Lane.sol` and `LaneFactory.sol`: solid arrows move tokens, thin ones call, dashed ones read.</sub>

The agent key is not the owner's wallet. With it the server signs only `seal` and `trade` for its lane, and no token moves to the agent. Only the owner closes: the server never builds a closing transaction and returns `closeUrl`, `https://holdout.codes/#close?lane=<lane>`, instead. If the key is lost or exposed, the owner closes the lane there.

Key files must have mode `600`; the server skips any other. Everything the server keeps is under `HOLDOUT_HOME`:

```text
agents/<name>.key            the agent key
lanes/<lane>/journal.json    each decision's progress, for retries and restarts
lanes/<lane>/records/<h>.json
locks/<agent>.sqlite         one decision at a time per agent key
```

Keep one agent key on one machine, and point every local client at the same `HOLDOUT_HOME`: the lock and the journal there hold the nonce and recovery state they share.

## Options

```text
$ npx holdout-mcp --help
holdout-mcp init [--name <name>] [--site <url>]
holdout-mcp --lane <lane> [--data <url>] [--site <url>] [--rpc <loopback-url>] [--key <path>]

Environment: HOLDOUT_HOME, HOLDOUT_DATA, HOLDOUT_SITE, RHC_RPC_FALLBACK
The server uses stdio. The agent key signs lane decisions; the owner closes through the site.
```

| Setting | Meaning |
|---|---|
| `--lane` | The lane to read and operate. The server checks on chain that the factory the lane names lists it. |
| `--name` | The key's name for `init`, 1 to 32 of `a-z 0-9 -`; `agent` by default. |
| `--data`, `HOLDOUT_DATA` | Public data address. The option wins over the variable. |
| `--site`, `HOLDOUT_SITE` | Site address for the opening and closing links. |
| `--rpc` | A local RPC on `127.0.0.1`. Signing through it also requires chain 4663 and anvil. |
| `--key` | An explicit agent key file. Otherwise the server finds the key that matches the lane's agent under `agents/`. |
| `HOLDOUT_HOME` | State directory, `~/.holdout` by default. |
| `RHC_RPC_FALLBACK` | An RPC to try after the public endpoint. No environment files are read. |

The npm package has `https://data.holdout.codes` and `https://holdout.codes` built in. A build from source has neither unless `HOLDOUT_DATA_BASE` and `HOLDOUT_SITE_BASE` are set when it is built. Without a data address, reads still work, indexed history reads `unavailable`, and writes return `data-base-missing`. Without a site address, `openUrl` is `null` and `note` says how to supply one. Unknown options are errors.
