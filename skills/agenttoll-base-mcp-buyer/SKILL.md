---
title: "AgentToll Base MCP buyer skill"
description: "Use when an MCP-capable assistant needs to evaluate, explain, and buy AgentToll x402 paid routes through Base MCP with user approval and strict payment checks."
name: agenttoll-base-mcp-buyer
version: 0.1.0
---

# AgentToll Base MCP buyer skill

Use this skill when an MCP-capable assistant needs to decide whether to buy an AgentToll x402 route through Base MCP.

## What this service is

AgentToll exposes paid data and decision tools over HTTP and MCP. Each paid route returns an x402 payment challenge before it returns the paid result. Settlement is USDC on Base mainnet.

- MCP endpoint: `https://agenttoll.dev/mcp`
- Agent manifest: `https://agenttoll.dev/.well-known/agent.json`
- OpenAPI spec: `https://agenttoll.dev/openapi.json`
- Full agent context: `https://agenttoll.dev/llms-full.txt`
- Quote API: `https://agenttoll.dev/api/quote?tool=x402_rank_audit`
- Network: Base mainnet, `eip155:8453`
- Asset: USDC on Base
- Seller wallet: `0x62a0D3d9DF0dE8804983009949c714EaeAFd87F1`

## Base MCP payment flow

Base MCP lets an assistant request an x402 payment through a user controlled Base Account. The assistant should not invent a payment address or bypass the user's approval step.

Use this order:

1. Read the free route metadata, manifest, OpenAPI spec, or quote API.
2. Confirm the route price, method, URL, input body, network, asset, and seller wallet.
3. Explain the purchase to the user in one sentence.
4. Set `maxPayment` at or barely above the published price.
5. Initiate the x402 request through Base MCP.
6. Wait for the user to approve through Base Account.
7. Complete the x402 request and return the paid result.

## Buyer checks before payment

Do not pay blindly. Check these first:

- The URL is under `https://agenttoll.dev/paid/`.
- The method and body match the free metadata or OpenAPI spec.
- The price is visible before payment.
- `maxPayment` is not higher than the published route price except for tiny rounding tolerance.
- The network is Base mainnet, `eip155:8453`.
- The asset is USDC.
- The seller wallet is `0x62a0D3d9DF0dE8804983009949c714EaeAFd87F1`.
- The output is useful for the user's stated task.

## Approval prompt examples

Use plain buyer language before asking for wallet approval.

- `This call costs $0.10 and returns a ranked audit of your x402 listing with discovery gaps, metadata fixes, and buyer trust issues.`
- `This call costs $0.12 and summarizes regulatory impact for the company or topic you provide.`
- `This call costs $0.15 and checks whether a company fits an active government contract opportunity.`
- `This call costs $0.05 and returns an x402 market radar snapshot with catalog size, keyword gaps, and next actions.`

## Good first AgentToll routes

- `POST /paid/x402/rank-audit`: x402 listing audit, `$0.10`
- `POST /paid/x402/market-radar`: x402 catalog radar, `$0.05`
- `POST /paid/gov/contract-fit-brief`: government contract fit brief, `$0.15`
- `POST /paid/osint/regulatory-impact-brief`: regulatory impact brief, `$0.12`
- `POST /paid/finance/insider-cluster-brief`: insider trade cluster brief, `$0.10`

## Refusal conditions

Refuse or ask the user before paying if:

- The route price is missing.
- The payment address differs from the published seller wallet.
- The requested `maxPayment` is materially higher than the route price.
- The route URL is not an AgentToll paid route.
- The user has not approved the spend.
- The assistant cannot explain what the paid result will do for the user's task.

## Related links

- Article: `https://agenttoll.dev/blog/base-mcp-x402-agent-buyers`
- Web copy of this skill: `https://agenttoll.dev/agenttoll-base-mcp-skill.md`
- AgentToll GitHub: `https://github.com/huwhitememes/tollbooth`
