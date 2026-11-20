# holdout-mcp

Give your agent one holdout lane on Robinhood Chain. Each decision it makes goes on chain as the sha256 of its record, in the same transaction that trades it, or on its own when it holds.

A lane starts with the USDG principal its owner chooses, above zero and fixed after opening. The agent trades listed stock tokens; only the owner closes the lane. Opening a lane burns $HOLDOUT. Node 22.13.0 or newer.

Create an agent key before the owner opens the lane:

```sh
npx holdout-mcp init --name agent
```

`init` prints one JSON object with `address`, `keyFile` and `openUrl`, and never the key. `openUrl` is the site's opening page for that agent, `<site>/#open?agent=<address>`: there the owner chooses the principal and opens the lane. Then add the server with the lane's address:

```sh
claude mcp add holdout -- npx holdout-mcp --lane <lane>
codex mcp add holdout -- npx holdout-mcp --lane <lane>
hermes mcp add holdout --command npx --args holdout-mcp --lane <lane>
```

## Tools

| Tool | Use |
|---|---|
| `holdout_rules` | Read the principal rule, listings, buy gates, execution rules and record fields. |
| `holdout_market` | Read current feed values, ages, gates and quote costs. |
| `holdout_lane` | Read the lane's opening principal, inventory, value, weights, indexed decisions and unfinished local records. |
| `holdout_decide` | Commit complete inputs and output with target stock weights and trade toward them in the same `trade` call. With nothing left to trade, it only seals. |
| `holdout_seal` | Commit a decision without trading. |

`weights` maps listed stock symbols to numbers or decimal strings from 0 to 1, with a total no greater than 1. The remainder stays in USDG. A zero weight sells the full tracked quantity. Differences below 1 USDG are not traded. Sells run before buys, in one transaction; every leg must fill completely and receive at least 99.5% of its quote.

Read `holdout_market` before deciding. A gate other than `open` prevents a buy; `DiscountToFeed` describes a 250 USDG buy at that block. Gated buys are removed and their funds stay in USDG. Do not change order size to work around a gate.

Use a new `requestId` for each new decision. If a response is lost, retry with the same `requestId` and exactly the same inputs. The server resumes or returns the recorded result with `replayed: true`, so the same decision is not sealed twice. Reusing an identifier for different content returns `request-id-conflict`.

The record contains the full `input` and `output`, normalized weights and the exact orders. Records are limited to 262,144 canonical UTF-8 bytes; the server rejects oversized content without truncating it. Successful records are published after their receipts. Publication can wait for the indexer's stable boundary; the journal retries it in the background.

`pending` means a transaction is still being resolved. Retry the same request rather than making a replacement decision. `QuoteMoved`, estimation reverts and simulation failures before sending leave no transaction; a status-zero receipt leaves no new seal. The returned error and local journal distinguish those outcomes.

The package includes `skill/SKILL.md`, the daily decision procedure for an agent.

## Keys and storage

The agent key is separate from the owner's wallet. With it the server signs only `seal` and `trade` for its lane. Key files must have mode `600`; the server ignores any other. `init` writes them that way, in a directory with mode `700`. If the key is lost or compromised, the owner closes the lane through the site. The server returns `<site>/#close?lane=<lane>` and does not create closing transactions.

Inside `HOLDOUT_HOME`:

```text
agents/<name>.key
lanes/<lane>/journal.json
lanes/<lane>/records/<h>.json
locks/<agent>.sqlite
```

Keep one agent key on one machine, with all local clients using the same `HOLDOUT_HOME`. The agent lock and journal share the nonce and recovery state across those clients.

## Options

```text
holdout-mcp init [--name <name>] [--site <url>]
holdout-mcp --lane <lane> [--data <url>] [--site <url>] [--rpc <loopback-url>] [--key <path>]
```

| Setting | Meaning |
|---|---|
| `--lane` | Lane to read and operate. The server checks on chain that the factory the lane names lists it. |
| `--data`, `HOLDOUT_DATA` | Public data address. An explicit option takes precedence. |
| `--site`, `HOLDOUT_SITE` | Site address used for opening and closing links. |
| `--rpc` | Local RPC override with host `127.0.0.1`. Local signing also requires chain 4663 and anvil. |
| `--key` | Explicit agent key file. Otherwise the server finds the matching key under `agents/`. |
| `HOLDOUT_HOME` | State directory; defaults to `~/.holdout`. |
| `RHC_RPC_FALLBACK` | Optional RPC fallback after the public endpoint. No environment files are read. |

The npm package has the holdout data and site addresses built in. A build from source has neither unless `HOLDOUT_DATA_BASE` and `HOLDOUT_SITE_BASE` are set when it is built. Without a data address, reads still work and indexed history is `unavailable`; writes return `data-base-missing`. Without a site address, `openUrl` is `null` and `note` explains how to supply one. Without a matching agent key, the server is read only and writes return `agent-key-missing`. Unknown options are errors.
