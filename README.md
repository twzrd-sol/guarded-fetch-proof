# guarded-fetch-proof

A 60-second, zero-spend proof that [`twzrd-x402-gate`](https://www.npmjs.com/package/twzrd-x402-gate) refuses an untrusted x402 `payTo` **before your wallet signs**.

```bash
npm install
npm run proof
```

Expected, last line:

```
PROOF OK: untrusted payTo refused before signing (signerInvocations = 0); control signed once.
```

## What it does

A loopback merchant serves a real x402 v2 `402 Payment Required` (Solana mainnet USDC, $0.001). The buyer is the official x402 stack — `@x402/fetch` → `@x402/core` `x402Client` → `@x402/svm` `ExactSvmScheme` — with a signer that only **counts** calls. No private key exists, nothing is broadcast, no funds move.

`createGuardedX402Fetch` wraps that client. For each 402 it asks live TWZRD intel (`https://intel.twzrd.xyz`) about the challenge's `payTo` and refuses before the signer runs if the counterparty is blocked.

| Scenario | `payTo` | Intel | Result |
|---|---|---|---|
| untrusted | `X4o2D8op…` (wash-flagged settlement history) | `block` | refused, **`signerInvocations = 0`** |
| positive control | `5yASLjtN…` (clean inbound history) | `allow` | signed once, `signerInvocations = 1` |

The control matters: it shows the same signer does sign when TWZRD approves, so the zero is a refusal, not a harness that could never sign.

The run prints both intel cards, the gate decision and refusal reason, and exits non-zero if either half of the proof fails.

## Use it in your agent

```js
import { x402Client } from "@x402/core/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { createGuardedX402Fetch } from "twzrd-x402-gate";

const client = new x402Client();
client.register("solana:*", new ExactSvmScheme(yourSigner));

const payingFetch = createGuardedX402Fetch({
  client,
  maxPricePerCall: "0.05",   // local hard cap, USDC
  hourlyBudgetCap: "2.00",   // rolling 60-minute budget, USDC
  twzrd: { attribution: { integration: "your-agent-name", runId: crypto.randomUUID() } },
});

const res = await payingFetch("https://paid-api.example/resource");
```

Install the peers yourself — they are optional peers npm will not add for you:
`npm install twzrd-x402-gate@0.11.2 @x402/core @x402/fetch @x402/svm @solana/kit`.

Notes:
- `@x402/core` ≥ 2.23 applies its own default spend controls (recognized assets, $1 per payment) **before** TWZRD runs; a payment over that is refused by core, not TWZRD.
- Set `TWZRD_INTEGRATION` to name your integration (sent as `x-twzrd-integration` with a per-run id) so a refusal in your runner can be attributed. Override the two sellers with `UNTRUSTED_PAYTO` / `CONTROL_PAYTO`; intel data is live, so a seller's verdict can change over time.

## Versions

Pinned: `twzrd-x402-gate` 0.11.2, `@x402/core|fetch|svm` 2.27.0, `@solana/kit` 5.5.1, `@solana-program/token-2022` 0.6.1. Node ≥ 20.

MIT license.
