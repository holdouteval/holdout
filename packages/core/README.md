# @holdout/core

Shared chain constants, contract ABIs, read-only RPC, canonical decision records, event decoding, leg hashes and New York trading sessions. Requires Node.js 20 or later. The only runtime dependency is viem, used for ABI encoding, decoding and keccak.

From the workspace root:

```sh
npm ci
npm run build -w @holdout/core
npm run test -w @holdout/core
npm run check:abi -w @holdout/core
```

```ts
import { RpcClient, canonicalize, sha256Hex } from "@holdout/core";

const rpc = new RpcClient();
const block = await rpc.request<string>("eth_blockNumber", []);
const bytes = canonicalize({ example: "decimal quantities stay strings", quantity: "1000000" });
const hash = sha256Hex(bytes);
```

`RpcClient` forces IPv4, checks chain ID 4663 and tries the public endpoint before `RHC_RPC_FALLBACK`. The fallback comes from the environment or the workspace root `.env`. An explicit `override` accepts only `127.0.0.1` or `localhost`. Requests share a process-wide cadence: 250 ms for state reads and 500 ms for `eth_call` and `eth_simulateV1`. `getLogs` splits block ranges and retries result-limit responses. Error logging replaces URLs and local home information; log the provided endpoint labels instead of endpoint values.

The RPC method allowlist contains reads only. This package does not sign or send transactions. JSON quantities that can exceed safe integer precision use decimal strings. Canonical JSON accepts safe integers, rejects negative zero and invalid Unicode, and preserves exact UTF-8 hash preimages. `parseCanonical` rejects alternative byte spellings even when ordinary JSON parsing would produce the same value.

`validateRecord` checks the decision envelope. `inspectHouseRecord` separately reads optional weights and reason; malformed house fields do not invalidate an otherwise valid envelope. `legsHash` uses the standard ABI encoding of one tuple-array argument, including its offset word.

The generated factory and lane ABIs are checked against existing contract build artifacts by `scripts/sync-abi.mjs --check`. To refresh them after an approved contract artifact change, run `node packages/core/scripts/sync-abi.mjs` from the workspace root. The script does not build contracts. Calendar data covers NYSE sessions in 2026 and 2027; requests outside those years fail.
