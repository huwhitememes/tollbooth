---
title: "What agents will buy first isn't stocks. It's the data about stocks."
published: true
description: "Coinbase put real US equities on Base, the same chain that dominates x402 agent payments. Agents already pay cents for data and API calls. The information layer around tokenized stocks is the builder opportunity."
tags: x402, ai, agents, base
date: "2026-09-03T17:00:00Z"
cover_image: https://agenttoll.dev/blog/og-agents-buy-stock-data.png
canonical_url: https://agenttoll.dev/blog/agents-buy-stock-data
---

**TL;DR:** On August 24, Coinbase launched tokenized US equities on Base, with real shares held 1:1 by Alpaca and Chainlink pricing them around the clock. Base is also the dominant rail for x402, the protocol agents already use to pay cents for data and API calls. No agent has bought a tokenized equity through x402 yet. The assets shipped, the payment rail shipped, and the paid data layer connecting them is the open gap.

---

On August 24, Coinbase started selling Apple, NVIDIA, Meta, and Alphabet on a blockchain.

Not futures, and not a synthetic that merely tracks the price. [Coinbase says](https://blog.base.org/tokenized-stocks) each token is a real share held 1:1 by Alpaca Securities in a bankruptcy-remote custody structure, with dividends and voting rights attached. The tokens live natively on Base, Coinbase's own layer 2, on a new standard called B20 that reached mainnet on July 8. Day one did $10.8 million in 24-hour volume, with roughly $4.5 million of shares minted onchain and about $3 million in DEX liquidity, per [CoinDesk's launch coverage](https://finance.yahoo.com/markets/crypto/articles/coinbase-tokenized-stocks-live-sec-094525267.html).

Thirteen stock contracts exist: NVDAc, METAc, AAPLc, GOOGLc, AMZN, COIN, CRCL, INTC, MSFT, MSTR, SNDK, SPCX, and TSLA. [Galaxy Research](https://www.galaxy.com/insights/research/coinbase-tokenized-stocks-base-third-party-issuer-sec-innovation-exemption) counted only the first four with actual circulating supply as of August 28, about $7.5 million worth. So this is a live product with a small footprint, not a flood of tokenized equity. Worth being precise about that, because almost nobody reporting on it has been.

## What Coinbase shipped

The structure matters more than the ticker list.

Coinbase is the issuer. Alpaca is the regulated broker and custodian. Pricing runs through Chainlink, which [Coinbase named its official oracle](https://www.prnewswire.com/news-releases/coinbase-selects-chainlink-to-bring-new-tokenized-stocks-to-millions-of-defi-users-302858414.html) the same day: continuous feeds five days a week plus weekends for crypto, a 0.5% deviation threshold, 24-hour heartbeats, and Total Return Values that fold dividends into the price. Nine DeFi protocols integrated at launch, including Aerodrome for liquidity, Aave and Morpho and Euler for lending, and Wasabi for perpetuals and options.

Galaxy calls this the wrapper model: Coinbase bought shares and wrapped them, and there is no evidence NVIDIA or Apple participated or consented. That distinction will matter later, when regulators decide what these things really are.

And the location matters. The product is restricted to non-US persons under Regulation S. On August 11, Coinbase secured a Financial Services Permission from the Abu Dhabi Global Market regulator, which is now its international tokenization hub. Why offshore? Because the SEC still has not published its innovation exemption for tokenized securities. Bloomberg reported in May that the exemption was imminent. It got delayed once after Nasdaq, NYSE, and Cboe objected over liquidity fragmentation and overnight surveillance, then delayed again in mid-August amid White House concerns about congressional negotiations, per [CoinDesk](https://www.coindesk.com/policy/2026/08/13/u-s-sec-to-again-delay-innovation-exemption-for-tokenization-amid-wall-street-white-house-concerns). The SEC's next public move on round-the-clock trading is a roundtable on September 17.

The rest of the market did not wait. Kraken's xStocks, live since June 2025, has done more than $38 billion in cumulative volume across 700+ tokenized assets, with a $609 million market cap and 125,000 holders as of mid-August, per [Genfinity](https://genfinity.io/2026/08/18/kraken-us-stocks-europe-xstocks-trading). Ondo, the largest issuer, crossed roughly $1 billion in tokenized stock value in August. And on September 1, [Reuters](https://www.reuters.com/world/uk/lseg-plans-tokenised-uk-shares-partners-with-kraken-owner-payward-2026-09-01) reported that the London Stock Exchange's parent is partnering with Kraken's owner Payward to list xStocks on its planned LSE 24 venue in 2027. Tokenized equities as a category sat near $2.3 billion in mid-July and about $2.8 billion a month later.

That is the state of the board. Now the part I care about most.

## What agents buy when nobody is watching

In May 2025, Coinbase open-sourced x402, a payments protocol that turns HTTP's forgotten 402 status code into a machine-native checkout. An agent hits a priced resource, gets a 402 back with a price attached, pays in USDC, and resubmits the request with proof of payment. No account, no API key, no human clicking through a checkout page.

On July 14 of this year the protocol moved into a foundation under the Linux Foundation, with roughly 40 member organizations including Visa, Mastercard, Stripe, Cloudflare, Google, and AWS. Cloudflare shipped a Monetization Gateway on July 1 that lets anyone charge per webpage, API call, dataset, or MCP tool, with settlement over x402. In August, AWS made AgentCore Payments generally available with Coinbase and Stripe using x402, so agents on AWS can now pay for APIs, content, and data feeds as a platform feature. Travala wired its travel MCP so an agent can book from 2.2 million hotels in USDC. you.com is adding x402 to its web search API, which means an agent will be able to pay per query for live web data.

What do agents buy with all this rail? [Coinbase told CoinDesk](https://www.coindesk.com/business/2026/08/23/crypto-s-next-billion-users-might-be-ai-agents-and-they-re-paying-with-stablecoins) that x402 has processed more than 165 million transactions worth about $50 million, from some 480,000 agents, at an average ticket near 30 cents. Lincoln Murr, who heads AI product at Coinbase, put it plainly: the product-market fit today is machine-to-machine payments from agents to APIs. Data, compute, lookups. Not meme coins, not stocks. Coinbase also conceded that maybe 25 to 30 percent of current activity could be people gaming a leaderboard rather than genuine agent spending, which is the kind of admission I respect and want to see more of.

The skeptic's numbers deserve equal billing. Analyst Jamie Coutts, citing Helios Analytics data, [found](https://www.ccn.com/news/crypto/x402-volume-plunges-cloudflare-ai-agent-payments) x402 daily settlement volume down 93 percent year to date, from peaks near $1 million a day in late 2025 to a seven-day average around $42,000. His read: the late-2025 surge was heavily testing, and the agentic economy narrative outran the transaction data. I think both stories are true at once. The volume is small and partly synthetic, and the rail is being adopted by the largest payments and infrastructure companies on the planet anyway. Rails get built before traffic shows up. That was true for the web and it will probably be true here.

## A priced asset creates priced information

Here is the connection between the two halves of this article, and it is smaller and more concrete than "AI agents will trade stocks."

Coinbase just created a new class of onchain assets that have a price, a dividend stream, a custody chain, and round-the-clock markets at rival exchanges too. Every one of those properties generates demand for information: live quotes, dividend-adjusted price feeds, order flow, liquidity depth, ownership analytics, news. The Chainlink feeds pricing Coinbase's stock tokens are already dividend-aware Total Return Values. That is a data product about a securities class, delivered onchain, five-plus days a week.

Meanwhile, the one category agents demonstrably pay for at 30 cents a ticket is data and API access.

Put those together. When equities become programmable onchain, the market data and research about those equities becomes the natural thing to sell per call. A trading agent that holds NVDAc and hedged exposure on Aerodrome does not need a Bloomberg terminal. It needs a quote it can buy for a fraction of a cent at 3 a.m., a dividend calendar it can query on demand, a liquidity check it can run before a swap. Human markets solved this with subscriptions and enterprise contracts priced for institutions. Machine markets solve it with metered micropayments, and the protocol for that already exists and already clears on the same chain where the stocks live.

This is why I'd flag the Chainlink selection for anyone building in this space. The oracle layer made tokenized equities legible to DeFi, and the x402 layer makes information about them purchasable by software. Same chain, same company, both live as of August.

## What's live, what's promised

Precision time. Things that exist today, verified:

An agent can open and manage a tokenized stock liquidity position on Base. Bankr built an Aerodrome skill where an agent runs a tokenized stock LP position around the clock; it is item eight in [Base's own August ecosystem recap](https://x.com/base/status/2095480324616593599). That is a live, if early, instance of agent-managed tokenized equity exposure.

Agents can pay per call for web search, travel bookings, and general API access over x402, with USDC settlement on Base, through Cloudflare, AWS, and direct integrations like you.com.

Things that are announced but not live:

[Coinbase for Agents](https://www.coinbase.com/blog/coinbase-for-agents), launched June 11, lets ChatGPT or Claude trade crypto against a Coinbase account and will be x402-enabled for machine payments. Reporting in early September says Coinbase plans to expand it into traditional equities and prediction markets. Plans. Roadmap. Not shipped.

And things that do not exist at all, as far as I could verify: any product where an agent buys or sells tokenized equities through an x402 payment flow, and any live tokenized equity data feed gated behind x402. If someone tells you agents are already trading tokenized stocks over agentic payment rails, ask for the transaction. I looked, and the closest real artifacts are the Bankr LP skill and a lot of roadmap language.

The gap between those two lists is the opportunity. The assets shipped. The payment rail shipped. The data products connecting them have not, and the first usable ones will likely look boring: a pay-per-quote endpoint, a dividend feed, a liquidity scanner, each charging fractions of a cent to software that never sleeps and never asks for an invoice.

## Where this goes

The pattern I track in my own work is simple: whenever a new asset class gets a machine-readable price, paid services grow around it like barnacles. Tokenized equities just got that price on the chain that dominates agentic payments. The stocks themselves are a story for securities lawyers and offshore exchanges. The information layer around them, metered and sold to agents one call at a time, is the story for builders, and it is barely started.

I keep a running directory of x402 paid tools and services at [agenttoll.dev](https://agenttoll.dev). If you are building one of those boring, useful data endpoints, that is where your first agent customers will be looking.

## Sources

- [Coinbase Tokenized Stocks launch, Base blog, Aug 24, 2026](https://blog.base.org/tokenized-stocks)
- [Launch detail and day-one numbers, CoinDesk via Yahoo Finance, Aug 25, 2026](https://finance.yahoo.com/markets/crypto/articles/coinbase-tokenized-stocks-live-sec-094525267.html)
- [Third-party wrapper analysis and supply counts, Galaxy Research, Aug 28, 2026](https://www.galaxy.com/insights/research/coinbase-tokenized-stocks-base-third-party-issuer-sec-innovation-exemption)
- [Chainlink oracle selection, PR Newswire, Aug 24, 2026](https://www.prnewswire.com/news-releases/coinbase-selects-chainlink-to-bring-new-tokenized-stocks-to-millions-of-defi-users-302858414.html)
- [SEC innovation exemption delay, CoinDesk, Aug 13, 2026](https://www.coindesk.com/policy/2026/08/13/u-s-sec-to-again-delay-innovation-exemption-for-tokenization-amid-wall-street-white-house-concerns)
- [Kraken xStocks metrics and EEA launch, Genfinity, Aug 18, 2026](https://genfinity.io/2026/08/18/kraken-us-stocks-europe-xstocks-trading)
- [LSEG-Payward partnership, Reuters, Sep 1, 2026](https://www.reuters.com/world/uk/lseg-plans-tokenised-uk-shares-partners-with-kraken-owner-payward-2026-09-01)
- [x402 transaction and agent counts, CoinDesk, Aug 23, 2026](https://www.coindesk.com/business/2026/08/23/crypto-s-next-billion-users-might-be-ai-agents-and-they-re-paying-with-stablecoins)
- [x402 volume decline analysis, CCN, Aug 13, 2026](https://www.ccn.com/news/crypto/x402-volume-plunges-cloudflare-ai-agent-payments)
- [Base August ecosystem recap, X, Sep 3, 2026](https://x.com/base/status/2095480324616593599)
- [Coinbase for Agents, Coinbase blog, Jun 11, 2026](https://www.coinbase.com/blog/coinbase-for-agents)
- [Ondo $1B milestone, Cryptonews.net, Aug 15, 2026](https://cryptonews.net/news/finance/33301160)
