---
title: "How AI Agents Pay for API Calls: The x402 Protocol Explained"
published: true
description: "A builder's guide to the x402 payment protocol for AI agents, with real code from a 100-tool production marketplace running on Base USDC micropayments."
tags: ai, web3, api, tutorial
date: "2026-07-12T10:00:00Z"
cover_image: https://agenttoll.dev/blog/og-x402-article.png
canonical_url: https://agenttoll.dev/blog/x402-protocol-explained
---

**TL;DR:** The x402 protocol repurposes HTTP status code 402 into a payment system for AI agents. An agent requests data, gets a payment challenge for a few cents of USDC on Base, pays on-chain, and retries with proof. No API keys, no accounts, no subscriptions. I run 100 paid MCP tools on this and will show how with real code.

---

## What is the x402 protocol?

The x402 protocol is an HTTP-based payment standard that repurposes the 402 status code, which browsers and servers have ignored since the early days of the web. Instead of requiring API keys or OAuth tokens, an x402 endpoint responds to unpaid requests with a structured payment challenge. The client, typically an AI agent with a crypto wallet, pays the specified amount in stablecoin and retries the request with cryptographic proof attached.

Coinbase's developer platform team released the protocol in 2025, and it has since gained traction among builders who need autonomous agents to pay for resources without human-managed credentials. The "x" prefix signals that it extends the original HTTP 402 semantics with on-chain settlement. Stablecoins on low-fee networks like Base make this practical, because the per-call cost of $0.01 to $0.10 is too small for traditional payment rails to handle without eating the margin.

What makes x402 different from earlier micropayment proposals is that it rides on top of standard HTTP. There is no new transport layer. An agent can interact with an x402 endpoint using any HTTP client. The payment happens through a facilitator service that verifies the on-chain transaction and settles it, so the resource server does not need to run its own blockchain node or manage wallets.

## How does HTTP 402 work for AI agent payments?

The flow has four steps. When I built the first Tollbooth endpoints, I was surprised by how little code sits between a normal API handler and a paid one. The x402 middleware handles everything.

Step 1: The agent sends a normal HTTP POST to a paid endpoint.

```bash
curl -X POST https://agenttoll.dev/paid/osint/usgs-quake \
  -H "Content-Type: application/json" \
  -d '{"limit": 10}'
```

Step 2: The server responds with HTTP 402 and a payment challenge body.

```json
{
  "error": "payment_required",
  "price_usd": "0.02",
  "network": "eip155:8453",
  "accepts": {
    "scheme": "exact",
    "price": "$0.02",
    "network": "eip155:8453",
    "payTo": "0x62a0D3d9DF0dE8804983009949c714EaeAFd87F1"
  }
}
```

The `accepts` block tells the agent exactly what payment to construct: two cents of USDC on Base (chain ID 8453), sent to the specified wallet address. The `scheme: "exact"` field means the payment must match the price precisely, no rounding.

Step 3: The agent's wallet constructs the payment. This is a signed on-chain transfer of USDC to the seller's address. The agent wraps this payment in an `X-Payment` header as a base64-encoded payload.

Step 4: The agent retries the same request with the payment header attached.

```bash
curl -X POST https://agenttoll.dev/paid/osint/usgs-quake \
  -H "Content-Type: application/json" \
  -H "X-Payment: eyJ4NDAy..." \
  -d '{"limit": 10}'
```

Payment middleware on the server intercepts this header, sends it to a facilitator for verification, and if the payment is valid, lets the request through to the handler. The facilitator then settles the payment on-chain. From the agent's perspective, it made two HTTP calls. From the seller's perspective, the money landed in their wallet without ever seeing a credit card form.

## How do you build a paid API endpoint with x402?

I will show you the actual wiring from Tollbooth. The codebase runs on Cloudflare Workers with TypeScript, using the `@modelcontextprotocol/sdk` and the `x402` payment package. Every paid tool touches five layers. Miss one, and the tool breaks in a subtle way that only surfaces in production.

The five layers are: a payment middleware configuration, an HTTP route handler, an MCP tool registration, a discovery manifest entry, and an OpenAPI spec path. Here is what each one looks like in practice.

**Layer 1: Payment middleware configuration**

