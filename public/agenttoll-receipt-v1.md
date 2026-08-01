# agenttoll.receipt.v1

AgentToll paid JSON responses include an `agenttoll_receipt` object. The receipt gives agents a small audit record for one paid result: what was requested, what was returned, what payment terms were used, and where to verify settlement when the buyer runtime exposes a transaction hash.

This is not a replacement for x402 settlement. x402 still handles payment challenge, signature, verification, and settlement. The receipt is the result-side record AgentToll returns after the paid handler runs.

## Fields

```json
{
  "schemaVersion": "agenttoll.receipt.v1",
  "service": "agenttoll.dev",
  "tool": "gen_video_intel",
  "route": "/paid/media/gen-video",
  "requestId": "uuid",
  "issuedAt": "2026-07-31T00:00:00.000Z",
  "payment": {
    "protocol": "x402",
    "scheme": "exact",
    "network": "eip155:8453",
    "asset": "USDC",
    "assetContract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "amountUsd": "0.05",
    "payTo": "0x62a0D3d9DF0dE8804983009949c714EaeAFd87F1",
    "settlementTx": null,
    "settlementNote": "The x402 middleware verifies payment before this handler runs. If the buyer runtime exposes an x-payment-response transaction hash, verify it at /receipt/<tx>."
  },
  "hashes": {
    "requestHash": "sha256:...",
    "resultHash": "sha256:...",
    "paymentTermsHash": "sha256:..."
  },
  "verifier": "https://agenttoll.dev/receipt/{settlementTx}",
  "receiptSchema": "https://agenttoll.dev/agenttoll-receipt-v1.md"
}
```

## How an agent should use it

Before paying, fetch the free route metadata or quote:

```text
GET /paid/media/gen-video
GET /api/quote?tool=gen_video_intel
GET /api/routes/find?q=video%20model%20settings
```

Verify these values before asking the user to approve spend:

- `network` is `eip155:8453`
- `assetContract` is `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- `payTo` is `0x62a0D3d9DF0dE8804983009949c714EaeAFd87F1`
- `maxPaymentUsd` is no higher than the route price
- the route or MCP tool matches the user task

After payment, store the response body and `agenttoll_receipt`. If `settlementTx` is present, call:

```text
GET /receipt/<settlementTx>
```

That route checks Base transaction logs for a USDC transfer to the AgentToll seller wallet.

## Hash semantics

`requestHash` is the SHA-256 hash of the JSON request body after stable key sorting.

`resultHash` is the SHA-256 hash of the JSON result before the receipt envelope is attached.

`paymentTermsHash` is the SHA-256 hash of the buyer contract metadata for the tool: route, price, network, asset, seller wallet, input shape, expected result, and verification rules.

These hashes let a buyer agent bind the returned data to the request and payment terms it approved. They do not prove on-chain settlement by themselves. Use `/receipt/<tx>` for settlement proof when a transaction hash is available.

## Current limitation

Some x402 clients expose the settlement transaction hash to the caller and some do not. When AgentToll can read the `x-payment-response` transaction hash, it fills `payment.settlementTx`. Otherwise it leaves the field as `null` and includes the verifier URL for the buyer runtime to call once it has the transaction hash.
