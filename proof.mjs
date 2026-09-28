// Pre-sign refusal proof for twzrd-x402-gate@0.9.16.
//
// A loopback merchant serves a real x402 v2 402 (mainnet USDC, $0.001). The
// buyer is the official stack: @x402/fetch -> @x402/core x402Client ->
// @x402/svm ExactSvmScheme, with a signer that only COUNTS calls (no keys, no
// broadcast, no funds). createGuardedX402Fetch sits in front and asks LIVE TWZRD
// intel about the 402's payTo before the wallet can sign.
//
//   untrusted payTo (wash-flagged)  -> refused, signerInvocations = 0
//   control payTo  (intel: allow)   -> signed once,  signerInvocations = 1
//
// Run: npm install && npm run proof
// Env: TWZRD_INTEGRATION (your integration id, sent as x-twzrd-integration),
//      UNTRUSTED_PAYTO / CONTROL_PAYTO (override the two sellers).
import http from "node:http";
import { randomUUID } from "node:crypto";

import { getMintEncoder } from "@solana-program/token-2022";
import { getAddressDecoder, getBase64Decoder, none } from "@solana/kit";
import { x402Client } from "@x402/core/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { createGuardedX402Fetch } from "twzrd-x402-gate";

const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"; // Solana mainnet
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // mainnet USDC
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const AMOUNT = "1000"; // 0.001 USDC
const UNTRUSTED = process.env.UNTRUSTED_PAYTO || "X4o2D8op42a2jcNJJVZcDq3eYivh1oR9XiezPWCXosZ";
const CONTROL = process.env.CONTROL_PAYTO || "5yASLjtNssGXDv6bR9e71WXKxRymDiUzbgkGPqkQNgRn";
const INTEGRATION = process.env.TWZRD_INTEGRATION || "guarded-fetch-proof";
const BUYER = getAddressDecoder().decode(new Uint8Array(32).fill(1)); // no key exists for this address

const b64 = (v) => Buffer.from(JSON.stringify(v), "utf8").toString("base64");
const MINT_ACCOUNT_B64 = getBase64Decoder().decode(
  getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 6, isInitialized: true, freezeAuthority: none(), extensions: none() }),
);

/** Loopback merchant (402, then 200 on PAYMENT-SIGNATURE) + the Solana RPC read the scheme needs. */
async function startMerchant(payTo) {
  let paid = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const json = (status, body, headers = {}) => res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
      if (req.method === "POST" && req.url === "/rpc") {
        const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const value = rpc.method === "getAccountInfo"
          ? { data: [MINT_ACCOUNT_B64, "base64"], executable: false, lamports: 1_000_000, owner: TOKEN_PROGRAM, rentEpoch: 0, space: 82 }
          : null;
        return json(200, { jsonrpc: "2.0", id: rpc.id, result: value && { context: { slot: 1 }, value } });
      }
      if (req.url === "/paid") {
        if (!req.headers["payment-signature"]) {
          const required = {
            x402Version: 2,
            resource: { url: `${origin}/paid` },
            accepts: [{
              scheme: "exact", network: NETWORK, asset: USDC, amount: AMOUNT, payTo, maxTimeoutSeconds: 60,
              extra: { feePayer: "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR", recentBlockhash: "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx", lastValidBlockHeight: "100" },
            }],
          };
          return json(402, required, { "PAYMENT-REQUIRED": b64(required) });
        }
        paid += 1;
        return json(200, { ok: true }, { "PAYMENT-RESPONSE": b64({ success: true, transaction: "not-broadcast", network: NETWORK }) });
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, paid: () => paid, close: () => new Promise((r) => server.close(r)) };
}

async function run(label, payTo) {
  const merchant = await startMerchant(payTo);
  let signerInvocations = 0;
  const countingSigner = {
    address: BUYER,
    async signTransactions(txs) {
      signerInvocations += 1;
      return txs.map(() => ({ [BUYER]: new Uint8Array(64) }));
    },
  };
  const client = new x402Client(); // @x402/core default spend controls stay ON
  client.register(NETWORK, new ExactSvmScheme(countingSigner, { rpcUrl: `${merchant.origin}/rpc` }));

  let intelCard = null;
  const decisions = [];
  const observeIntel = async (url, init) => {
    const res = await fetch(url, init);
    if (String(url).includes("/v1/intel/preflight")) {
      try { intelCard = (await res.clone().json()).readiness_card ?? null; } catch { /* keep going */ }
    }
    return res;
  };
  const payingFetch = createGuardedX402Fetch({
    client,
    maxPricePerCall: "0.01",
    twzrd: {
      fetch: observeIntel,
      attribution: { integration: INTEGRATION, runId: randomUUID() },
      onDecision: (d) => decisions.push({ approved: d.approved, reason: d.reason, verdict: d.verdict }),
    },
  });

  let status = null;
  let error = null;
  try {
    status = (await payingFetch(`${merchant.origin}/paid`)).status;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const merchantPaid = merchant.paid();
  await merchant.close();
  return {
    scenario: label,
    payTo,
    intel: intelCard && {
      decision: intelCard.decision,
      can_spend: intelCard.can_spend,
      trust_score: intelCard.trust_score,
      wash_flagged: intelCard.wash_flagged ?? null,
      reason_codes: intelCard.reason_codes,
    },
    gate: decisions[0] ?? null,
    refusal: error,
    signerInvocations,
    merchantPaid,
    httpStatus: status,
  };
}

const untrusted = await run("untrusted_payTo", UNTRUSTED);
const control = await run("positive_control", CONTROL);
const ok = untrusted.signerInvocations === 0 && untrusted.merchantPaid === 0 && control.signerInvocations === 1 && control.httpStatus === 200;
console.log(JSON.stringify({ package: "twzrd-x402-gate@0.9.16", integration: INTEGRATION, untrusted, control, ok }, null, 2));
if (!ok) {
  console.error("PROOF FAILED: expected untrusted signerInvocations = 0 and control signerInvocations = 1");
  process.exit(1);
}
console.log(`\nPROOF OK: untrusted payTo refused before signing (signerInvocations = 0); control signed once.`);