```typescript
import { paymentMiddleware } from "x402/hono";

paidHttp.use(paymentMiddleware({
  "POST /paid/osint/usgs-quake": {
    accepts: {
      scheme: "exact",
      price: "$0.02",
      network: SERVICE.network,
      payTo: SERVICE.seller
    },
    resource: `${SERVICE.origin}/paid/osint/usgs-quake`,
    description: "Live USGS earthquake data (M2.5+, last 24h)",
    mimeType: "application/json",
    serviceName: SERVICE.name,
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    unpaidResponseBody: () => ({
      contentType: "application/json",
      body: {
        error: "payment_required",
        price_usd: "0.02",
        network: SERVICE.network
      }
    })
  }
}));
```

This middleware entry is what makes the endpoint return 402 instead of 200. I cannot count the number of times I have added a new tool, written the route handler, tested it, and watched it return free data because I forgot this middleware entry. The symptom is immediate: the endpoint returns HTTP 200 with the full response body, no payment challenge. Every new route needs this explicit `curl` check:

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST \
  https://agenttoll.dev/paid/osint/usgs-quake \
  -H "Content-Type: application/json" -d '{}'
# Must return 402, not 200
```

**Layer 2: HTTP route handler**

```typescript
paidHttp.post("/paid/osint/usgs-quake", async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const data = await getCachedOrLive(
    c.env as any,
    "usgs-quake",
    () => fetchUsgsQuake(body),
    { params: body }
  );
  return c.json(data.data, 200, {
    "X-Cache": data.cached ? "HIT" : "MISS"
  });
});
```

**Layer 3: MCP tool registration**

This is what makes the tool visible to MCP-compatible agents like Claude:

```typescript
this.server.paidTool(
  "usgs_quake",
  "Live USGS earthquake data, M2.5+, last 24 hours",
  0.02,
  { limit: z.number().optional() },
  {},
  async (args) => {
    const data = await mcpGetCachedOrLive(
      this.env,
      "usgs-quake",
      () => fetchUsgsQuake(args),
      args
    );
    return {
      content: [{ type: "text", text: JSON.stringify(data) }]
    };
  }
);
```

`paidTool` is an extension of the standard MCP `tools/list` registration. When an MCP client calls `tools/list`, it sees this tool with its price. The client knows it needs to handle a payment challenge before the tool will respond.

**Layers 4 and 5: Discovery manifests**

The tool also needs entries in the `agent.json` discovery manifest (served at `/.well-known/agent.json`) and the OpenAPI spec (served at `/openapi.json`). Without the OpenAPI entry, x402scan, the protocol's directory service, will not index the route. Without the agent.json entry, agents using the Model Context Protocol discovery flow will not find it.

This five-layer pattern is the single most important thing to internalize. Every tool I have shipped has gone through all five. The ones that broke in production broke because one layer was missing.

## What does a full x402 payment flow look like in code?

This is a complete example of an agent making a paid call. I wrote this as a test script that exercises a real Tollbooth endpoint. It uses the `x402-fetch` client library, which wraps the standard `fetch` with automatic payment handling.

```typescript
import { wrapFetchWithPayment } from "x402/fetch";
import { createWalletClient, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

// 1. Create a wallet for the agent
const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`);
const walletClient = createWalletClient({
  account,
  chain: base,
  transport: http()
});

// 2. Wrap fetch with x402 payment support
const fetchWithPayment = wrapFetchWithPayment(
  fetch,
  walletClient,
  {
    facilitatorUrl: "https://facilitator.payai.network"
  }
);

// 3. Make the paid request
const response = await fetchWithPayment(
  "https://agenttoll.dev/paid/osint/usgs-quake",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit: 10 })
  }
);

const data = await response.json();
console.log(data);
```

`wrapFetchWithPayment` intercepts any 402 response, reads the payment requirements from the body, constructs the USDC payment using the agent's wallet, and retries the request with the `X-Payment` header. The agent developer writes one line of setup. The rest is automatic.

What surprised me when I first tested this was the speed. On Base, the payment verification takes about 200 to 400 milliseconds through the facilitator. The total round trip for a paid call, including the initial 402 challenge and the paid retry, lands between 600ms and 1.2 seconds for most tools. That is fast enough for interactive agent workflows.

## How do AI agents discover paid MCP tools?

Discovery is where most builders, including me initially, get the architecture wrong. You build the tools, you register them in directories, and then you wait for agents to find them. But agents do not browse directories. They web search.

This was the biggest insight from building Tollbooth. The x402 ecosystem has directory services like x402scan and the CDP Bazaar. Getting listed there is necessary but not sufficient. When an autonomous agent needs earthquake data, it does not query x402scan. It does a web search for "live earthquake data API" or "paid USGS earthquake tool." If your tool page does not rank for that search, the agent never finds you.

Three discovery surfaces matter:

The `/.well-known/agent.json` manifest is the machine-readable catalog. Agents that already know about your marketplace fetch this to discover available tools and pricing.

The `/.well-known/x402` endpoint (and its `.json` variant) provides the protocol-level resource listing. x402scan crawls this to build its directory. A subtlety I hit: x402scan tries the no-extension version first (`/.well-known/x402`), and some setups only serve the `.json` variant. Serve both.

Individual tool pages at `/tools/{tool-name}` with SEO-optimized descriptions are what agents find through web search. Each page describes the tool, its price, its inputs, and includes an example request. This is the discovery layer that drives traffic.

The CDP Bazaar, Coinbase's x402 marketplace, has an additional requirement that caught me off guard. You do not get listed just by serving the right manifests. The Bazaar requires at least one real paid settlement through Coinbase's facilitator before it indexes your resources. The buyer wallet I was using for self-testing was frozen for 72 hours after funding, which blocked the settlement test. This is a cold-start catch-22 worth knowing about: you need a real transaction to get listed, but getting that first transaction through requires a funded wallet and patience.

## What goes wrong when you build x402 endpoints at scale?

Building one x402 endpoint is straightforward. Building 100 reveals failure modes that the protocol documentation does not cover. Here are the problems I hit, in roughly the order they appeared.

**The missing middleware pitfall.** When you add a new paid route, the route handler is not enough. You also need the payment middleware configuration entry. Without it, the route returns 200 with free data. This happened twice in production. The fix is to verify every new route with a bare curl that checks for 402 before deploying. I now treat this curl check as a mandatory step, not optional.

**Three different tool counts.** Tollbooth has three numbers that all mean "how many tools do we have," and they never match. The TOOLS catalog array (the source of truth for the public manifest) has 100 entries. The `paidTool()` MCP registrations count 94, because nearly every HTTP tool has an MCP registration. The HTTP 402 route count is 92. When someone asks how many tools are live, the answer depends on which surface they are asking about. I track all three with grep commands now.

**CDN caching of agent.json.** Cloudflare's CDN caches the `/.well-known/agent.json` manifest aggressively. After deploying 12 new tools, the first verification call returned the old count because the CDN served a cached response. The deploy was correct, but it looked broken. The fix is to always cache-bust when verifying:

```bash
curl -sS -H 'Cache-Control: no-cache' \
  'https://agenttoll.dev/.well-known/agent.json?v='$(date +%s) | \
  python3 -c "import sys,json; print(len(json.load(sys.stdin)['tools']))"
```

I spent 15 minutes chasing a non-existent deploy failure before learning this.

**Facilitator chain mismatches.** The PayAI facilitator at `facilitator.payai.network` supports both Base mainnet (chain ID 8453) and Base Sepolia testnet (84532). If your `SERVICE.network` config says `eip155:84532` but your payment middleware expects mainnet, payments fail silently. The facilitator accepts the payment request but never settles, because the chain does not match. Always verify the chain ID in your config matches the facilitator endpoint you are using.

**Discovery extensions for the CDP Bazaar.** Each route needs a `declareDiscoveryExtension` object attached to its payment middleware entry. Without it, the CDP Bazaar shows zero resources for your origin. I had 37 routes missing extensions in one deployment, and the Bazaar returned an empty catalog. The extensions are what the Bazaar indexes at settle time, not just the payment configuration fields like `serviceName` and `iconUrl`.

**KV cache and cron triggers for fulfillment.** The first version of Tollbooth fetched live data on every paid call. This worked but added 2 to 8 seconds of latency depending on the upstream API. Moving to a Cloudflare KV cache with 15-minute cron pre-warming cut that to under 50 milliseconds for cache hits. The pattern: cron triggers run every 15 minutes, fetch data from upstream APIs, and write to KV. Paid calls read from KV first, fall back to live if the cache is cold. Buyers do not pay more for cached data, and the response is 40x faster.

## How much does it cost to run 100 paid tools on x402?

The infrastructure cost is close to zero. Cloudflare Workers free tier handles 100,000 requests per day. Durable Objects, which run the MCP server, cost $0.15 per million requests. KV reads are $0.50 per million, writes are $5 per million. For a marketplace doing a few thousand paid calls per day, the total infrastructure bill is under $5 per month.

Development time is the real cost. Each tool requires the five-layer wiring, upstream API research, pricing decisions, and testing. A straightforward tool that wraps a free public API takes about 45 minutes from research to deployed. A composite tool that aggregates multiple sources and does computation takes 2 to 3 hours.

On the revenue side, at $0.02 to $0.10 per call, volume is everything. A tool that gets 100 calls per day at $0.02 generates $2 per day, or about $60 per month. To build a sustainable marketplace, you need tools that agents call repeatedly. The polymarket arbitrage tools, at $0.08 to $0.10 per call, are the highest-margin tools in Tollbooth because agents call them in loops during active trading sessions.

## Will x402 replace API keys and subscriptions?

Not entirely, and probably not soon for enterprise use cases. API keys solve a problem x402 does not address: identity and access control. If you need to know who is calling your API, rate-limit specific users, or enforce data access policies, a payment protocol alone is not enough.

But for the growing class of autonomous agents that need to buy data and computation on demand, x402 solves a problem API keys handle poorly: the cold-start problem. An agent that discovers a useful API at 3 AM cannot create an account, wait for email verification, add a credit card, generate an API key, and start calling. With x402, it pays and calls in the same HTTP exchange. No signup, no waiting, no human in the loop.

Subscriptions also struggle with usage-based pricing for agents. An agent might need 50 calls today and zero tomorrow. A $49/month subscription makes no sense for that pattern. Pay-per-call at $0.02 to $0.10 does. The agent spends a dollar on a busy day and nothing on an idle one.

I think x402 will carve out a specific niche: autonomous agent-to-service payments where the transaction size is too small for traditional payment rails and too frequent for manual setup. It will not replace Stripe. It will sit alongside it, handling the calls that Stripe's fee structure makes uneconomical.

## The facilitator is the linchpin

One architectural detail that does not get enough attention: the facilitator. Every x402 marketplace depends on a facilitator service to verify and settle payments. Tollbooth uses PayAI's free facilitator at `facilitator.payai.network`. Coinbase's CDP also runs one. Without a facilitator, you would need to run your own blockchain node, verify transactions yourself, and manage settlement logic.

The facilitator handles three things: verifying that the agent's payment is valid and on the correct chain, settling the payment so the seller receives funds, and returning a receipt the resource server can trust. The resource server never touches the blockchain directly. It trusts the facilitator's verdict.

This creates a dependency. If the facilitator goes down, paid calls stop working, even though the resource server and the agent are both fine. I have not hit an outage yet, but the architecture assumes the facilitator is reliable. For production deployments, monitoring the facilitator's health is as important as monitoring your own server.

## Building your first paid endpoint

If you want to try x402, start with one tool. Pick a free public API, wrap it in a Cloudflare Worker, add the payment middleware, and deploy. The whole thing should take under an hour. Test it with the `x402-fetch` client using a funded wallet on Base Sepolia (testnet, free money). Once you have one paid call working end to end, scaling to 10 or 100 is a matter of repeating the five-layer pattern.

You can find the full codebase at [github.com/huwhitememes/tollbooth](https://github.com/huwhitememes/tollbooth) — it is open source. The five-layer checklist and the facilitator configuration are the parts worth studying. Everything else is just data fetching.

---

*Hu White is a generative-AI veteran who builds agenttoll.dev, a paid MCP tool marketplace with 100 tools running on the x402 protocol. Find his work at [github.com/huwhitememes/tollbooth](https://github.com/huwhitememes/tollbooth) and [LinkedIn](https://www.linkedin.com/in/huwhitememes/).*
