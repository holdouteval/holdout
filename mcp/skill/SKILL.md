---
name: holdout
description: Read a holdout stock-token lane, make its scheduled portfolio decision, and commit the complete inputs and answer through the holdout MCP tools.
---

# Decide in a lane

A lane starts with the USDG principal its opener chooses. The amount must be greater than zero and stays fixed after opening; there are no later deposits. Its agent key can trade; its owner can close. Assets and buy gates are the same as the house lanes. Opening a lane burns $HOLDOUT. Keep the owner's wallet separate from the agent key.

Call `holdout_rules` once when starting with a lane. Before every decision, call `holdout_market` and `holdout_lane` for current gates, costs, inventory and value.

| Tool | When to use it |
|---|---|
| `holdout_rules` | Learn the lane's rules and listed assets. |
| `holdout_market` | Check current feed values, ages, quote costs and buy gates. |
| `holdout_lane` | Check the opening principal, holdings, value, current weights, prior decisions and agent ETH. |
| `holdout_decide` | Commit target stock weights with the complete inputs and answer. |
| `holdout_seal` | Commit the day's decision when no trade is needed. |

Decide once on each New York regular trading day at 10:00 New York time, 30 minutes after the open. This is the house lanes' decision time. Choose target weights and call `holdout_decide`; call `holdout_seal` on a day with nothing to change. Seal a decision on days without trades too, so the record includes inaction.

Give each new decision a new `requestId`, such as `2026-11-30:1`. If the response is lost, retry with the same identifier and exactly the same arguments. The journal uses this identifier to resume or return that decision instead of sealing another one. Keep one agent key on one machine and share its `HOLDOUT_HOME` across clients on that machine.

Put the material you used, unchanged, in `input`. Put your whole answer in `output` and identify your model in `model`. The record is public after the transaction and cannot be revised. The server does not truncate the text; shorten your own input or output if it returns `record-too-large`.

Weights are fractions of the lane's value, from 0 to 1, with a total at most 1. The remainder stays in USDG. Use listed stock symbols; do not give USDG a weight. A zero weight sells the entire tracked quantity. Differences below 1 USDG are left alone to avoid trading tiny adjustments.

Sells execute before buys in one transaction. Each leg must fill completely and receive at least 99.5% of its quote, or the whole transaction reverts. Check the returned `legs`, `dropped`, `simulation` and `error`.

Read each asset's `gate` before deciding. If it is not `open`, that asset cannot be bought now. A gated buy is removed and its funds remain in USDG. Do not resize a buy to get around the gate. `DiscountToFeed` describes a 250 USDG buy at that block; simulation checks the actual orders as well.

`QuoteMoved`, an estimation revert or a simulation failure before sending means nothing was sent. A status-zero transaction means no new decision was sealed. You may make a new decision from new information after those outcomes. If the result is `pending` or the connection is lost, keep the same request identifier while resolving it; an attempted transaction may already be on chain.

The agent needs ETH for transaction gas. The owner closes through `closeUrl`; the agent cannot close the lane or withdraw its funds. If the agent key is lost or compromised, the owner closes the lane.
