#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { createPublicClient, formatUnits, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

for (const file of [".env.local", ".env", ".dev.vars"]) loadEnvFile(file);

const args = new Set(process.argv.slice(2));
const live = args.has("--live");
const origin = process.env.X402_ORIGIN ?? "https://agenttoll.dev";
const endpoint = process.env.X402_SETTLE_URL ?? new URL("/paid/polymarket/trending", origin).toString();
const network = process.env.X402_NETWORK ?? "eip155:8453";
const body = process.env.X402_SETTLE_BODY ? JSON.parse(process.env.X402_SETTLE_BODY) : { limit: 5 };
const buyerKey = process.env.X402_BUYER_PRIVATE_KEY ?? process.env.BUYER_PRIVATE_KEY;

function decodeHeaderMaybe(value) {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    try {
      const decoded = Buffer.from(value, "base64").toString("utf8");
      return JSON.parse(decoded);
    } catch {
      return null;
    }
  }
}

const USDC_BY_NETWORK = {
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};
const CHAINS_BY_NETWORK = {
  "eip155:8453": base,
};
const erc20BalanceAbi = [{
  type: "function",
  name: "balanceOf",
  stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ type: "uint256" }],
}];

function usage() {
  console.log(`Usage:
  npm run settle:polymarket -- --live

Dry-run is default. It fetches the 402 challenge and exits before signing.

Required for --live:
  X402_BUYER_PRIVATE_KEY=0x...        # or BUYER_PRIVATE_KEY

Optional:
  X402_ORIGIN=https://agenttoll.dev
  X402_NETWORK=eip155:8453
  X402_SETTLE_URL=https://agenttoll.dev/paid/polymarket/trending
  X402_SETTLE_BODY='{"limit":5}'

Safety:
  - This script never prints the private key.
  - Mainnet live payment requires --live plus an explicit buyer key.
  - Use tiny payloads first. The route price is advertised in the 402 challenge.
`);
}

if (args.has("--help") || args.has("-h")) {
  usage();
  process.exit(0);
}

console.log(`settle target: ${endpoint}`);
console.log(`network: ${network}`);
console.log(`mode: ${live ? "LIVE payment" : "dry-run challenge only"}`);

const initial = await fetch(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify(body),
});
const challenge = initial.headers.get("payment-required") ?? initial.headers.get("PAYMENT-REQUIRED");
console.log(`challenge status: ${initial.status}`);
console.log(`payment-required header: ${challenge ? "present" : "missing"}`);
if (initial.status !== 402 || !challenge) {
  const text = await initial.text().catch(() => "");
  console.error(text.slice(0, 1000));
  throw new Error("Expected unpaid request to return HTTP 402 with PAYMENT-REQUIRED");
}

const challengePayload = decodeHeaderMaybe(challenge);
const accepts = challengePayload?.accepts ?? challengePayload?.paymentRequirements?.accepts ?? [];
const firstAccept = Array.isArray(accepts) ? accepts[0] : undefined;
if (firstAccept) {
  console.log(`challenge price atomic: ${firstAccept.amount ?? "?"}`);
  console.log(`challenge network: ${firstAccept.network ?? "?"}`);
  console.log(`challenge payTo: ${firstAccept.payTo ?? "?"}`);
}

if (!live) {
  console.log("dry-run complete. Re-run with --live after funding the buyer wallet and confirming the price.");
  process.exit(0);
}

if (!buyerKey) {
  throw new Error("Missing X402_BUYER_PRIVATE_KEY or BUYER_PRIVATE_KEY. Refusing to sign.");
}
if (!/^0x[0-9a-fA-F]{64}$/.test(buyerKey)) {
  throw new Error("Buyer private key must be a 0x-prefixed 32-byte hex string.");
}

const account = privateKeyToAccount(buyerKey);
console.log(`buyer address: ${account.address}`);

const expectedAmount = firstAccept?.amount ? BigInt(firstAccept.amount) : undefined;
const expectedAsset = firstAccept?.asset;
const balanceAsset = USDC_BY_NETWORK[network];
const chain = CHAINS_BY_NETWORK[network];
if (chain && balanceAsset && expectedAsset?.toLowerCase() === balanceAsset.toLowerCase()) {
  const publicClient = createPublicClient({ chain, transport: http() });
  const [ethBalance, usdcBalance] = await Promise.all([
    publicClient.getBalance({ address: account.address }),
    publicClient.readContract({ address: balanceAsset, abi: erc20BalanceAbi, functionName: "balanceOf", args: [account.address] }),
  ]);
  console.log(`buyer Base ETH: ${formatUnits(ethBalance, 18)}`);
  console.log(`buyer Base USDC: ${formatUnits(usdcBalance, 6)}`);
  if (expectedAmount !== undefined && usdcBalance < expectedAmount) {
    throw new Error(`Buyer has ${formatUnits(usdcBalance, 6)} Base USDC but route requires ${formatUnits(expectedAmount, 6)} USDC. Fund ${account.address} on Base mainnet, then rerun --live.`);
  }
}

const client = new x402Client();
registerExactEvmScheme(client, {
  signer: account,
  networks: [network],
});
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

const paid = await fetchWithPayment(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify(body),
});
const paymentResponse = paid.headers.get("payment-response") ?? paid.headers.get("PAYMENT-RESPONSE");
console.log(`paid status: ${paid.status}`);
if (paymentResponse) {
  const decoded = decodePaymentResponseHeader(paymentResponse);
  console.log("payment response:", JSON.stringify({ success: decoded.success, transaction: decoded.transaction, network: decoded.network, amount: decoded.amount }, null, 2));
}
const text = await paid.text();
console.log(text.slice(0, 4000));
if (!paid.ok) process.exit(1);
