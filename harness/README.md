# Lane harness

The harness takes one decision per lane and New York trading session. It snapshots a fixed block, streams a provider response into a durable journal, commits the canonical decision bytes, and executes the committed orders. Claude lanes execute automatically. GPT lanes seal first and wait for an operator to send or skip.

Node 26 is required for the harness and rehearsal tools. The shared core package supports Node 20 and later.

```sh
npm ci
npm run build
npm test
npm run harness -- --config harness/config/mainnet.example.json public-config --out .runtime/harness-public.json
npm run harness -- --config harness/config/mainnet.example.json run --paper --at latest
npm run harness -- --config harness/config/mainnet.example.json daemon
```

Copy an example configuration and supply the local indexer's public and management listeners. Live snapshots read each lane's chosen opening principal from the lane contract and use it for the prompt and return since opening. The default mode is paper. With a null factory, each model starts with the virtual principal from the listing configuration, 1,000 USDG in the example; successive paper sessions preserve that ledger and the previous three decisions. Paper mode reads market data and calls the configured models, then writes records and labeled paper fills locally.

The provider keys are `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`. Environment values take precedence over the repository environment file. Models use high effort, streaming, a 64,000-token output limit, and no provider fallback. A shared SQLite cost ledger reserves the maximum request cost before starting each attempt. Send mode requires a positive decimal `budget.monthlyUsd`; paper mode defaults to `"30"`. Reservations count toward the UTC calendar month in which they were created. The daemon stops when its budget is exhausted and needs to be restarted after the new month begins. An explicit `--budget <file>` also keeps the shared $30 lifetime ceiling used by rehearsals across processes or configurations.

Paper mode and authorized nonlocal sends explicitly use the official provider endpoints. They ignore `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` and issue one warning. Guarded local sends may use these settings only with HTTP, the exact host `127.0.0.1`, and an explicit port.

In send mode, startup and every signature validate the chain and authorization boundary. A local fork must use the exact IPv4 host `127.0.0.1`, chain 4663, and an Anvil client. Agent key files must have mode 0600. The sender estimates gas before signing, stores the signed transaction durably, and reuses those bytes during recovery.

```sh
npm run harness -- --config .runtime/fork.json run --session 2026-11-16
npm run harness -- --config .runtime/fork.json review
npm run harness -- --config .runtime/fork.json review send 0xHASH --yes
npm run harness -- --config .runtime/fork.json review skip 0xHASH
npm run harness -- --config .runtime/fork.json resume
```

Review sends use the sealed legs and a fresh execution quote. Quotes, estimates, or mined reverts produce a separate execution record; they never rewrite the decision. Review windows expire automatically. Records are posted to the indexer's management listener after execution or skipping, then verified through its public listener.

Session journals live under `sessions/<date>/<lane>.json`; immutable canonical records live under `records/<hash>.json`. A kernel SQLite lock protects each lane across daemon, run, and review processes. Restarting resumes unfinished work before scheduling new decisions. The daemon checks unfinished sessions every minute, including while a model request is active.

The two complete rehearsal commands are `npm run gate:paper` and `npm run gate:harness-fork`. Live calls share one durable budget. The first uses mainnet reads and five paper sessions; `-- --sessions 1` selects one session. The second uses a guarded local fork, temporary development keys, and four sessions covering execution, review, failure, expiry, and restart recovery. Selected local scenarios use a scripted SSE provider with fake credentials; each result records its decision source and request hash. Scripted usage is reported separately from live costs. Final checks compare nonce increases from the starting values, advance chain finality, and require every journal to finish.
