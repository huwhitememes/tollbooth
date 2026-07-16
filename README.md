<div align="center">

# 🪙 Tollbooth

### 100 paid MCP tools for AI agents. Pay per call in USDC on Base. No accounts, no API keys, no credit cards.

[![Tools](https://img.shields.io/badge/tools-100-blue)](https://agenttoll.dev/tools)
[![Network](https://img.shields.io/badge/network-Base%20mainnet-blue)](https://base.org)
[![Protocol](https://img.shields.io/badge/payment-x402-green)](https://x402.org)
[![Status](https://img.shields.io/badge/status-live-brightgreen)](https://agenttoll.dev)
[![Price](https://img.shields.io/badge/min%20price-%240.01-success)](https://agenttoll.dev/tools)

[🌐 Website](https://agenttoll.dev) · [📖 Docs](https://agenttoll.dev/docs) · [🔧 Tools](https://agenttoll.dev/tools) · [🤖 MCP Endpoint](https://agenttoll.dev/mcp) · [📋 agent.json](https://agenttoll.dev/.well-known/agent.json)

</div>

---

## What is agenttoll.dev?

agenttoll.dev is a marketplace of **100 paid tools** exposed through the [Model Context Protocol](https://modelcontextprotocol.io). Any MCP-compatible agent — Claude, Cursor, custom builds — can discover and call these tools. Payment happens automatically via the [x402 protocol](https://x402.org): the agent attaches a USDC micropayment to each request, the server verifies it on-chain, and returns the data. Pennies per call. No signup, no billing dashboard, no API key management.

**One-line pitch:** Stripe for agent tool calls, except the checkout is a 402 response with a payment challenge instead of a credit card form.

### What's actually here

| | |
|---|---|
| **100 tools** | Prediction market scanning, OSINT feeds, SEC filings, court records, academic search, FDA recalls, wildfire data, federal spending, CVE lookups, and more |
| **12 categories** | Prediction Markets, OSINT, Web Intel, Legal, Academic, Health, Environmental, Government, Finance, Security, Gen-Video Intel, Utility |
| **Pricing** | $0.01 – $0.10 per call. You see the price before paying — it's in the tool schema. |
| **Payment** | USDC on Base mainnet via x402 exact-payment scheme |
| **Infrastructure** | Cloudflare Worker + Durable Objects (state) + KV (cache). Edge-deployed, sub-50ms cold starts. |

---

## Quick Start

### 1. Connect your MCP client

Point any MCP-compatible client at the endpoint:

```json
{
  "mcpServers": {
    "tollbooth": {
      "url": "https://agenttoll.dev/mcp"
    }
  }
}
```

That's it. The server advertises all 100 tools with their schemas and prices. Your agent picks the ones it needs.

### 2. Fund a wallet with USDC on Base

Send a few dollars of USDC (Base mainnet) to a wallet your agent controls. That's the only balance you need. One cent covers 10–100 tool calls depending on the tool.

| Detail | Value |
|---|---|
| Network | Base mainnet (`eip155:8453`) |
| Asset | USDC |
| USDC contract | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Seller address | `0x62a0D3d9DF0dE8804983009949c714EaeAFd87F1` |
| Facilitator | `https://facilitator.payai.network` |
| Payment scheme | x402 exact |

### 3. Call a tool

Your MCP client handles the payment flow automatically. When you call a paid tool, the server responds with HTTP 402 and a payment challenge. Your client signs the payment, re-sends the request, and gets the data back. You don't write any payment code.

---

## How Payment Works

```
  Agent                    Tollbooth                 Base Mainnet
    │                          │                          │
    │── tool call ────────────▶│                          │
    │                          │                          │
    │◀── 402 Payment Required ─│                          │
    │    (price, scheme,       │                          │
    │     accept tokens)       │                          │
    │                          │                          │
    │── signed USDC payment ──▶│                          │
    │    (x402 exact scheme)   │                          │
    │                          │── verify on-chain ──────▶│
    │                          │◀── ✓ valid ──────────────│
    │                          │                          │
    │◀── 200 OK + tool result ─│                          │
    │                          │                          │
```

**What the agent sees:** A normal MCP tool call that costs money. The 402 → payment → retry cycle is handled by the x402 client library. No manual signing, no transaction monitoring.

**What the developer sees:** A single endpoint. No auth headers, no API keys to rotate, no rate limit tiers to manage. The price is in the tool schema — your agent can decide whether a call is worth it before paying.

---

## Tool Categories

| Category | Count | Price Range | Example Tools |
|---|:---:|:---:|---|
| **Prediction Markets** | 12 | $0.02–$0.10 | `cross_platform_arb_scan`, `smart_money`, `orderbook_imbalance`, `kalshi_markets` |
| **OSINT & Intelligence** | 14 | $0.02–$0.05 | `geo_intervention_pulse`, `osint_research_pack`, `sec_8k_velocity`, `treasury_dts` |
| **Web Intel & Scraping** | 8 | $0.01–$0.05 | `scrape`, `enrich_lead`, `detect_stack`, `score_lead` |
| **Environmental & Climate** | 12 | $0.02–$0.03 | `wildfires`, `aurora_forecast`, `weather_forecast_grid`, `usgs_quake` |
| **Health & Safety** | 9 | $0.02–$0.04 | `drug_recalls`, `adverse_events`, `disease_outbreaks`, `vehicle_recalls` |
| **Academic & Research** | 8 | $0.02–$0.04 | `search_papers`, `search_arxiv`, `clinical_trials`, `citation_graph` |
| **Government & Civic** | 8 | $0.02–$0.04 | `federal_spending`, `national_debt`, `lobbying_records`, `federal_grants` |
| **Finance & Crypto** | 8 | $0.01–$0.03 | `edgar_filings`, `insider_trades`, `crypto_price_simple`, `fred_series` |
| **Legal & Regulatory** | 7 | $0.03–$0.05 | `court_opinions`, `patents_search`, `trademarks_search`, `federal_register` |
| **Security** | 7 | $0.02–$0.05 | `agent_threat_intel`, `cve_search`, `mcp_supply_chain_iocs`, `agent_trifecta_score` |
| **Social, Utility & AI** | 7 | $0.01–$0.05 | `reddit_search`, `github_repo_intel`, `gen_video_intel`, `currency_rates` |

**Total: 100 tools.** Browse all of them at [agenttoll.dev/tools](https://agenttoll.dev/tools).

---

## Code Example

### Calling a paid tool via MCP (TypeScript)

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { exactEvmClientExtension } from "@x402/evm/exact/client";

// 1. Create an MCP client with x402 payment support
const client = new Client({
  name: "my-agent",
  version: "1.0.0",
});

const transport = new StreamableHTTPClientTransport(
  new URL("https://agenttoll.dev/mcp"),
  {
    // x402 exact payment extension — handles 402 → sign → retry
    extensions: [
      exactEvmClientExtension({
        walletClient: yourBaseWalletClient, // viem wallet on Base
      }),
    ],
  }
);

await client.connect(transport);

// 2. List available tools (free — no payment needed for discovery)
const { tools } = await client.listTools();

// Each tool's price is in the schema:
// tools[0].annotations.price_usd → "0.03"
// tools[0].annotations.x402_price → { scheme: "exact", ... }

// 3. Call a paid tool — payment happens automatically
const result = await client.callTool({
  name: "cross_platform_arb_scan",
  arguments: {
    query: "bitcoin",
    min_net_edge: "0.015",
  },
});

// result.content[0].text → JSON with cross-platform arbitrage opportunities
// Your wallet was debited $0.10 in USDC on Base. That's it.
console.log(result.content[0].text);
```

### Using with Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tollbooth": {
      "url": "https://agenttoll.dev/mcp"
    }
  }
}
```

Claude will discover all 100 tools automatically. (Note: Claude Desktop needs an x402-compatible payment wallet to complete paid calls — the discovery and schema listing are free.)

---

## Architecture

```
                    ┌─────────────────────────────────┐
                    │      agenttoll.dev (edge)        │
                    │    Cloudflare Worker (Hono)      │
                    │                                  │
  MCP Request ─────▶│  ┌─────────────┐  ┌──────────┐  │
  (JSON-RPC over    │  │  MCP Server  │  │ x402     │  │
   HTTP/SSE)        │  │  (Durable    │  │ Payment  │  │
                    │  │   Object)    │  │ Middleware│  │
                    │  └──────┬───────┘  └────┬─────┘  │
                    │         │               │        │
                    │  ┌──────▼───────────────▼─────┐  │
                    │  │    Tool Implementations     │  │
                    │  │  (scrapers, API wrappers,   │  │
                    │  │   data feeds, analyzers)    │  │
                    │  └──────────────┬──────────────┘  │
                    │         ┌───────┴────────┐        │
                    │    ┌────▼────┐    ┌──────▼─────┐  │
                    │    │ KV Cache │    │ Public     │  │
                    │    │ (15min   │    │ APIs       │  │
                    │    │  TTL)    │    │ (no keys)  │  │
                    │    └─────────┘    └────────────┘  │
                    └─────────────────────────────────┘
                                     │
                    ┌────────────────▼────────────────┐
                    │   x402 Facilitator               │
                    │   facilitator.payai.network      │
                    │   Verifies USDC payment on Base  │
                    └─────────────────────────────────┘
```

**Stack:** TypeScript · Hono · Cloudflare Workers · Durable Objects · KV · `@modelcontextprotocol/sdk` · `@x402/core` · `@x402/hono`

All 100 tools are backed by **free, keyless public APIs** — USAspending.gov, SEC EDGAR, CourtListener, PubMed, NASA FIRMS, NOAA, USGS, Polymarket, Kalshi, Reddit, GitHub, and others. agenttoll.dev wraps them with caching, normalization, structured output, and the payment layer. You pay for the aggregation, reliability, and agent-ready formatting — not for the raw data itself.

---

## Discovery

### agent.json

agenttoll.dev publishes a machine-readable manifest at the standard location:

```
https://agenttoll.dev/.well-known/agent.json
```

This follows the emerging agent discovery spec — identity, endpoint, payment config, and full tool catalog with prices. Agents can discover agenttoll.dev the same way crawlers discover `robots.txt`.

<details>
<summary>View agent.json summary</summary>

```json
{
  "schema_version": "0.1",
  "name": "agenttoll.dev",
  "description": "Paid MCP and HTTP tools for prediction market intelligence...",
  "homepage": "https://agenttoll.dev",
  "mcp": "https://agenttoll.dev/mcp",
  "contact": { "name": "Hu White", "email": "memerhuwhite@gmail.com" },
  "payments": {
    "protocol": "x402",
    "scheme": "exact",
    "network": "eip155:8453",
    "network_name": "Base mainnet",
    "asset": "USDC",
    "asset_contract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "facilitator": "https://facilitator.payai.network",
    "seller": "0x62a0D3d9DF0dE8804983009949c714EaeAFd87F1"
  },
  "tools": [ ... 100 tools with name, price_usd, description, input schema ... ]
}
```
</details>

---

## Honest Limitations

agenttoll.dev is live and functional, but it's not pretending to be something it isn't:

- **No uptime SLA.** This runs on a Cloudflare Worker. It's reliable for a solo project, but there's no redundancy beyond what Cloudflare provides. Don't build life-critical infrastructure on it.
- **Data is as fresh as the upstream APIs.** Most tools cache responses for 10–15 minutes in KV. If a source API is down, the tool is down. Polymarket, SEC EDGAR, and CourtListener have all had outages in 2026.
- **Prices may change.** Current pricing ($0.01–$0.10) reflects what a solo operator can sustain. If upstream APIs start rate-limiting or adding their own costs, prices go up. The `agent.json` always reflects current pricing — your agent reads it dynamically.
- **No data guarantees.** These are wrappers around public APIs. If the FDA reports bad data, agenttoll.dev returns bad data. Verify before making decisions with real money.
- **x402 is early.** The protocol works (payments settle on Base mainnet), but the client ecosystem is still maturing. If your MCP client doesn't support x402 payment extensions yet, paid calls will fail with a 402 you can't resolve. Discovery and schema listing work for any MCP client.
- **No rate limiting beyond politeness.** Tools self-throttle to respect upstream API limits (e.g., 9 req/sec for SEC, 2 req/sec for FRED). There's no per-customer rate limiting — if you hammer the endpoint, you'll get errors from upstream APIs, not from agenttoll.dev.

---

## Links

| Resource | URL |
|---|---|
| **Website** | [agenttoll.dev](https://agenttoll.dev) |
| **MCP Endpoint** | `https://agenttoll.dev/mcp` |
| **Tool Directory** | [agenttoll.dev/tools](https://agenttoll.dev/tools) |
| **Documentation** | [agenttoll.dev/docs](https://agenttoll.dev/docs) |
| **agent.json** | [agenttoll.dev/.well-known/agent.json](https://agenttoll.dev/.well-known/agent.json) |
| **GitHub** | [github.com/huwhitememes/tollbooth](https://github.com/huwhitememes/tollbooth) |
| **x402 Protocol** | [x402.org](https://x402.org) |
| **MCP Spec** | [modelcontextprotocol.io](https://modelcontextprotocol.io) |
| **Base Network** | [base.org](https://base.org) |

---

## License

The agenttoll.dev service is free to use (you only pay per call). Source code in this repo is provided for reference and self-hosting. See [LICENSE](LICENSE) if present.

The underlying data tools aggregate from public APIs under their respective terms of service (USAspending.gov public domain, SEC EDGAR public domain, NOAA/USGS public domain, etc.).

---

<div align="center">

**Built by [Hu White](https://github.com/huwhitememes)** · Powered by [x402](https://x402.org) · Running on [Base](https://base.org)

[Report an issue](https://github.com/huwhitememes/tollbooth/issues) · [Contact](mailto:memerhuwhite@gmail.com)

</div>
