import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { McpAgent } from "agents/mcp";
import { withX402, type X402Config } from "agents/x402";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { paymentMiddleware } from "@x402/hono";
import { createFacilitatorConfig } from "@coinbase/x402";
import { Hono } from "hono";
import { z } from "zod";
import { scanPolymarketEvent, scanPolymarketMarkets } from "./polymarket";
import { scanCrossPlatformMarkets } from "./kalshi";
import { scanRebalanceOpportunities, scanTrendingMarkets } from "./rebalance";
import { oddsFeed, volumeAnalytics, resolutionHistory, kalshiMarkets } from "./data-products";
import { queryThreatCatalog, queryMcpIocs, scoreTrifecta, getPolicyTemplates } from "./security-products";
import { searchCourtOpinions, lookupCourtDocket, searchFederalRegister, searchRegulations, searchPatents } from "./legal-products";
import { searchPapers, searchArxiv, searchPubmed, searchClinicalTrials, searchOpenAlex } from "./academic-products";
import { searchDrugRecalls, searchAdverseEvents, searchProductRecalls, searchVehicleRecalls, searchDrugLabels } from "./health-products";
import { getWildfires, getWeatherAlerts, getTideData, getSpaceWeather, getWaterLevels } from "./env-products";
import { searchFederalSpending, getNationalDebt, searchFederalGrants, searchLobbyingRecords, searchNonprofitFilings, getEconomicIndicators } from "./gov-products";
import { queryGeoPulse, queryFlightIntel, queryResearchPack, queryScenarioVerdict, queryWeatherBias, querySupplyStress, queryRegulatoryPulse, queryAttentionMomentum, querySec8kVelocity, queryFredSurprises, queryTreasuryDts, queryGithubTrending, queryHnFrontpage, queryUsgsQuakes, queryOpenAq } from "./osint-products";
import { scrapeUrl, enrichDomain } from "./scraper";
import { scrubContactPayload, scrubText } from "./pii-scrub";
import { getCachedOrLive, kvListKeys, _PREFIX } from "./cache.js";
import { runAllFeedWarms } from "./scheduler.js";
import { mcpGetCachedOrLive } from "./mcp-cache.js";
import { fetchGithubTrending } from "./feeds/github-trending.js";
import { fetchHnFrontpage } from "./feeds/hn-frontpage.js";
import { fetchUsgsQuakes } from "./feeds/usgs-quake.js";
import { fetchOpenAq } from "./feeds/openaq-air.js";
import { searchEdgarFilings, getInsiderTrades, getFredSeries } from "./finance-products";
import { scanCombinatorialArb, getOrderbookImbalance, getSmartMoney } from "./polymarket-advanced";
import { searchCVEs, searchCompanies } from "./security-products-extra";
import { searchReddit, getRepoIntel } from "./social-products";
import { getExchangeRates, getBusinessDays } from "./utility-products";
import { searchJudges, searchTrademarks } from "./legal-products";
import { searchDiseaseOutbreaks, searchFoodSafety } from "./health-products";
import { searchFederalContracts } from "./gov-products";
import { getPaperDetails, getCitationGraph } from "./academic-products";
import { genVideoIntel, modelSettingsLookup } from "./gen-video-products";
import { getSpaceWeatherKp, getWeatherForecast, getWeatherCurrent, getAuroraForecast, getMarineConditions, getAirQualityIndex, getPostalLookup, getIpGeolocation, getTimezoneCurrent, getAirportStatus, getDnsRecords, getIsbnLookup, getCryptoPrice, getBtcBalance, getBtcFees, getFoodRecalls } from "./quick-tools";

// Environment-driven config — production defaults, overridable via process.env vars
// Base Sepolia testnet: chain 84532, USDC at 0x1a35EE5c47503e1B627338D2c1943774f2E50B6D
const PAYAI_FACILITATOR_URL = "https://facilitator.payai.network";
const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const hasCdpCredentials = Boolean(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET);

const SERVICE = {
  name: "agenttoll.dev",
  slug: "tollbooth",
  version: "0.12.0",
  origin: process.env.X402_ORIGIN ?? "https://agenttoll.dev",
  mcpPath: "/mcp",
  description: "Paid MCP and HTTP tools for prediction market intelligence, OSINT feeds, legal/regulatory data, academic research, public health, environmental data, and government spending — all on Base USDC.",
  seller: (process.env.X402_SELLER as `0x${string}`) ?? "0x62a0D3d9DF0dE8804983009949c714EaeAFd87F1",
  network: (process.env.X402_NETWORK as `${string}:${string}`) ?? "eip155:8453",
  networkName: process.env.X402_NETWORK_NAME ?? "Base mainnet",
  usdc: (process.env.X402_USDC as `0x${string}`) ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  facilitator: process.env.X402_FACILITATOR ?? (hasCdpCredentials ? CDP_FACILITATOR_URL : PAYAI_FACILITATOR_URL),
} as const;

const TOOLS = [
  {
    name: "scrape",
    price_usd: "0.01",
    description: "Fetch a URL and return title, description, meta tags, headings, links, text, and tech signals.",
    input: { url: "string, include https://" },
    example: { url: "https://example.com" },
  },
  {
    name: "detect_stack",
    price_usd: "0.02",
    description: "Fingerprint a URL for framework, analytics, hosting, payment, CRM, and site-platform signals.",
    input: { url: "string, include https://" },
    example: { url: "https://stripe.com" },
  },
  {
    name: "extract_contacts",
    price_usd: "0.02",
    description: "Extract visible emails, phone-like strings, social links, and contact/about/pricing/careers URLs from a page.",
    input: { url: "string, include https://" },
    example: { url: "https://example.com" },
  },
  {
    name: "score_lead",
    price_usd: "0.03",
    description: "Score a company domain for outbound fit using HTTPS, DNS, tech stack, contact paths, social links, platform, and copy depth.",
    input: { domain: "string, example stripe.com" },
    example: { domain: "stripe.com" },
  },
  {
    name: "check_agent_policy",
    price_usd: "0.01",
    description: "Check robots.txt, llms.txt, security.txt, and agent.json for crawl/discovery signals before an agent touches a site.",
    input: { domain: "string, example example.com" },
    example: { domain: "example.com" },
  },
  {
    name: "find_agent_resource",
    price_usd: "0.01",
    description: "Search a small curated atlas of agent-useful APIs, self-hosted tools, payment rails, scraping helpers, and automation primitives.",
    input: { query: "string", category: "optional string" },
    example: { query: "open source CRM", category: "sales" },
  },
  {
    name: "validate_agent_manifest",
    price_usd: "0.03",
    description: "Validate an agent manifest for required identity, endpoint, tools, pricing, and payment fields.",
    input: { manifest_json: "JSON string" },
    example: { manifest_json: "{...}" },
  },
  {
    name: "enrich_lead",
    price_usd: "0.05",
    description: "Enrich a company domain with site metadata, tech stack, social links, DNS, platform cues, and contact links.",
    input: { domain: "string, example stripe.com" },
    example: { domain: "stripe.com" },
  },
  {
    name: "polymarket_event_scan",
    price_usd: "0.03",
    description: "Scan one live Polymarket negRisk event for fee-adjusted outcome-sum violations.",
    input: { slug: "Polymarket event slug", min_edge: "optional decimal, default 0.02", min_liquidity: "optional USD, default 1000" },
    example: { slug: "democratic-presidential-nominee-2028", min_edge: "0.02", min_liquidity: "1000" },
    http_path: "/paid/polymarket/event-scan",
  },
  {
    name: "polymarket_market_scan",
    price_usd: "0.05",
    description: "Scan high-volume active Polymarket markets for resolution candidates and fee-adjusted YES+NO bundle violations.",
    input: { limit: "optional integer 10-200", min_certainty: "optional decimal, default 0.95", min_edge: "optional decimal, default 0.02" },
    example: { limit: "100", min_certainty: "0.95", min_edge: "0.02" },
    http_path: "/paid/polymarket/market-scan",
  },
  {
    name: "cross_platform_arb_scan",
    price_usd: "0.10",
    description: "Match live Polymarket and Kalshi markets for a topic, compare complementary top-of-book asks, and report fee-adjusted cross-platform spread candidates.",
    input: { query: "required topic, entity, or asset", min_similarity: "optional decimal, default 0.62", min_net_edge: "optional decimal, default 0.015", kalshi_max_pages: "optional integer 1-20" },
    example: { query: "bitcoin", min_similarity: "0.62", min_net_edge: "0.015", kalshi_max_pages: "12" },
    http_path: "/paid/markets/cross-platform-scan",
  },
  {
    name: "rebalance_arb_scan",
    price_usd: "0.04",
    description: "Scan Polymarket for single-market rebalance arbitrage: YES+NO pricing violations where guaranteed profit exists. Returns long and short opportunities with confidence scores.",
    input: { limit: "optional, default 500, max 2000", min_edge: "optional decimal, default 0.005", min_liquidity: "optional integer, default 1000" },
    example: { limit: 500, min_edge: 0.005 },
    http_path: "/paid/polymarket/rebalance-scan",
  },
  {
    name: "trending_markets",
    price_usd: "0.02",
    description: "Get top trending Polymarket markets by 24h volume. Includes current prices, liquidity, and volume data. Perfect for market discovery and signal generation.",
    input: { limit: "optional, default 20, max 100", category: "optional, e.g. politics, sports, crypto" },
    example: { limit: 20 },
    http_path: "/paid/polymarket/trending",
  },
  {
    name: "odds_feed",
    price_usd: "0.02",
    description: "Normalized live odds across Polymarket and Kalshi in a single JSON response. YES/NO prices, spreads, volume, and liquidity for cross-platform comparison.",
    input: { limit: "optional, default 30, max 100", platform: "optional: polymarket, kalshi, or both (default)" },
    example: { limit: 30, platform: "both" },
    http_path: "/paid/odds/feed",
  },
  {
    name: "volume_analytics",
    price_usd: "0.03",
    description: "Top Polymarket markets ranked by 24h volume with liquidity, total volume, current price, and 24h price change. Market momentum and flow analytics.",
    input: { limit: "optional, default 30, max 100", min_volume: "optional integer, default 1000" },
    example: { limit: 30, min_volume: 5000 },
    http_path: "/paid/polymarket/volume-analytics",
  },
  {
    name: "resolution_history",
    price_usd: "0.03",
    description: "Recently resolved Polymarket markets with final outcomes, resolution dates, and volumes. Essential for backtesting strategies and model calibration.",
    input: { limit: "optional, default 30, max 100", days_back: "optional integer, default 7" },
    example: { limit: 30, days_back: 7 },
    http_path: "/paid/polymarket/resolution-history",
  },
  {
    name: "kalshi_markets",
    price_usd: "0.02",
    description: "Live Kalshi market list with bid/ask spreads, volume, open interest, and close dates. CFTC-regulated prediction market data for agents.",
    input: { limit: "optional, default 30, max 100", category: "optional event ticker filter" },
    example: { limit: 30 },
    http_path: "/paid/kalshi/markets",
  },
  {
    name: "agent_threat_intel",
    price_usd: "0.03",
    description: "Query the OWASP Agentic Top 10 threat catalog (ASI01-ASI10). Returns threats, detection hints, mitigations, and mapped agent-security rule IDs. CC BY-SA 4.0 (OWASP derivative).",
    input: { category: "optional: e.g. 'prompt injection', 'supply chain'", id: "optional: e.g. ASI04", severity: "optional: critical, high, medium" },
    example: { category: "supply chain" },
    http_path: "/paid/security/threat-intel",
  },
  {
    name: "mcp_supply_chain_iocs",
    price_usd: "0.02",
    description: "Query known-malicious MCP packages, versions, C2 hosts, and email IOCs. Updated as new supply-chain incidents break. The virus database for MCP.",
    input: { package: "optional: npm package name", host: "optional: C2 host" },
    example: {},
    http_path: "/paid/security/mcp-iocs",
  },
  {
    name: "agent_trifecta_score",
    price_usd: "0.05",
    description: "Score an agent's lethal trifecta risk: private data + untrusted content + outbound actions. Returns risk level, missing controls, and decomposition advice. Based on Simon Willison / CSA methodology.",
    input: { has_private_data: "boolean", has_untrusted_content: "boolean", has_outbound_actions: "boolean", compensating_controls: "array of control names" },
    example: { has_private_data: true, has_untrusted_content: true, has_outbound_actions: true, compensating_controls: ["redact_secrets", "smart_approvals"] },
    http_path: "/paid/security/trifecta-score",
  },
  {
    name: "agent_security_policies",
    price_usd: "0.05",
    description: "Get drop-in agent security policy templates by profile (coding-agent, browser-agent, payment-agent, research-agent). YAML-style rules with conditions and actions. MIT/CC BY-SA.",
    input: { profile: "optional: coding-agent, browser-agent, payment-agent, research-agent" },
    example: { profile: "payment-agent" },
    http_path: "/paid/security/policies",
  },
  // ── OSINT Layer v0.9: 8 pillars mirror — OSINT stack ──────────────────
  {
    name: "geo_intervention_pulse",
    price_usd: "0.05",
    description: "Composite geo/military tension signal: GDELT + BBC/AlJazeera RSS + adsb.lol/mil + Polymarket correlation, 60min window, booster math (multi-source + thermal + vessel + mil-aircraft). intervention signal pattern, free sources.",
    input: { region: "optional: global, middle_east, ukraine, taiwan; default global", min_confidence: "optional decimal 0-1 default 0.6", hours_back: "optional 1-72 default 6", include_thermal: "optional bool default true" },
    example: { region: "middle_east", min_confidence: "0.7", hours_back: "6" },
    http_path: "/paid/osint/geo-pulse",
  },
  {
    name: "flight_intel",
    price_usd: "0.02",
    description: "Live military/exec jet intel via adsb.lol v2/mil (community fork of ADS-B Exchange). TEB/VNY/DCA geofencing for M&A meeting proxy, B-52/F-35/E-3/KC-135 notable detection. Free no-key.",
    input: { airport_code: "optional e.g. TEB, VNY, DCA, IAD, OPF, DAL, OAK, LAS", tail_number: "optional hex or callsign filter", hours_back: "optional 1-72 default 12" },
    example: { airport_code: "TEB", hours_back: "12" },
    http_path: "/paid/osint/flight-intel",
  },
  {
    name: "osint_research_pack",
    price_usd: "0.04",
    description: "Research pack literature discovery factory: GDELT + BBC RSS + HN Algolia + Reddit JSON in parallel, 4-layer verification (existence + recency + multi-source corr + allowlist), combined_score ranking. provenance tagged.",
    input: { topic: "required query string", domains: "optional array of domains to filter", include_sources: "optional array: gdelt, bbc, hn, reddit, all", hours_back: "optional 1-720 default 72" },
    example: { topic: "Iran refinery drone strike", include_sources: "all", hours_back: "24" },
    http_path: "/paid/osint/research-pack",
  },
  {
    name: "scenario_verdict",
    price_usd: "0.05",
    description: "Scenario engine 3-scenario verdict.json: seed -> entity extract -> escalation score -1..1 -> bear/base/bull probs sum 1.0 -> composite YES prob + fair price hint + key_drivers. Optional GDELT enrichment. For prediction market composite.",
    input: { seed_text: "required raw OSINT snippet text", market_question: "required Polymarket/Kalshi question", context: "optional extra context" },
    example: { seed_text: "2x tanker attacked near Hormuz, IRGC speedboats reported...", market_question: "Will oil price exceed $95 by July 20?" },
    http_path: "/paid/osint/scenario-verdict",
  },
  {
    name: "weather_bias_score",
    price_usd: "0.03",
    description: "Kalshi weather fix: Open-Meteo archive vs forecast bias, ensemble mean anomaly, ticker mapping HIGHNY/HIGHCHI/HIGHMIA date %y%b%d uppercase, subtitle parser. Replaces hardcoded C:/ student repo with CC BY 4.0 free feed.",
    input: { city: "required city code: NYC, CHI, MIA, LA, etc", model: "optional model hint", days_back: "optional 2-30 default 7" },
    example: { city: "NYC", days_back: "7" },
    http_path: "/paid/osint/weather-bias",
  },
  {
    name: "supply_chain_stress",
    price_usd: "0.03",
    description: "Port/chokepoint stress composite: CBP BWT gov API + GDELT choke mentions + AIS chokepoint heuristic + BTS/AAR hints, index 0-95. Trade lead 2-5d freight spike per intervention signal math. Free gov no-key.",
    input: { ports: "optional array LAX,NYC,HOU etc", chokepoints: "optional array hormuz, bab-el-mandeb, suez, bosphorus, malacca" },
    example: { ports: "LAX,NYC", chokepoints: "hormuz,suez" },
    http_path: "/paid/osint/supply-stress",
  },
  {
    name: "regulatory_pulse",
    price_usd: "0.03",
    description: "FDA adverse + trials status + USPTO trademark bulk + FCC OET + FAA registry + SEC enforcement — regulatory momentum for bio/tech Polymarkets. SEC Atom + openFDA free no-key.",
    input: { org: "optional: all, sec, fda, uspto, fcc, faa; default all", hours_back: "optional 1-720 default 24" },
    example: { org: "sec", hours_back: "24" },
    http_path: "/paid/osint/regulatory-pulse",
  },
  {
    name: "attention_momentum",
    price_usd: "0.02",
    description: "HN frontpage + Reddit velocity + pypistats/npm/crates hint: momentum_score = vel*0.6 + score/100*0.3 + comments/50*0.1, viral flag. For culture/tech/popularity prediction markets.",
    input: { query: "optional search term", window: "optional 1h,6h,24h default 6h" },
    example: { query: "Claude Code", window: "6h" },
    http_path: "/paid/osint/attention-momentum",
  },
  {
    name: "sec_8k_velocity",
    price_usd: "0.03",
    description: "SEC EDGAR 8-K velocity: EFTS full-text + Atom current Atom, 1h spike vs 24h mean >3x. Boost Items 1.05/2.02/5.02. Earnings/merger/legal prediction market lead. 9/sec TokenBucket, CompanyName UA per 17 CFR 200.80.",
    input: { hours: "optional 1-72 default 6", min_score: "optional 0-1", limit: "optional 10-200 default 100" },
    example: { hours: "6", limit: "100" },
    http_path: "/paid/osint/sec-8k-velocity",
  },
  {
    name: "fred_surprises",
    price_usd: "0.02",
    description: "FRED no-auth CSV free public-domain rates: DGS10 10Y + DGS2 2Y spread, 10Y-2Y inversion flag, delta scoring. For Kalshi FOMC Fed funds + rates markets. TokenBucket 2/s polite.",
    input: { days: "optional 5-90 default 14", min_score: "optional 0-1" },
    example: { days: "14" },
    http_path: "/paid/osint/fred-surprises",
  },
  {
    name: "treasury_dts",
    price_usd: "0.04",
    description: "Treasury DTS TGA operating_cash_balance free gov public-domain: TGA close $B, d/d delta, deposits/withdrawals enrichment, score by balance <400B stress 0.85 + delta boost. Liquidity / debt-ceiling / SPX direction edge, 2nd upstream deposits_withdrawals.",
    input: { days: "optional 2-30 default 7", min_score: "optional 0-1" },
    example: { days: "7" },
    http_path: "/paid/osint/treasury-dts",
  },
  // ── Extra public feeds (v1.0) ──────────────────────────────────────
  {
    name: "openrouter_models",
    price_usd: "0.02",
    description: "OpenRouter model catalog — id, name, context_length, pricing, created. Popular LLM registry snapshot for model routing decisions. Cached 1h, auto-fetched via public API.",
    input: { limit: "optional int 10-300 default 100", min_context: "optional int min context length" },
    example: { limit: "100" },
    http_path: "/paid/osint/openrouter-models",
  },
  {
    name: "github_trending",
    price_usd: "0.02",
    description: "GitHub trending repos — stars >20 + recent push in last 7d, sorted by stars desc, paged. Public GitHub Search API no-key. Momentum proxy for dev tooling / open source virality.",
    input: { limit: "optional int 5-50 default 25", language: "optional e.g. TypeScript, Python, Rust", since_days: "optional 1-90 default 7" },
    example: { limit: "25", language: "TypeScript" },
    http_path: "/paid/osint/github-trending",
  },
  {
    name: "hn_frontpage",
    price_usd: "0.02",
    description: "HN frontpage live — Algolia front_page tag, points, comments, author, dwell = points/(age_h+2). Cache 10min. Top stories sorted by dwell score for attention-momentum edge.",
    input: { limit: "optional int 5-50 default 30", min_points: "optional int min points" },
    example: { limit: "30" },
    http_path: "/paid/osint/hn-frontpage",
  },
  {
    name: "usgs_quake",
    price_usd: "0.02",
    description: "USGS all-day earthquakes — mag, place, time, tsunami, felt, coords, depth. Public USGS GeoJSON no-key. Disaster / insurance / commodity market tail-risk pulse.",
    input: { limit: "optional int 5-200 default 50", min_mag: "optional float e.g. 2.5" },
    example: { limit: "50", min_mag: "2.5" },
    http_path: "/paid/osint/usgs-quake",
  },
  {
    name: "openaq_air",
    price_usd: "0.02",
    description: "OpenAQ air quality — PM2.5/PM10/NO2/O3 readings by city/country, lastUpdated, sensor counts. v3 API + v2 fallback. Env / health / geo pulse + PM market disclaimer.",
    input: { limit: "optional int 5-100 default 30", country: "optional ISO country code e.g. US" },
    example: { limit: "30", country: "US" },
    http_path: "/paid/osint/openaq-air",
  },
  // ── Legal & Regulatory (v0.11.0) ──────────────────────────────────
  {
    name: "court_opinions",
    price_usd: "0.05",
    description: "Search US federal court opinions by keyword, court, date via CourtListener (Free Law Project). Keyless public API.",
    input: { query: "string search terms", court: "optional e.g. 'scotus', 'ca9'", days_back: "optional int, default 90" },
    example: { query: "copyright fair use" },
    http_path: "/paid/legal/court-opinions",
  },
  {
    name: "court_docket",
    price_usd: "0.05",
    description: "Look up a federal court docket by ID via CourtListener RECAP archive. Parties, filings, dates.",
    input: { docket_id: "string docket ID" },
    example: { docket_id: "6789012" },
    http_path: "/paid/legal/court-docket",
  },
  {
    name: "federal_register",
    price_usd: "0.03",
    description: "Search the daily Federal Register — proposed rules, final rules, presidential notices, agency actions.",
    input: { query: "string search terms", agency: "optional e.g. 'SEC', 'EPA'", type: "optional 'RULE', 'NOTICE', 'PRORULE'" },
    example: { query: "climate emissions", agency: "EPA" },
    http_path: "/paid/legal/federal-register",
  },
  {
    name: "patents_search",
    price_usd: "0.04",
    description: "Full-text patent search via Google Patents. Returns titles, assignees, dates, abstracts.",
    input: { query: "string patent search terms", limit: "optional int 5-50 default 20" },
    example: { query: "large language model inference optimization" },
    http_path: "/paid/legal/patents",
  },
  {
    name: "regulations_search",
    price_usd: "0.03",
    description: "Search open rulemakings and public dockets. Falls back to Federal Register if no API key configured.",
    input: { query: "string search terms", status: "optional e.g. 'open', 'closed'" },
    example: { query: "net neutrality" },
    http_path: "/paid/legal/regulations",
  },
  // ── Academic & Scientific (v0.11.0) ───────────────────────────────
  {
    name: "search_papers",
    price_usd: "0.04",
    description: "Search 226M+ academic papers across all fields with AI-ranked relevance via Semantic Scholar Graph API.",
    input: { query: "string research query", limit: "optional int 5-50 default 20" },
    example: { query: "transformer attention mechanisms" },
    http_path: "/paid/academic/papers",
  },
  {
    name: "search_arxiv",
    price_usd: "0.02",
    description: "Search arXiv preprints in CS, physics, math, biology. Returns titles, authors, abstracts, categories.",
    input: { query: "string search terms", category: "optional e.g. 'cs.CL', 'physics'", limit: "optional int 5-50 default 20" },
    example: { query: "mixture of experts", category: "cs.LG" },
    http_path: "/paid/academic/arxiv",
  },
  {
    name: "search_pubmed",
    price_usd: "0.03",
    description: "Search 37M+ biomedical papers via NCBI PubMed. Returns PMIDs, titles, authors, journals.",
    input: { query: "string biomedical query", limit: "optional int 5-50 default 20" },
    example: { query: "CRISPR gene therapy clinical trials" },
    http_path: "/paid/academic/pubmed",
  },
  {
    name: "clinical_trials",
    price_usd: "0.04",
    description: "Search 480K+ clinical studies via ClinicalTrials.gov v2. Status, sponsors, phases, results links.",
    input: { query: "string trial query", status: "optional e.g. 'RECRUITING', 'COMPLETED'", limit: "optional int 5-50 default 20" },
    example: { query: "CAR-T cell therapy", status: "RECRUITING" },
    http_path: "/paid/academic/clinical-trials",
  },
  {
    name: "search_openalex",
    price_usd: "0.03",
    description: "Search 250M+ works via OpenAlex with institution data, bibliometrics, citation counts, open access links.",
    input: { query: "string research query", limit: "optional int 5-50 default 20" },
    example: { query: "carbon capture sequestration" },
    http_path: "/paid/academic/openalex",
  },
  // ── Public Health & Safety (v0.11.0) ──────────────────────────────
  {
    name: "drug_recalls",
    price_usd: "0.03",
    description: "Search FDA drug/device/food enforcement recalls — severity, classification, recalling firm, product details.",
    input: { query: "optional string search terms", limit: "optional int 5-50 default 20" },
    example: { query: "acetaminophen" },
    http_path: "/paid/health/drug-recalls",
  },
  {
    name: "adverse_events",
    price_usd: "0.04",
    description: "Search 20M+ FDA adverse drug event reports via openFDA. Patient outcomes, drugs, reactions.",
    input: { drug: "string drug name", limit: "optional int 5-50 default 20" },
    example: { drug: "aspirin" },
    http_path: "/paid/health/adverse-events",
  },
  {
    name: "product_recalls",
    price_usd: "0.03",
    description: "Search CPSC consumer product recalls via saferproducts.gov — hazards, manufacturers, remedies.",
    input: { query: "optional string product search", limit: "optional int 5-50 default 20" },
    example: { query: "lithium battery" },
    http_path: "/paid/health/product-recalls",
  },
  {
    name: "vehicle_recalls",
    price_usd: "0.03",
    description: "Search NHTSA vehicle recalls by make, model, or VIN. Campaign numbers, defect descriptions, remedies.",
    input: { make: "optional e.g. 'Toyota'", model: "optional e.g. 'Camry'", vin: "optional 17-char VIN" },
    example: { make: "Ford", model: "F-150" },
    http_path: "/paid/health/vehicle-recalls",
  },
  {
    name: "drug_labels",
    price_usd: "0.03",
    description: "Search official FDA drug labels via openFDA — dosage, warnings, contraindications, active ingredients.",
    input: { drug_name: "string drug name", limit: "optional int 5-50 default 10" },
    example: { drug_name: "metformin" },
    http_path: "/paid/health/drug-labels",
  },
  // ── Environmental & Climate (v0.11.0) ─────────────────────────────
  {
    name: "wildfires",
    price_usd: "0.03",
    description: "Active wildfire detections from NASA FIRMS satellites — lat/lon, brightness, confidence, scan time.",
    input: { limit: "optional int 10-100 default 50", region: "optional e.g. 'us-west', 'california'" },
    example: { region: "california" },
    http_path: "/paid/env/wildfires",
  },
  {
    name: "weather_alerts",
    price_usd: "0.02",
    description: "Active NOAA NWS severe weather alerts — watches, warnings, advisories by state or zone. Event type, urgency, severity.",
    input: { state: "optional 2-letter state code e.g. 'CA'", zone: "optional NWS zone ID" },
    example: { state: "TX" },
    http_path: "/paid/env/weather-alerts",
  },
  {
    name: "tide_data",
    price_usd: "0.03",
    description: "NOAA tide predictions and observed water levels for coastal stations. Datums, units, time series.",
    input: { station: "optional NOAA station ID e.g. '8443970'", date: "optional YYYYMMDD" },
    example: { station: "8443970" },
    http_path: "/paid/env/tides",
  },
  {
    name: "space_weather",
    price_usd: "0.02",
    description: "NOAA space weather data — solar flares, geomagnetic storms, solar wind speed, Kp index.",
    input: { type: "optional 'planetary_k_index', 'solar_wind', 'flare'", days: "optional int 1-7 default 1" },
    example: { type: "planetary_k_index" },
    http_path: "/paid/env/space-weather",
  },
  {
    name: "water_levels",
    price_usd: "0.03",
    description: "Real-time USGS river/stream flow and flood data — gauge height, discharge, percentiles by state.",
    input: { state: "optional 2-letter state code", parameter_code: "optional USGS param code, default '00060' (streamflow)" },
    example: { state: "ND" },
    http_path: "/paid/env/water-levels",
  },
  // ── Government Spending & Contracts (v0.11.0) ─────────────────────
  {
    name: "federal_spending",
    price_usd: "0.04",
    description: "Search $6T+ federal budget by agency, recipient, or keyword via USAspending.gov API. Awards, amounts, locations.",
    input: { agency: "optional string e.g. 'Department of Defense'", recipient: "optional string", limit: "optional int 5-50 default 20" },
    example: { agency: "Department of Defense" },
    http_path: "/paid/gov/federal-spending",
  },
  {
    name: "national_debt",
    price_usd: "0.02",
    description: "US national debt to the penny via Treasury FiscalData. Total debt, debt by instrument, fiscal year data.",
    input: {},
    example: {},
    http_path: "/paid/gov/national-debt",
  },
  {
    name: "federal_grants",
    price_usd: "0.03",
    description: "Search Grants.gov for open federal funding opportunities — agency, eligibility, deadline, award ceiling.",
    input: { query: "optional string keyword search", status: "optional 'open', 'forecasted'", limit: "optional int 5-50 default 20" },
    example: { query: "artificial intelligence research", status: "open" },
    http_path: "/paid/gov/federal-grants",
  },
  {
    name: "nonprofit_filings",
    price_usd: "0.03",
    description: "Search nonprofit IRS 990 filings via ProPublica Nonprofit Explorer — revenue, expenses, executive compensation.",
    input: { query: "string organization name", state: "optional 2-letter state code" },
    example: { query: "Gates Foundation" },
    http_path: "/paid/gov/nonprofits",
  },
  {
    name: "economic_indicators",
    price_usd: "0.03",
    description: "GDP, CPI, unemployment, trade data via World Bank API. Multi-year time series for any country.",
    input: { country: "optional ISO code e.g. 'US'", indicator: "optional e.g. 'NY.GDP.MKTP.CD' (GDP)" },
    example: { country: "US", indicator: "NY.GDP.MKTP.CD" },
    http_path: "/paid/gov/economic-indicators",
  },
  {
    name: "lobbying_records",
    price_usd: "0.04",
    description: "Search FEC lobbying disclosure records — lobbyists, clients, amounts, issues lobbied. Via FEC API.",
    input: { lobbyist: "optional string name", client: "optional string org name", year: "optional int 4-digit year" },
    example: { client: "Google", year: 2024 },
    http_path: "/paid/gov/lobbying",
  },
  // ── Finance (v0.14) ──────────────────────────────────────────────
  {
    name: "edgar_filings",
    price_usd: "0.03",
    description: "Search SEC EDGAR full-text filings by company, form type (10-K, 10-Q, 8-K), or ticker. Returns filing URLs, dates, and descriptions.",
    input: { query: "string company name or keyword", form_type: "optional: 10-K, 10-Q, 8-K, S-1", ticker: "optional stock ticker" },
    example: { query: "Tesla", form_type: "10-K" },
    http_path: "/paid/finance/edgar",
  },
  {
    name: "insider_trades",
    price_usd: "0.03",
    description: "SEC Form 4 insider transactions — buy/sell by executives and large shareholders. Returns ticker, transaction type, shares, value, date.",
    input: { ticker: "optional stock ticker e.g. AAPL", limit: "optional int 5-50" },
    example: { ticker: "AAPL" },
    http_path: "/paid/finance/insider-trades",
  },
  {
    name: "fred_series",
    price_usd: "0.02",
    description: "FRED economic data series — GDP, CPI, unemployment, interest rates, and 800K+ other economic indicators from the St. Louis Fed.",
    input: { series_id: "optional e.g. GDP, UNRATE, DGS10", limit: "optional int 5-100" },
    example: { series_id: "GDP" },
    http_path: "/paid/finance/fred",
  },
  {
    name: "combinatorial_arb",
    price_usd: "0.06",
    description: "Scan Polymarket negRisk events for combinatorial arbitrage across dependency-linked outcomes. Detect mispriced multi-leg bundles.",
    input: { limit: "optional int 5-50 default 20" },
    example: {},
    http_path: "/paid/polymarket/combinatorial-arb",
  },
  {
    name: "orderbook_imbalance",
    price_usd: "0.04",
    description: "Polymarket CLOB orderbook imbalance — top-of-book bid/ask depth ratio, directional pressure signal for any market.",
    input: { token_id: "optional Polymarket token ID", condition_id: "optional condition ID", limit: "optional int 5-50" },
    example: {},
    http_path: "/paid/polymarket/orderbook-imbalance",
  },
  {
    name: "smart_money",
    price_usd: "0.05",
    description: "Polymarket leaderboard and top trader activity. Track profitable wallets, their current positions, and flow direction.",
    input: { limit: "optional int 5-50", timeframe: "optional: 7d, 30d, all" },
    example: { timeframe: "30d" },
    http_path: "/paid/polymarket/smart-money",
  },
  {
    name: "cve_search",
    price_usd: "0.02",
    description: "Search NIST NVD CVE database by keyword, CVE ID, or severity. Returns CVE ID, description, CVSS score, affected products, references.",
    input: { keyword: "optional search term", cve_id: "optional e.g. CVE-2024-1234", severity: "optional: LOW, MEDIUM, HIGH, CRITICAL" },
    example: { keyword: "log4j" },
    http_path: "/paid/security/cve-search",
  },
  {
    name: "company_registry",
    price_usd: "0.03",
    description: "Search company registries by name. Returns jurisdiction, status, filing history, officers, registered address.",
    input: { query: "string company name", jurisdiction: "optional e.g. US, UK, EU" },
    example: { query: "OpenAI" },
    http_path: "/paid/security/company-registry",
  },
  {
    name: "reddit_search",
    price_usd: "0.02",
    description: "Search Reddit posts and comments by keyword, subreddit, or sort. Returns titles, scores, comment counts, URLs, top replies.",
    input: { query: "string search terms", subreddit: "optional e.g. technology", sort: "optional: relevance, hot, new, top", limit: "optional int 5-50" },
    example: { query: "AI agents", sort: "hot" },
    http_path: "/paid/social/reddit",
  },
  {
    name: "github_repo_intel",
    price_usd: "0.03",
    description: "GitHub repo intelligence — stars, forks, contributors, languages, commit activity, release history, open issues, dependency stats.",
    input: { repo: "string owner/repo e.g. facebook/react" },
    example: { repo: "anthropics/anthropic-quickstarts" },
    http_path: "/paid/social/github-repo",
  },
  {
    name: "currency_rates",
    price_usd: "0.01",
    description: "Live currency exchange rates. 160+ currencies, crypto rates. Base/target conversion.",
    input: { base: "optional 3-letter code e.g. USD", target: "optional e.g. EUR, JPY, BTC" },
    example: { base: "USD", target: "EUR" },
    http_path: "/paid/utility/currency",
  },
  {
    name: "business_days",
    price_usd: "0.01",
    description: "Calculate business days between dates, excluding weekends and US federal holidays. Useful for contract deadlines and settlement timing.",
    input: { start_date: "optional YYYY-MM-DD", end_date: "optional YYYY-MM-DD", days_ahead: "optional int — count N business days from start" },
    example: { days_ahead: 10 },
    http_path: "/paid/utility/business-days",
  },
  {
    name: "judges_search",
    price_usd: "0.04",
    description: "Search federal and state judges via CourtListener. Returns name, court, appointment date, political party, education, bar memberships.",
    input: { query: "string judge name", court: "optional e.g. scotus, ca9" },
    example: { query: "Gorsuch" },
    http_path: "/paid/legal/judges",
  },
  {
    name: "trademarks_search",
    price_usd: "0.03",
    description: "Search USPTO trademark database. Returns mark, owner, filing date, status, registration number, goods/services classes.",
    input: { query: "string trademark or brand name", owner: "optional owner name" },
    example: { query: "ChatGPT" },
    http_path: "/paid/legal/trademarks",
  },
  {
    name: "disease_outbreaks",
    price_usd: "0.03",
    description: "CDC disease outbreak data. Outbreak location, pathogen, cases, deaths, investigation status.",
    input: { query: "optional pathogen or location", limit: "optional int 5-50" },
    example: {},
    http_path: "/paid/health/outbreaks",
  },
  {
    name: "food_safety",
    price_usd: "0.02",
    description: "Search openFDA food enforcement actions — food recalls, contamination events, seizure actions, warning letters.",
    input: { query: "optional food product or brand", limit: "optional int 5-50" },
    example: { query: "peanut butter" },
    http_path: "/paid/health/food-safety",
  },
  {
    name: "federal_contracts",
    price_usd: "0.04",
    description: "Search federal contracts via USAspending.gov. Awarding agency, recipient, amount, description, NAICS code, contract number.",
    input: { query: "optional keyword", agency: "optional e.g. DoD, NASA", limit: "optional int 5-50" },
    example: { agency: "NASA" },
    http_path: "/paid/gov/contracts",
  },
  {
    name: "paper_details",
    price_usd: "0.02",
    description: "Get detailed metadata for a single academic paper. Abstract, authors, venue, citation count, influential citations, TLDR.",
    input: { paperId: "string paper ID, DOI, or arXiv ID" },
    example: { paperId: "10.1145/3442188.3445922" },
    http_path: "/paid/academic/paper-details",
  },
  {
    name: "citation_graph",
    price_usd: "0.03",
    description: "Get citation graph for a paper. Forward citations (who cited this) or backward (references). Returns paper IDs, titles, contexts.",
    input: { paperId: "string paper ID or DOI", direction: "optional: forward or backward" },
    example: { paperId: "10.1145/3442188.3445922", direction: "forward" },
    http_path: "/paid/academic/citations",
  },
  {
    name: "gen_video_intel",
    price_usd: "0.05",
    description: "Generative video model intelligence — model names, capabilities, pricing, max duration, resolution, API access for Sora, Veo, Runway, Pika.",
    input: { query: "optional model name or capability", model: "optional specific model" },
    example: { query: "text to video" },
    http_path: "/paid/media/gen-video",
  },
  {
    name: "model_settings_lookup",
    price_usd: "0.02",
    description: "Look up recommended settings for generative AI models — temperature, top_p, max tokens, system prompt templates, best practices.",
    input: { model: "string model name e.g. gpt-4o, claude-3.5-sonnet", task: "optional: coding, writing, analysis" },
    example: { model: "gpt-4o", task: "coding" },
    http_path: "/paid/media/model-settings",
  },

  // ── Quick Tools (v0.14 — free no-key APIs) ──────────────────────
  {
    name: "space_weather_kp",
    price_usd: "0.03",
    description: "Current planetary K-index and geomagnetic storm conditions from NOAA SWPC. Aurora prediction, satellite drag, GPS interference signals.",
    input: {},
    example: {},
    http_path: "/paid/env/space-weather-kp",
  },
  {
    name: "weather_forecast_grid",
    price_usd: "0.02",
    description: "Detailed NWS weather forecast for a US lat/lon point. 7-day forecast with temperature, wind, precipitation probability.",
    input: { lat: "number latitude", lon: "number longitude" },
    example: { lat: 40.71, lon: -74.01 },
    http_path: "/paid/env/weather-forecast",
  },
  {
    name: "weather_current_global",
    price_usd: "0.02",
    description: "Current temperature, wind, humidity, precipitation for any global coordinate. Open-Meteo free API.",
    input: { lat: "number latitude", lon: "number longitude", variables: "optional comma-separated weather variables" },
    example: { lat: 52.52, lon: 13.41 },
    http_path: "/paid/env/weather-current",
  },
  {
    name: "aurora_forecast",
    price_usd: "0.03",
    description: "NOAA aurora oval forecast — 30-minute northern/southern lights visibility probability by lat/lon grid.",
    input: {},
    example: {},
    http_path: "/paid/env/aurora",
  },
  {
    name: "marine_conditions",
    price_usd: "0.03",
    description: "Marine conditions for any ocean coordinate — wave height, wave direction, sea surface temperature, wind waves.",
    input: { lat: "number latitude", lon: "number longitude" },
    example: { lat: 35.0, lon: -120.0 },
    http_path: "/paid/env/marine",
  },
  {
    name: "air_quality_index",
    price_usd: "0.03",
    description: "Current PM2.5, UV index, ozone, NO2, SO2 readings for any global location.",
    input: { lat: "number latitude", lon: "number longitude", variables: "optional pollutant variables" },
    example: { lat: 40.71, lon: -74.01 },
    http_path: "/paid/health/air-quality",
  },
  {
    name: "postal_code_lookup",
    price_usd: "0.02",
    description: "City, state, and geo-coordinates for a postal/zip code. Supports 60+ countries via Zippopotam.",
    input: { country: "2-letter ISO code e.g. US, GB, DE", postal_code: "string postal code" },
    example: { country: "US", postal_code: "90210" },
    http_path: "/paid/gov/postal-lookup",
  },
  {
    name: "ip_geolocation",
    price_usd: "0.02",
    description: "Geolocate an IP address — country, region, city, ISP, ASN, coordinates.",
    input: { ip: "string IPv4 or IPv6 address" },
    example: { ip: "8.8.8.8" },
    http_path: "/paid/osint/ip-geo",
  },
  {
    name: "timezone_current",
    price_usd: "0.01",
    description: "Current date/time for any IANA timezone, including DST status and day of week.",
    input: { timezone: "string IANA timezone e.g. America/New_York" },
    example: { timezone: "America/New_York" },
    http_path: "/paid/osint/timezone",
  },
  {
    name: "airport_status",
    price_usd: "0.02",
    description: "Airport details by ICAO code — name, city, country, coordinates, elevation from OpenSky Network.",
    input: { icao: "string ICAO code e.g. KJFK, EGLL" },
    example: { icao: "KJFK" },
    http_path: "/paid/osint/airport",
  },
  {
    name: "dns_records_lookup",
    price_usd: "0.02",
    description: "DNS resolution via Cloudflare DNS-over-HTTPS — A, AAAA, MX, TXT, NS, CNAME records.",
    input: { domain: "string domain name", type: "optional: A, AAAA, MX, TXT, NS, CNAME" },
    example: { domain: "example.com", type: "MX" },
    http_path: "/paid/security/dns-lookup",
  },
  {
    name: "isbn_book_lookup",
    price_usd: "0.02",
    description: "Book metadata by ISBN — title, authors, publisher, page count, cover URL via Open Library.",
    input: { isbn: "string ISBN-10 or ISBN-13" },
    example: { isbn: "9780140328721" },
    http_path: "/paid/academic/isbn",
  },
  {
    name: "crypto_price_simple",
    price_usd: "0.02",
    description: "Current cryptocurrency price in USD or other fiat for any CoinGecko-listed coin.",
    input: { coin: "string coin ID e.g. bitcoin, ethereum, solana", currency: "optional fiat code e.g. usd, eur" },
    example: { coin: "bitcoin", currency: "usd" },
    http_path: "/paid/finance/crypto-price",
  },
  {
    name: "btc_address_balance",
    price_usd: "0.03",
    description: "Bitcoin address details — balance, total received/sent, recent transactions via blockchain.info.",
    input: { address: "string Bitcoin address", limit: "optional int number of txs" },
    example: { address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" },
    http_path: "/paid/finance/btc-balance",
  },
  {
    name: "btc_mempool_fees",
    price_usd: "0.02",
    description: "Recommended Bitcoin network transaction fees — fastest, half-hour, hour, economy tiers via mempool.space.",
    input: {},
    example: {},
    http_path: "/paid/finance/btc-fees",
  },
  {
    name: "food_recall_check",
    price_usd: "0.02",
    description: "Search openFDA food enforcement and recalls by brand or product. Classification, recalling firm, distribution, recall date.",
    input: { query: "optional food brand or product name", limit: "optional int 5-50" },
    example: { query: "Tyson" },
    http_path: "/paid/health/food-recall",
  },
] as const;

const X402_CONFIG: X402Config = {
  network: SERVICE.network,
  recipient: process.env.MCP_ADDRESS as `0x${string}`,
  facilitator: { url: SERVICE.facilitator },
};

class ResilientFacilitatorClient extends HTTPFacilitatorClient {
  override async getSupported(): Promise<Awaited<ReturnType<HTTPFacilitatorClient["getSupported"]>>> {
    try {
      const supported = await super.getSupported();
      if (supported.kinds.some((kind) => kind.x402Version === 2 && kind.scheme === "exact" && kind.network === SERVICE.network)) {
        return supported;
      }
    } catch (error) {
      console.warn("Facilitator /supported failed; using exact Base capability fallback", error);
    }
    return {
      kinds: [{ x402Version: 2, scheme: "exact", network: SERVICE.network }],
      extensions: ["bazaar"],
      signers: {},
    };
  }
}

function createFacilitatorClientConfig() {
  if (SERVICE.facilitator === CDP_FACILITATOR_URL) {
    return createFacilitatorConfig(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET);
  }
  return { url: SERVICE.facilitator };
}

const httpFacilitator = new ResilientFacilitatorClient(createFacilitatorClientConfig());
const httpResourceServer = new x402ResourceServer(httpFacilitator);
registerExactEvmScheme(httpResourceServer);
httpResourceServer.registerExtension(bazaarResourceServerExtension);

const marketScanDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { limit: 100, min_certainty: 0.95, min_edge: 0.02 },
  inputSchema: {
    properties: {
      limit: { type: "integer", minimum: 10, maximum: 200 },
      min_certainty: { type: "number", minimum: 0.5, maximum: 1 },
      min_edge: { type: "number", minimum: 0, maximum: 0.5 },
      min_liquidity: { type: "number", minimum: 0 },
      min_volume_24h: { type: "number", minimum: 0 },
    },
  },
  output: { example: { source: "Polymarket Gamma API", markets_scanned: 100, resolution_candidates: [], bundle_violations: [] } },
});

const eventScanDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { slug: "democratic-presidential-nominee-2028", min_edge: 0.02, min_liquidity: 1000 },
  inputSchema: {
    properties: {
      slug: { type: "string", minLength: 2 },
      min_edge: { type: "number", minimum: 0, maximum: 0.5 },
      min_liquidity: { type: "number", minimum: 0 },
    },
    required: ["slug"],
  },
  output: { example: { source: "Polymarket Gamma API", event: { event_slug: "democratic-presidential-nominee-2028", violation: null } } },
});

const crossPlatformDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { query: "bitcoin", min_similarity: 0.62, min_net_edge: 0.015, kalshi_max_pages: 12 },
  inputSchema: {
    properties: {
      query: { type: "string", minLength: 2, maxLength: 100 },
      min_similarity: { type: "number", minimum: 0.4, maximum: 1 },
      min_net_edge: { type: "number", minimum: 0, maximum: 0.5 },
      polymarket_limit: { type: "integer", minimum: 100, maximum: 1000 },
      kalshi_max_pages: { type: "integer", minimum: 1, maximum: 20 },
      max_matches: { type: "integer", minimum: 1, maximum: 50 },
    },
    required: ["query"],
  },
  output: { example: { source: ["Polymarket Gamma API", "Kalshi public Trade API"], query: "bitcoin", candidate_matches: [], opportunities: [] } },
});

const rebalanceDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { limit: 500, min_edge: 0.005, min_liquidity: 1000 },
  inputSchema: {
    properties: {
      limit: { type: "integer", minimum: 10, maximum: 2000 },
      min_edge: { type: "number", minimum: 0, maximum: 0.5 },
      min_liquidity: { type: "number", minimum: 0 },
    },
  },
  output: { example: { source: "Polymarket Gamma API", scanned: 500, opportunities: [] } },
});

const trendingDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { limit: 20 },
  inputSchema: {
    properties: {
      limit: { type: "integer", minimum: 5, maximum: 100 },
      category: { type: "string", maxLength: 50 },
    },
  },
  output: { example: { source: "Polymarket Gamma API", markets: [] } },
});

const oddsFeedDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { limit: 30, platform: "both" },
  inputSchema: {
    properties: {
      limit: { type: "integer", minimum: 5, maximum: 100 },
      platform: { type: "string", enum: ["polymarket", "kalshi", "both"] },
    },
  },
  output: { example: { source: ["Polymarket", "Kalshi"], markets: [] } },
});

const volumeDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { limit: 30, min_volume: 1000 },
  inputSchema: {
    properties: {
      limit: { type: "integer", minimum: 5, maximum: 100 },
      min_volume: { type: "number", minimum: 0 },
    },
  },
  output: { example: { source: "Polymarket Gamma API", markets: [] } },
});

const resolutionHistoryDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { limit: 30, days_back: 7 },
  inputSchema: {
    properties: {
      limit: { type: "integer", minimum: 5, maximum: 100 },
      days_back: { type: "integer", minimum: 1, maximum: 90 },
    },
  },
  output: { example: { source: "Polymarket Gamma API", markets: [] } },
});

const kalshiMarketsDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { limit: 30 },
  inputSchema: {
    properties: {
      limit: { type: "integer", minimum: 5, maximum: 100 },
      category: { type: "string", maxLength: 50 },
    },
  },
  output: { example: { source: "Kalshi Trade API", markets: [] } },
});

// ─── OSINT discovery extensions (OSINT stack — v0.9) ────────────────
const geoPulseDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { region: "global", min_confidence: 0.6, hours_back: 6 },
  inputSchema: { properties: {
    region: { type: "string", enum: ["global","middle_east","ukraine","taiwan","asia_pacific"] },
    min_confidence: { type: "number", minimum: 0, maximum: 1 },
    hours_back: { type: "integer", minimum: 1, maximum: 72 },
    include_thermal: { type: "boolean" },
  } },
  output: { example: { signals: [], alert_level: "moderate", sources_queried: { gdelt: 10, bbc: 5 } } },
});
const flightIntelDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { airport_code: "TEB", hours_back: 12 },
  inputSchema: { properties: {
    airport_code: { type: "string", maxLength: 10 },
    tail_number: { type: "string", maxLength: 20 },
    hours_back: { type: "integer", minimum: 1, maximum: 72 },
  } },
  output: { example: { total_aircraft_seen: 42, filtered_count: 3, notable_military: [] } },
});
const researchPackDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { topic: "Iran refinery drone strike", hours_back: 24 },
  inputSchema: { properties: {
    topic: { type: "string", minLength: 3, maxLength: 200 },
    domains: { type: "array", items: { type: "string" } },
    include_sources: { type: "array", items: { type: "string" } },
    hours_back: { type: "integer", minimum: 1, maximum: 720 },
  }, required: ["topic"] },
  output: { example: { rows: [], total_fetched: 20, verification_report: {} } },
});
const scenarioVerdictDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { seed_text: "2x tanker attacked near Hormuz...", market_question: "Will oil exceed $95 by July 20?" },
  inputSchema: { properties: {
    seed_text: { type: "string", minLength: 10, maxLength: 5000 },
    market_question: { type: "string", minLength: 5, maxLength: 500 },
    context: { type: "string", maxLength: 2000 },
  }, required: ["seed_text","market_question"] },
  output: { example: { composite_prob: 0.72, composite_direction: "YES", scenarios: [] } },
});
const weatherBiasDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { city: "NYC", days_back: 7 },
  inputSchema: { properties: {
    city: { type: "string", minLength: 2, maxLength: 30 },
    model: { type: "string", maxLength: 50 },
    days_back: { type: "integer", minimum: 2, maximum: 30 },
  }, required: ["city"] },
  output: { example: { bias_score: { forecast_today_vs_recent_mean: 1.2 } } },
});
const supplyStressDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { ports: ["LAX", "NYC"], chokepoints: ["hormuz", "suez"] },
  inputSchema: { properties: {
    ports: { type: "array", items: { type: "string" } },
    chokepoints: { type: "array", items: { type: "string" } },
  } },
  output: { example: { overall_stress_index: 45, by_port: {}, by_chokepoint: {}, total_hints: 12 } },
});
const regulatoryPulseDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { org: "all", hours_back: 24 },
  inputSchema: { properties: {
    org: { type: "string", enum: ["all","sec","fda","uspto","fcc","faa","openfda"] },
    hours_back: { type: "integer", minimum: 1, maximum: 720 },
  } },
  output: { example: { sec_events: [], openfda_events: [], total: 0 } },
});
const attentionMomentumDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { query: "Claude Code", window: "6h" },
  inputSchema: { properties: {
    query: { type: "string", maxLength: 200 },
    window: { type: "string", enum: ["1h","6h","24h"] },
  } },
  output: { example: { hn_hits: 3, reddit_hits: 5, momentum_score: 2.4, viral: true } },
});
const sec8kVelocityDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { hours: 6, limit: 100 },
  inputSchema: { properties: {
    hours: { type: "integer", minimum: 1, maximum: 72 },
    min_score: { type: "number", minimum: 0, maximum: 1 },
    limit: { type: "integer", minimum: 10, maximum: 200 },
  } },
  output: { example: { filings_last_1h: 12, mean_24h: 3.2, ratio: 3.8, spike: true, rows: [] } },
});
const fredSurprisesDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { days: 14 },
  inputSchema: { properties: {
    days: { type: "integer", minimum: 5, maximum: 90 },
    min_score: { type: "number", minimum: 0, maximum: 1 },
  } },
  output: { example: { spread_10y_2y: -0.5, inversion: true, dgs10: 4.2, dgs2: 4.7, rows: [] } },
});
const treasuryDtsDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { days: 7 },
  inputSchema: { properties: {
    days: { type: "integer", minimum: 2, maximum: 30 },
    min_score: { type: "number", minimum: 0, maximum: 1 },
  } },
  output: { example: { tga_close_b: 680, delta_b: -25, stress_score: 0.5, rows: [] } },
});

// ─── Security (v0.8) ──
const threatIntelDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { category: "supply chain" },
  inputSchema: { properties: {
    category: { type: "string", maxLength: 80 },
    id: { type: "string", maxLength: 20 },
    severity: { type: "string", enum: ["critical","high","medium","low"] },
  } },
  output: { example: { threats: [{ id: "ASI01", title: "Prompt Injection" }] } },
});
const mcpIocsDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { package: "mcp-tool-example" },
  inputSchema: { properties: {
    package: { type: "string", maxLength: 200 },
    host: { type: "string", maxLength: 200 },
  } },
  output: { example: { iocs: [], malicious: false } },
});
const trifectaDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { has_private_data: true, has_untrusted_content: true, has_outbound_actions: true },
  inputSchema: { properties: {
    has_private_data: { type: "boolean" },
    has_untrusted_content: { type: "boolean" },
    has_outbound_actions: { type: "boolean" },
    compensating_controls: { type: "array", items: { type: "string" } },
  }, required: ["has_private_data","has_untrusted_content","has_outbound_actions"] },
  output: { example: { risk: "critical", missing_controls: ["redact_secrets"] } },
});
const policiesDiscovery = declareDiscoveryExtension({
  bodyType: "json",
  input: { profile: "payment-agent" },
  inputSchema: { properties: {
    profile: { type: "string", enum: ["coding-agent","browser-agent","payment-agent","research-agent"] },
  } },
  output: { example: { policies: [{ id: "no-pii-in-logs" }] } },
});

const paidHttp = new Hono<{ Bindings: Env }>();
paidHttp.use(paymentMiddleware({
  "POST /paid/polymarket/event-scan": {
    accepts: { scheme: "exact", price: "$0.03", network: SERVICE.network, payTo: SERVICE.seller },
    resource: `${SERVICE.origin}/paid/polymarket/event-scan`,
    description: "Live fee-adjusted Polymarket negRisk event scan",
    mimeType: "application/json",
    serviceName: "agenttoll.dev",
    tags: ["polymarket", "prediction-markets", "arbitrage", "x402"],
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    extensions: eventScanDiscovery,
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.03", network: SERVICE.network } }),
  },
  "POST /paid/polymarket/market-scan": {
    accepts: { scheme: "exact", price: "$0.05", network: SERVICE.network, payTo: SERVICE.seller },
    resource: `${SERVICE.origin}/paid/polymarket/market-scan`,
    description: "Live Polymarket resolution-candidate and bundle-violation scan",
    mimeType: "application/json",
    serviceName: "agenttoll.dev",
    tags: ["polymarket", "prediction-markets", "market-data", "x402"],
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    extensions: marketScanDiscovery,
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.05", network: SERVICE.network } }),
  },
  "POST /paid/markets/cross-platform-scan": {
    accepts: { scheme: "exact", price: "$0.10", network: SERVICE.network, payTo: SERVICE.seller },
    resource: `${SERVICE.origin}/paid/markets/cross-platform-scan`,
    description: "Live Polymarket-versus-Kalshi cross-platform spread scan",
    mimeType: "application/json",
    serviceName: "agenttoll.dev",
    tags: ["polymarket", "kalshi", "prediction-markets", "arbitrage", "x402"],
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    extensions: crossPlatformDiscovery,
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.10", network: SERVICE.network } }),
  },
  "POST /paid/polymarket/rebalance-scan": {
    accepts: { scheme: "exact", price: "$0.04", network: SERVICE.network, payTo: SERVICE.seller },
    resource: `${SERVICE.origin}/paid/polymarket/rebalance-scan`,
    description: "Scan Polymarket for single-market YES+NO pricing violations — guaranteed rebalance arbitrage opportunities",
    mimeType: "application/json",
    serviceName: "agenttoll.dev",
    tags: ["polymarket", "prediction-markets", "arbitrage", "rebalance", "x402"],
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    extensions: rebalanceDiscovery,
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.04", network: SERVICE.network } }),
  },
  "POST /paid/polymarket/trending": {
    accepts: { scheme: "exact", price: "$0.02", network: SERVICE.network, payTo: SERVICE.seller },
    resource: `${SERVICE.origin}/paid/polymarket/trending`,
    description: "Top trending Polymarket markets by 24h volume — prices, liquidity, volume data",
    mimeType: "application/json",
    serviceName: "agenttoll.dev",
    tags: ["polymarket", "prediction-markets", "market-data", "trending", "x402"],
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    extensions: trendingDiscovery,
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.02", network: SERVICE.network } }),
  },
  "POST /paid/odds/feed": {
    accepts: { scheme: "exact", price: "$0.02", network: SERVICE.network, payTo: SERVICE.seller },
    resource: `${SERVICE.origin}/paid/odds/feed`,
    description: "Normalized live odds across Polymarket and Kalshi — YES/NO prices, spreads, volume, liquidity",
    mimeType: "application/json",
    serviceName: "agenttoll.dev",
    tags: ["polymarket", "kalshi", "odds", "prediction-markets", "x402"],
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    extensions: oddsFeedDiscovery,
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.02", network: SERVICE.network } }),
  },
  "POST /paid/polymarket/volume-analytics": {
    accepts: { scheme: "exact", price: "$0.03", network: SERVICE.network, payTo: SERVICE.seller },
    resource: `${SERVICE.origin}/paid/polymarket/volume-analytics`,
    description: "Top Polymarket markets by 24h volume with momentum, liquidity, and price change analytics",
    mimeType: "application/json",
    serviceName: "agenttoll.dev",
    tags: ["polymarket", "volume", "analytics", "prediction-markets", "x402"],
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    extensions: volumeDiscovery,
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.03", network: SERVICE.network } }),
  },
  "POST /paid/polymarket/resolution-history": {
    accepts: { scheme: "exact", price: "$0.03", network: SERVICE.network, payTo: SERVICE.seller },
    resource: `${SERVICE.origin}/paid/polymarket/resolution-history`,
    description: "Recently resolved Polymarket markets with final outcomes for backtesting and model calibration",
    mimeType: "application/json",
    serviceName: "agenttoll.dev",
    tags: ["polymarket", "resolution", "history", "backtesting", "x402"],
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    extensions: resolutionHistoryDiscovery,
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.03", network: SERVICE.network } }),
  },
  "POST /paid/kalshi/markets": {
    accepts: { scheme: "exact", price: "$0.02", network: SERVICE.network, payTo: SERVICE.seller },
    resource: `${SERVICE.origin}/paid/kalshi/markets`,
    description: "Live Kalshi market list with bid/ask spreads, volume, open interest, and close dates",
    mimeType: "application/json",
    serviceName: "agenttoll.dev",
    tags: ["kalshi", "market-data", "prediction-markets", "cftc", "x402"],
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    extensions: kalshiMarketsDiscovery,
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.02", network: SERVICE.network } }),
  },
  "POST /paid/security/threat-intel": {
    accepts: { scheme: "exact", price: "$0.03", network: SERVICE.network, payTo: SERVICE.seller },
    resource: `${SERVICE.origin}/paid/security/threat-intel`,
    description: "OWASP Agentic Top 10 threat catalog — ASI01-ASI10 with detection hints, mitigations, and mapped detection rules",
    mimeType: "application/json",
    serviceName: "agenttoll.dev",
    tags: ["security", "owasp", "agentic", "threat-intel", "x402"],
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    extensions: threatIntelDiscovery,
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.03", network: SERVICE.network } }),
  },
  "POST /paid/security/mcp-iocs": {
    accepts: { scheme: "exact", price: "$0.02", network: SERVICE.network, payTo: SERVICE.seller },
    resource: `${SERVICE.origin}/paid/security/mcp-iocs`,
    description: "Known-malicious MCP packages, versions, C2 hosts — virus database for MCP supply chain",
    mimeType: "application/json",
    serviceName: "agenttoll.dev",
    tags: ["security", "mcp", "supply-chain", "ioc", "x402"],
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    extensions: mcpIocsDiscovery,
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.02", network: SERVICE.network } }),
  },
  "POST /paid/security/trifecta-score": {
    accepts: { scheme: "exact", price: "$0.05", network: SERVICE.network, payTo: SERVICE.seller },
    resource: `${SERVICE.origin}/paid/security/trifecta-score`,
    description: "Lethal trifecta risk score — private data + untrusted content + outbound actions assessment with missing controls and decomposition advice",
    mimeType: "application/json",
    serviceName: "agenttoll.dev",
    tags: ["security", "trifecta", "risk-assessment", "lethal-trifecta", "x402"],
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    extensions: trifectaDiscovery,
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.05", network: SERVICE.network } }),
  },
  "POST /paid/security/policies": {
    accepts: { scheme: "exact", price: "$0.05", network: SERVICE.network, payTo: SERVICE.seller },
    resource: `${SERVICE.origin}/paid/security/policies`,
    description: "Drop-in agent security policy templates by profile — coding, browser, payment, research agent rules",
    mimeType: "application/json",
    serviceName: "agenttoll.dev",
    tags: ["security", "policy", "governance", "agent", "x402"],
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    extensions: policiesDiscovery,
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.05", network: SERVICE.network } }),
  },
  // ── OSINT — 11 SKUs ─────────────────────────────────────────────
  "POST /paid/osint/geo-pulse": {
    accepts: { scheme: "exact", price: "$0.04", network: SERVICE.network, payTo: SERVICE.seller },
    resource: `${SERVICE.origin}/paid/osint/geo-pulse`,
    description: "Composite geopolitical intervention signal — GDELT + BBC + AlJazeera + ADS-B mil + prediction-market boosters (intervention signal pattern)",
    mimeType: "application/json",
    serviceName: "agenttoll.dev",
    tags: ["osint", "geopolitical", "gdelt", "adsb", "intervention-signal", "x402"],
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    extensions: geoPulseDiscovery,
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "$0.04", network: SERVICE.network } }),
  },
  "POST /paid/osint/flight-intel": {
    accepts: { scheme: "exact", price: "$0.03", network: SERVICE.network, payTo: SERVICE.seller },
    resource: `${SERVICE.origin}/paid/osint/flight-intel`,
    description: "Exec-jet + mil aircraft intel — TEB/VNY/DCA geofence, tail filter, notable B-52/F-35/E-3 detection via adsb.lol",
    mimeType: "application/json",
    serviceName: "agenttoll.dev",
    tags: ["osint", "adsb", "flight", "exec-jet", "military", "x402"],
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    extensions: flightIntelDiscovery,
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "$0.03", network: SERVICE.network } }),
  },
  "POST /paid/osint/research-pack": {
    accepts: { scheme: "exact", price: "$0.05", network: SERVICE.network, payTo: SERVICE.seller },
    resource: `${SERVICE.origin}/paid/osint/research-pack`,
    description: "Multi-source OSINT pack — GDELT + BBC + HN + Reddit, 4-layer verification layer, combined relevance scoring (research pack)",
    mimeType: "application/json",
    serviceName: "agenttoll.dev",
    tags: ["osint", "research", "gdelt", "verification", "x402"],
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    extensions: researchPackDiscovery,
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "$0.05", network: SERVICE.network } }),
  },
  "POST /paid/osint/scenario-verdict": {
    accepts: { scheme: "exact", price: "$0.05", network: SERVICE.network, payTo: SERVICE.seller },
    resource: `${SERVICE.origin}/paid/osint/scenario-verdict`,
    description: "Scenario engine seed->entity->3-scenario verdict.json + composite YES prob mapped to market question",
    mimeType: "application/json",
    serviceName: "agenttoll.dev",
    tags: ["osint", "scenario", "verdict", "prediction-market", "x402"],
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    extensions: scenarioVerdictDiscovery,
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "$0.05", network: SERVICE.network } }),
  },
  "POST /paid/osint/weather-bias": {
    accepts: { scheme: "exact", price: "$0.03", network: SERVICE.network, payTo: SERVICE.seller },
    resource: `${SERVICE.origin}/paid/osint/weather-bias`,
    description: "Weather bias score vs recent mean — uses Open-Meteo archive+forecast and ticker mapping for Kalshi HIGH* markets",
    mimeType: "application/json",
    serviceName: "agenttoll.dev",
    tags: ["osint", "weather", "kalshi", "open-meteo", "bias", "x402"],
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    extensions: weatherBiasDiscovery,
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "$0.03", network: SERVICE.network } }),
  },
  "POST /paid/osint/supply-stress": {
    accepts: { scheme: "exact", price: "$0.03", network: SERVICE.network, payTo: SERVICE.seller },
    resource: `${SERVICE.origin}/paid/osint/supply-stress`,
    description: "Supply-chain stress index — CBP BWT + GDELT chokepoint mentions + AIS hint, port stress for freight/commodity markets",
    mimeType: "application/json",
    serviceName: "agenttoll.dev",
    tags: ["osint", "supply-chain", "logistics", "ports", "cbp", "x402"],
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    extensions: supplyStressDiscovery,
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "$0.03", network: SERVICE.network } }),
  },
  "POST /paid/osint/regulatory-pulse": {
    accepts: { scheme: "exact", price: "$0.03", network: SERVICE.network, payTo: SERVICE.seller },
    resource: `${SERVICE.origin}/paid/osint/regulatory-pulse`,
    description: "Regulatory pulse — SEC Atom + openFDA adverse + USPTO + FCC OET + FAA registry patterns for bio/tech markets",
    mimeType: "application/json",
    serviceName: "agenttoll.dev",
    tags: ["osint", "regulatory", "sec", "fda", "uspto", "fcc", "x402"],
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    extensions: regulatoryPulseDiscovery,
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "$0.03", network: SERVICE.network } }),
  },
  "POST /paid/osint/attention-momentum": {
    accepts: { scheme: "exact", price: "$0.02", network: SERVICE.network, payTo: SERVICE.seller },
    resource: `${SERVICE.origin}/paid/osint/attention-momentum`,
    description: "Attention momentum — HN Algolia + Reddit JSON velocity scoring, points/hr + momentum_score, viral detection for culture markets",
    mimeType: "application/json",
    serviceName: "agenttoll.dev",
    tags: ["osint", "attention", "hn", "reddit", "velocity", "viral", "x402"],
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    extensions: attentionMomentumDiscovery,
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "$0.02", network: SERVICE.network } }),
  },
  "POST /paid/osint/sec-8k-velocity": {
    accepts: { scheme: "exact", price: "$0.03", network: SERVICE.network, payTo: SERVICE.seller },
    resource: `${SERVICE.origin}/paid/osint/sec-8k-velocity`,
    description: "SEC 8-K velocity — EFTS FullTextSearch + Atom current, 1h vs 24h mean spike >3x, Item 1.05/2.02/5.02 boost",
    mimeType: "application/json",
    serviceName: "agenttoll.dev",
    tags: ["osint", "sec", "edgar", "8-k", "filings", "velocity", "x402"],
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    extensions: sec8kVelocityDiscovery,
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "$0.03", network: SERVICE.network } }),
  },
  "POST /paid/osint/fred-surprises": {
    accepts: { scheme: "exact", price: "$0.02", network: SERVICE.network, payTo: SERVICE.seller },
    resource: `${SERVICE.origin}/paid/osint/fred-surprises`,
    description: "FRED rates surprise — DGS10/DGS2 csv public-domain no-key, spread + inversion flag, delta scoring",
    mimeType: "application/json",
    serviceName: "agenttoll.dev",
    tags: ["osint", "fred", "rates", "spread", "fomc", "public-domain", "x402"],
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    extensions: fredSurprisesDiscovery,
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "$0.02", network: SERVICE.network } }),
  },
  "POST /paid/osint/treasury-dts": {
    accepts: { scheme: "exact", price: "$0.04", network: SERVICE.network, payTo: SERVICE.seller },
    resource: `${SERVICE.origin}/paid/osint/treasury-dts`,
    description: "Treasury DTS — TGA operating_cash_balance gov public-domain, d/d delta, deposits/withdrawals",
    mimeType: "application/json",
    serviceName: "agenttoll.dev",
    tags: ["osint", "treasury", "dts", "tga", "liquidity", "gov", "x402"],
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    extensions: treasuryDtsDiscovery,
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "$0.04", network: SERVICE.network } }),
  },
  // ── 4 new public-API feeds (v0.9.1) ────────────────────────────────
  "POST /paid/osint/github-trending": {
    accepts: { scheme: "exact", price: "$0.02", network: SERVICE.network, payTo: SERVICE.seller },
    resource: `${SERVICE.origin}/paid/osint/github-trending`,
    description: "GitHub trending repos — stars>1 + recent push, sorted by stars desc via GitHub Search API no-key. Dev tooling / open source virality momentum.",
    mimeType: "application/json",
    serviceName: "agenttoll.dev",
    tags: ["osint", "github", "trending", "repos", "momentum", "x402"],
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "$0.02", network: SERVICE.network } }),
  },
  "POST /paid/osint/hn-frontpage": {
    accepts: { scheme: "exact", price: "$0.02", network: SERVICE.network, payTo: SERVICE.seller },
    resource: `${SERVICE.origin}/paid/osint/hn-frontpage`,
    description: "HN frontpage live — Algolia front_page tag, dwell = points/(hours_old+2). Top stories sorted by dwell for attention-momentum edge.",
    mimeType: "application/json",
    serviceName: "agenttoll.dev",
    tags: ["osint", "hackernews", "hn", "frontpage", "dwell", "attention", "x402"],
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "$0.02", network: SERVICE.network } }),
  },
  "POST /paid/osint/usgs-quake": {
    accepts: { scheme: "exact", price: "$0.02", network: SERVICE.network, payTo: SERVICE.seller },
    resource: `${SERVICE.origin}/paid/osint/usgs-quake`,
    description: "USGS all-day earthquakes — mag, place, time, coords, tsunami, url. Public GeoJSON no-key. Disaster / insurance / commodity tail-risk pulse.",
    mimeType: "application/json",
    serviceName: "agenttoll.dev",
    tags: ["osint", "usgs", "earthquake", "seismic", "disaster", "geojson", "x402"],
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "$0.02", network: SERVICE.network } }),
  },
  "POST /paid/osint/openaq-air": {
    accepts: { scheme: "exact", price: "$0.02", network: SERVICE.network, payTo: SERVICE.seller },
    resource: `${SERVICE.origin}/paid/osint/openaq-air`,
    description: "OpenAQ air quality pulse — PM2.5/PM10/NO2/O3 by city/country, lastUpdated, sensor counts. v3 API + v2 fallback. Env / health / geo pulse.",
    mimeType: "application/json",
    serviceName: "agenttoll.dev",
    tags: ["osint", "openaq", "air-quality", "environment", "health", "x402"],
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "$0.02", network: SERVICE.network } }),
  },
  "POST /paid/osint/openrouter-models": {
    accepts: { scheme: "exact", price: "$0.02", network: SERVICE.network, payTo: SERVICE.seller },
    resource: `${SERVICE.origin}/paid/osint/openrouter-models`,
    description: "OpenRouter model catalog — live model list with context length, pricing, capabilities. AI/ML infrastructure intel.",
    mimeType: "application/json",
    serviceName: "agenttoll.dev",
    tags: ["osint", "openrouter", "models", "ai", "infrastructure", "x402"],
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.02", network: SERVICE.network } }),
  },
  // ── Legal & Regulatory (v0.11.0) ──────────────────────────────────
  "POST /paid/legal/court-opinions": { accepts: { scheme: "exact", price: "$0.05", network: SERVICE.network, payTo: SERVICE.seller }, resource: `${SERVICE.origin}/paid/legal/court-opinions`, description: "Search US federal court opinions via CourtListener (Free Law Project)", mimeType: "application/json", serviceName: "agenttoll.dev", tags: ["legal", "court", "opinions", "courtlistener", "x402"], iconUrl: `${SERVICE.origin}/favicon.ico`, unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.05", network: SERVICE.network } }) },
  "POST /paid/legal/court-docket": { accepts: { scheme: "exact", price: "$0.05", network: SERVICE.network, payTo: SERVICE.seller }, resource: `${SERVICE.origin}/paid/legal/court-docket`, description: "Look up a federal court docket via CourtListener RECAP archive", mimeType: "application/json", serviceName: "agenttoll.dev", tags: ["legal", "court", "docket", "recap", "x402"], iconUrl: `${SERVICE.origin}/favicon.ico`, unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.05", network: SERVICE.network } }) },
  "POST /paid/legal/federal-register": { accepts: { scheme: "exact", price: "$0.03", network: SERVICE.network, payTo: SERVICE.seller }, resource: `${SERVICE.origin}/paid/legal/federal-register`, description: "Search the daily Federal Register — proposed rules, final rules, presidential notices", mimeType: "application/json", serviceName: "agenttoll.dev", tags: ["legal", "federal-register", "regulations", "x402"], iconUrl: `${SERVICE.origin}/favicon.ico`, unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.03", network: SERVICE.network } }) },
  "POST /paid/legal/patents": { accepts: { scheme: "exact", price: "$0.04", network: SERVICE.network, payTo: SERVICE.seller }, resource: `${SERVICE.origin}/paid/legal/patents`, description: "Full-text patent search via Google Patents", mimeType: "application/json", serviceName: "agenttoll.dev", tags: ["legal", "patent", "uspto", "x402"], iconUrl: `${SERVICE.origin}/favicon.ico`, unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.04", network: SERVICE.network } }) },
  "POST /paid/legal/regulations": { accepts: { scheme: "exact", price: "$0.03", network: SERVICE.network, payTo: SERVICE.seller }, resource: `${SERVICE.origin}/paid/legal/regulations`, description: "Search open rulemakings and public dockets", mimeType: "application/json", serviceName: "agenttoll.dev", tags: ["legal", "regulations", "rulemaking", "x402"], iconUrl: `${SERVICE.origin}/favicon.ico`, unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.03", network: SERVICE.network } }) },
  // ── Academic & Scientific (v0.11.0) ───────────────────────────────
  "POST /paid/academic/papers": { accepts: { scheme: "exact", price: "$0.04", network: SERVICE.network, payTo: SERVICE.seller }, resource: `${SERVICE.origin}/paid/academic/papers`, description: "Search 226M+ academic papers via Semantic Scholar Graph API", mimeType: "application/json", serviceName: "agenttoll.dev", tags: ["academic", "papers", "semantic-scholar", "research", "x402"], iconUrl: `${SERVICE.origin}/favicon.ico`, unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.04", network: SERVICE.network } }) },
  "POST /paid/academic/arxiv": { accepts: { scheme: "exact", price: "$0.02", network: SERVICE.network, payTo: SERVICE.seller }, resource: `${SERVICE.origin}/paid/academic/arxiv`, description: "Search arXiv preprints in CS, physics, math, biology", mimeType: "application/json", serviceName: "agenttoll.dev", tags: ["academic", "arxiv", "preprint", "x402"], iconUrl: `${SERVICE.origin}/favicon.ico`, unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.02", network: SERVICE.network } }) },
  "POST /paid/academic/pubmed": { accepts: { scheme: "exact", price: "$0.03", network: SERVICE.network, payTo: SERVICE.seller }, resource: `${SERVICE.origin}/paid/academic/pubmed`, description: "Search 37M+ biomedical papers via NCBI PubMed", mimeType: "application/json", serviceName: "agenttoll.dev", tags: ["academic", "pubmed", "biomedical", "x402"], iconUrl: `${SERVICE.origin}/favicon.ico`, unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.03", network: SERVICE.network } }) },
  "POST /paid/academic/clinical-trials": { accepts: { scheme: "exact", price: "$0.04", network: SERVICE.network, payTo: SERVICE.seller }, resource: `${SERVICE.origin}/paid/academic/clinical-trials`, description: "Search 480K+ clinical studies via ClinicalTrials.gov v2", mimeType: "application/json", serviceName: "agenttoll.dev", tags: ["academic", "clinical-trials", "medical", "x402"], iconUrl: `${SERVICE.origin}/favicon.ico`, unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.04", network: SERVICE.network } }) },
  "POST /paid/academic/openalex": { accepts: { scheme: "exact", price: "$0.03", network: SERVICE.network, payTo: SERVICE.seller }, resource: `${SERVICE.origin}/paid/academic/openalex`, description: "Search 250M+ works via OpenAlex with institution data and bibliometrics", mimeType: "application/json", serviceName: "agenttoll.dev", tags: ["academic", "openalex", "bibliometrics", "x402"], iconUrl: `${SERVICE.origin}/favicon.ico`, unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.03", network: SERVICE.network } }) },
  // ── Public Health & Safety (v0.11.0) ──────────────────────────────
  "POST /paid/health/drug-recalls": { accepts: { scheme: "exact", price: "$0.03", network: SERVICE.network, payTo: SERVICE.seller }, resource: `${SERVICE.origin}/paid/health/drug-recalls`, description: "Search FDA drug/device/food enforcement recalls via openFDA", mimeType: "application/json", serviceName: "agenttoll.dev", tags: ["health", "fda", "drug-recall", "x402"], iconUrl: `${SERVICE.origin}/favicon.ico`, unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.03", network: SERVICE.network } }) },
  "POST /paid/health/adverse-events": { accepts: { scheme: "exact", price: "$0.04", network: SERVICE.network, payTo: SERVICE.seller }, resource: `${SERVICE.origin}/paid/health/adverse-events`, description: "Search 20M+ FDA adverse drug event reports via openFDA", mimeType: "application/json", serviceName: "agenttoll.dev", tags: ["health", "fda", "adverse-events", "pharmacovigilance", "x402"], iconUrl: `${SERVICE.origin}/favicon.ico`, unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.04", network: SERVICE.network } }) },
  "POST /paid/health/product-recalls": { accepts: { scheme: "exact", price: "$0.03", network: SERVICE.network, payTo: SERVICE.seller }, resource: `${SERVICE.origin}/paid/health/product-recalls`, description: "Search CPSC consumer product recalls via saferproducts.gov", mimeType: "application/json", serviceName: "agenttoll.dev", tags: ["health", "cpsc", "product-recall", "safety", "x402"], iconUrl: `${SERVICE.origin}/favicon.ico`, unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.03", network: SERVICE.network } }) },
  "POST /paid/health/vehicle-recalls": { accepts: { scheme: "exact", price: "$0.03", network: SERVICE.network, payTo: SERVICE.seller }, resource: `${SERVICE.origin}/paid/health/vehicle-recalls`, description: "Search NHTSA vehicle recalls by make, model, or VIN", mimeType: "application/json", serviceName: "agenttoll.dev", tags: ["health", "nhtsa", "vehicle-recall", "safety", "x402"], iconUrl: `${SERVICE.origin}/favicon.ico`, unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.03", network: SERVICE.network } }) },
  "POST /paid/health/drug-labels": { accepts: { scheme: "exact", price: "$0.03", network: SERVICE.network, payTo: SERVICE.seller }, resource: `${SERVICE.origin}/paid/health/drug-labels`, description: "Search official FDA drug labels via openFDA — dosage, warnings, contraindications", mimeType: "application/json", serviceName: "agenttoll.dev", tags: ["health", "fda", "drug-label", "x402"], iconUrl: `${SERVICE.origin}/favicon.ico`, unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.03", network: SERVICE.network } }) },
  // ── Environmental & Climate (v0.11.0) ─────────────────────────────
  "POST /paid/env/wildfires": { accepts: { scheme: "exact", price: "$0.03", network: SERVICE.network, payTo: SERVICE.seller }, resource: `${SERVICE.origin}/paid/env/wildfires`, description: "Active wildfire detections from NASA FIRMS satellites", mimeType: "application/json", serviceName: "agenttoll.dev", tags: ["environment", "wildfire", "nasa", "firms", "x402"], iconUrl: `${SERVICE.origin}/favicon.ico`, unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.03", network: SERVICE.network } }) },
  "POST /paid/env/weather-alerts": { accepts: { scheme: "exact", price: "$0.02", network: SERVICE.network, payTo: SERVICE.seller }, resource: `${SERVICE.origin}/paid/env/weather-alerts`, description: "Active NOAA NWS severe weather alerts by state or zone", mimeType: "application/json", serviceName: "agenttoll.dev", tags: ["environment", "weather", "noaa", "nws", "alerts", "x402"], iconUrl: `${SERVICE.origin}/favicon.ico`, unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.02", network: SERVICE.network } }) },
  "POST /paid/env/tides": { accepts: { scheme: "exact", price: "$0.03", network: SERVICE.network, payTo: SERVICE.seller }, resource: `${SERVICE.origin}/paid/env/tides`, description: "NOAA tide predictions and observed water levels for coastal stations", mimeType: "application/json", serviceName: "agenttoll.dev", tags: ["environment", "tide", "noaa", "coastal", "x402"], iconUrl: `${SERVICE.origin}/favicon.ico`, unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.03", network: SERVICE.network } }) },
  "POST /paid/env/space-weather": { accepts: { scheme: "exact", price: "$0.02", network: SERVICE.network, payTo: SERVICE.seller }, resource: `${SERVICE.origin}/paid/env/space-weather`, description: "NOAA space weather — solar flares, geomagnetic storms, solar wind, Kp index", mimeType: "application/json", serviceName: "agenttoll.dev", tags: ["environment", "space-weather", "noaa", "solar", "x402"], iconUrl: `${SERVICE.origin}/favicon.ico`, unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.02", network: SERVICE.network } }) },
  "POST /paid/env/water-levels": { accepts: { scheme: "exact", price: "$0.03", network: SERVICE.network, payTo: SERVICE.seller }, resource: `${SERVICE.origin}/paid/env/water-levels`, description: "Real-time USGS river/stream flow and flood data by state", mimeType: "application/json", serviceName: "agenttoll.dev", tags: ["environment", "water", "usgs", "flood", "x402"], iconUrl: `${SERVICE.origin}/favicon.ico`, unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.03", network: SERVICE.network } }) },
  // ── Government Spending & Contracts (v0.11.0) ─────────────────────
  "POST /paid/gov/federal-spending": { accepts: { scheme: "exact", price: "$0.04", network: SERVICE.network, payTo: SERVICE.seller }, resource: `${SERVICE.origin}/paid/gov/federal-spending`, description: "Search $6T+ federal budget by agency, recipient, or keyword via USAspending.gov", mimeType: "application/json", serviceName: "agenttoll.dev", tags: ["government", "spending", "usaspending", "budget", "x402"], iconUrl: `${SERVICE.origin}/favicon.ico`, unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.04", network: SERVICE.network } }) },
  "POST /paid/gov/national-debt": { accepts: { scheme: "exact", price: "$0.02", network: SERVICE.network, payTo: SERVICE.seller }, resource: `${SERVICE.origin}/paid/gov/national-debt`, description: "US national debt to the penny via Treasury FiscalData", mimeType: "application/json", serviceName: "agenttoll.dev", tags: ["government", "debt", "treasury", "x402"], iconUrl: `${SERVICE.origin}/favicon.ico`, unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.02", network: SERVICE.network } }) },
  "POST /paid/gov/federal-grants": { accepts: { scheme: "exact", price: "$0.03", network: SERVICE.network, payTo: SERVICE.seller }, resource: `${SERVICE.origin}/paid/gov/federal-grants`, description: "Search Grants.gov for open federal funding opportunities", mimeType: "application/json", serviceName: "agenttoll.dev", tags: ["government", "grants", "funding", "x402"], iconUrl: `${SERVICE.origin}/favicon.ico`, unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.03", network: SERVICE.network } }) },
  "POST /paid/gov/nonprofits": { accepts: { scheme: "exact", price: "$0.03", network: SERVICE.network, payTo: SERVICE.seller }, resource: `${SERVICE.origin}/paid/gov/nonprofits`, description: "Search nonprofit IRS 990 filings via ProPublica Nonprofit Explorer", mimeType: "application/json", serviceName: "agenttoll.dev", tags: ["government", "nonprofit", "irs", "990", "x402"], iconUrl: `${SERVICE.origin}/favicon.ico`, unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.03", network: SERVICE.network } }) },
  "POST /paid/gov/economic-indicators": { accepts: { scheme: "exact", price: "$0.03", network: SERVICE.network, payTo: SERVICE.seller }, resource: `${SERVICE.origin}/paid/gov/economic-indicators`, description: "GDP, CPI, unemployment, trade data via World Bank API", mimeType: "application/json", serviceName: "agenttoll.dev", tags: ["government", "economic", "world-bank", "gdp", "x402"], iconUrl: `${SERVICE.origin}/favicon.ico`, unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.03", network: SERVICE.network } }) },
  "POST /paid/gov/lobbying": { accepts: { scheme: "exact", price: "$0.04", network: SERVICE.network, payTo: SERVICE.seller }, resource: `${SERVICE.origin}/paid/gov/lobbying`, description: "Search FEC lobbying disclosure records", mimeType: "application/json", serviceName: "agenttoll.dev", tags: ["government", "lobbying", "fec", "x402"], iconUrl: `${SERVICE.origin}/favicon.ico`, unpaidResponseBody: () => ({ contentType: "application/json", body: { error: "payment_required", price_usd: "0.04", network: SERVICE.network } }) },
}, httpResourceServer));

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

paidHttp.post("/paid/polymarket/event-scan", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    return c.json(await scanPolymarketEvent({
      slug: String(body.slug ?? ""),
      minEdge: optionalNumber(body.min_edge),
      minLiquidity: optionalNumber(body.min_liquidity),
    }));
  } catch (error) {
    return c.json({ error: "polymarket_scan_failed", message: error instanceof Error ? error.message : String(error) }, 400);
  }
});

paidHttp.post("/paid/polymarket/market-scan", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    return c.json(await scanPolymarketMarkets({
      limit: optionalNumber(body.limit),
      minCertainty: optionalNumber(body.min_certainty),
      minEdge: optionalNumber(body.min_edge),
      minLiquidity: optionalNumber(body.min_liquidity),
      minVolume24h: optionalNumber(body.min_volume_24h),
    }));
  } catch (error) {
    return c.json({ error: "polymarket_scan_failed", message: error instanceof Error ? error.message : String(error) }, 502);
  }
});

paidHttp.post("/paid/markets/cross-platform-scan", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    return c.json(await scanCrossPlatformMarkets({
      query: String(body.query ?? ""),
      minSimilarity: optionalNumber(body.min_similarity),
      minNetEdge: optionalNumber(body.min_net_edge),
      polymarketLimit: optionalNumber(body.polymarket_limit),
      kalshiMaxPages: optionalNumber(body.kalshi_max_pages),
      maxMatches: optionalNumber(body.max_matches),
    }));
  } catch (error) {
    return c.json({ error: "cross_platform_scan_failed", message: error instanceof Error ? error.message : String(error) }, 502);
  }
});

paidHttp.post("/paid/polymarket/rebalance-scan", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    return c.json(await scanRebalanceOpportunities({
      limit: optionalNumber(body.limit),
      minEdge: optionalNumber(body.min_edge),
      minLiquidity: optionalNumber(body.min_liquidity),
    }));
  } catch (error) {
    return c.json({ error: "rebalance_scan_failed", message: error instanceof Error ? error.message : String(error) }, 502);
  }
});

paidHttp.post("/paid/polymarket/trending", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    const wrapped = await getCachedOrLive(c.env as any, "polymarket-trending", () => scanTrendingMarkets({ limit: optionalNumber(body.limit), category: body.category ? String(body.category) : undefined }), { params: body });
    return c.json(wrapped.data, 200, { "X-Cache": wrapped.cached ? "HIT" : "MISS", "X-Cache-Age": String(wrapped.age_ms ?? 0) } as any);
  } catch (e) { return c.json({ error: "trending_scan_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});

paidHttp.post("/paid/odds/feed", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    const wrapped = await getCachedOrLive(c.env as any, "odds-feed", () => oddsFeed({ limit: optionalNumber(body.limit), platform: body.platform as "polymarket" | "kalshi" | "both" | undefined }), { params: body });
    return c.json(wrapped.data, 200, { "X-Cache": wrapped.cached ? "HIT" : "MISS", "X-Cache-Age": String(wrapped.age_ms ?? 0) } as any);
  } catch (e) { return c.json({ error: "odds_feed_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});

paidHttp.post("/paid/polymarket/volume-analytics", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    const wrapped = await getCachedOrLive(c.env as any, "polymarket-volume", () => volumeAnalytics({ limit: optionalNumber(body.limit), min_volume: optionalNumber(body.min_volume) }), { params: body });
    return c.json(wrapped.data, 200, { "X-Cache": wrapped.cached ? "HIT" : "MISS", "X-Cache-Age": String(wrapped.age_ms ?? 0) } as any);
  } catch (e) { return c.json({ error: "volume_analytics_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});

paidHttp.post("/paid/polymarket/resolution-history", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    const wrapped = await getCachedOrLive(c.env as any, "polymarket-resolution", () => resolutionHistory({ limit: optionalNumber(body.limit), days_back: optionalNumber(body.days_back) }), { params: body });
    return c.json(wrapped.data, 200, { "X-Cache": wrapped.cached ? "HIT" : "MISS", "X-Cache-Age": String(wrapped.age_ms ?? 0) } as any);
  } catch (e) { return c.json({ error: "resolution_history_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});

paidHttp.post("/paid/kalshi/markets", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    const wrapped = await getCachedOrLive(c.env as any, "kalshi-markets", () => kalshiMarkets({ limit: optionalNumber(body.limit), category: body.category ? String(body.category) : undefined }), { params: body });
    return c.json(wrapped.data, 200, { "X-Cache": wrapped.cached ? "HIT" : "MISS", "X-Cache-Age": String(wrapped.age_ms ?? 0) } as any);
  } catch (e) { return c.json({ error: "kalshi_markets_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});

paidHttp.post("/paid/security/threat-intel", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    return c.json(queryThreatCatalog({
      category: body.category ? String(body.category) : undefined,
      id: body.id ? String(body.id) : undefined,
      severity: body.severity ? String(body.severity) : undefined,
    }));
  } catch (error) {
    return c.json({ error: "threat_intel_failed", message: error instanceof Error ? error.message : String(error) }, 500);
  }
});

paidHttp.post("/paid/security/mcp-iocs", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    return c.json(queryMcpIocs({
      package: body.package ? String(body.package) : undefined,
      host: body.host ? String(body.host) : undefined,
    }));
  } catch (error) {
    return c.json({ error: "mcp_iocs_failed", message: error instanceof Error ? error.message : String(error) }, 500);
  }
});

paidHttp.post("/paid/security/trifecta-score", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    return c.json(scoreTrifecta({
      has_private_data: Boolean(body.has_private_data),
      has_untrusted_content: Boolean(body.has_untrusted_content),
      has_outbound_actions: Boolean(body.has_outbound_actions),
      compensating_controls: Array.isArray(body.compensating_controls) ? (body.compensating_controls as string[]) : [],
    }));
  } catch (error) {
    return c.json({ error: "trifecta_score_failed", message: error instanceof Error ? error.message : String(error) }, 500);
  }
});

paidHttp.post("/paid/security/policies", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    return c.json(getPolicyTemplates({
      profile: body.profile ? String(body.profile) : undefined,
    }));
  } catch (error) {
    return c.json({ error: "policies_failed", message: error instanceof Error ? error.message : String(error) }, 500);
  }
});

// ─── OSINT ────────────────────────────────────────────────────────
paidHttp.post("/paid/osint/geo-pulse", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    const wrapped = await getCachedOrLive(c.env as any, "geo-pulse", () => queryGeoPulse({
      region: body.region ? String(body.region) : undefined,
      min_confidence: typeof body.min_confidence === "number" ? body.min_confidence : undefined,
      hours_back: typeof body.hours_back === "number" ? body.hours_back : undefined,
      include_thermal: Boolean(body.include_thermal),
    }), { params: body });
    return c.json(wrapped.data, 200, { "X-Cache": wrapped.cached ? "HIT" : "MISS", "X-Cache-Age": String(wrapped.age_ms ?? 0) } as any);
  } catch (e) { return c.json({ error: "geo_pulse_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});
paidHttp.post("/paid/osint/flight-intel", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    const wrapped = await getCachedOrLive(c.env as any, "flight-intel", () => queryFlightIntel({
      airport_code: body.airport_code ? String(body.airport_code) : undefined,
      tail_number: body.tail_number ? String(body.tail_number) : undefined,
      hours_back: typeof body.hours_back === "number" ? body.hours_back : undefined,
    }), { params: body });
    return c.json(wrapped.data, 200, { "X-Cache": wrapped.cached ? "HIT" : "MISS", "X-Cache-Age": String(wrapped.age_ms ?? 0) } as any);
  } catch (e) { return c.json({ error: "flight_intel_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});
paidHttp.post("/paid/osint/research-pack", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    const domains = Array.isArray(body.domains) ? body.domains as string[] : undefined;
    return c.json(await queryResearchPack({
      topic: String(body.topic ?? ""),
      domains, include_sources: Array.isArray(body.include_sources) ? body.include_sources as string[] : undefined,
      hours_back: typeof body.hours_back === "number" ? body.hours_back : undefined,
    }));
  } catch (e) { return c.json({ error: "research_pack_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});
paidHttp.post("/paid/osint/scenario-verdict", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    const wrapped = await getCachedOrLive(c.env as any, "scenario-verdict", () => queryScenarioVerdict({
      seed_text: String(body.seed_text ?? ""),
      market_question: String(body.market_question ?? ""),
      context: body.context ? String(body.context) : undefined,
    }), { params: body });
    return c.json(wrapped.data, 200, { "X-Cache": wrapped.cached ? "HIT" : "MISS", "X-Cache-Age": String(wrapped.age_ms ?? 0) } as any);
  } catch (e) { return c.json({ error: "scenario_verdict_failed", message: e instanceof Error ? e.message : String(e) }, 400); }
});
paidHttp.post("/paid/osint/weather-bias", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    const wrapped = await getCachedOrLive(c.env as any, "weather-bias", () => queryWeatherBias({
      city: String(body.city ?? "NYC"),
      model: body.model ? String(body.model) : undefined,
      days_back: typeof body.days_back === "number" ? body.days_back : undefined,
    }), { params: body });
    return c.json(wrapped.data, 200, { "X-Cache": wrapped.cached ? "HIT" : "MISS", "X-Cache-Age": String(wrapped.age_ms ?? 0) } as any);
  } catch (e) { return c.json({ error: "weather_bias_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});
paidHttp.post("/paid/osint/supply-stress", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    const wrapped = await getCachedOrLive(c.env as any, "supply-stress", () => querySupplyStress({
      ports: Array.isArray(body.ports) ? body.ports as string[] : undefined,
      chokepoints: Array.isArray(body.chokepoints) ? body.chokepoints as string[] : undefined,
    }), { params: body });
    return c.json(wrapped.data, 200, { "X-Cache": wrapped.cached ? "HIT" : "MISS", "X-Cache-Age": String(wrapped.age_ms ?? 0) } as any);
  } catch (e) { return c.json({ error: "supply_stress_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});
paidHttp.post("/paid/osint/regulatory-pulse", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    const wrapped = await getCachedOrLive(c.env as any, "regulatory-pulse", () => queryRegulatoryPulse({
      org: body.org ? String(body.org) : undefined,
      hours_back: typeof body.hours_back === "number" ? body.hours_back : undefined,
    }), { params: body });
    return c.json(wrapped.data, 200, { "X-Cache": wrapped.cached ? "HIT" : "MISS", "X-Cache-Age": String(wrapped.age_ms ?? 0) } as any);
  } catch (e) { return c.json({ error: "regulatory_pulse_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});
paidHttp.post("/paid/osint/attention-momentum", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    const wrapped = await getCachedOrLive(c.env as any, "attention-momentum", () => queryAttentionMomentum({
      query: body.query ? String(body.query) : undefined,
      window: body.window ? String(body.window) as "1h"|"6h"|"24h" : undefined,
    }), { params: body });
    return c.json(wrapped.data, 200, { "X-Cache": wrapped.cached ? "HIT" : "MISS", "X-Cache-Age": String(wrapped.age_ms ?? 0) } as any);
  } catch (e) { return c.json({ error: "attention_momentum_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});

paidHttp.post("/paid/osint/sec-8k-velocity", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    const wrapped = await getCachedOrLive(c.env as any, "sec-8k-velocity", () => querySec8kVelocity({
      hours: typeof body.hours === "number" ? body.hours : body.hours ? Number(body.hours) : undefined,
      min_score: typeof body.min_score === "number" ? body.min_score : undefined,
      limit: typeof body.limit === "number" ? body.limit : body.limit ? Number(body.limit) : undefined,
    }), { params: body });
    return c.json(wrapped.data, 200, { "X-Cache": wrapped.cached ? "HIT" : "MISS", "X-Cache-Age": String(wrapped.age_ms ?? 0) } as any);
  } catch (e) { return c.json({ error: "sec_8k_velocity_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});
paidHttp.post("/paid/osint/fred-surprises", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    const wrapped = await getCachedOrLive(c.env as any, "fred-surprises", () => queryFredSurprises({
      days: typeof body.days === "number" ? body.days : body.days ? Number(body.days) : undefined,
      min_score: typeof body.min_score === "number" ? body.min_score : undefined,
    }), { params: body });
    return c.json(wrapped.data, 200, { "X-Cache": wrapped.cached ? "HIT" : "MISS", "X-Cache-Age": String(wrapped.age_ms ?? 0) } as any);
  } catch (e) { return c.json({ error: "fred_surprises_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});
paidHttp.post("/paid/osint/treasury-dts", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    const wrapped = await getCachedOrLive(c.env as any, "treasury-dts", () => queryTreasuryDts({
      days: typeof body.days === "number" ? body.days : body.days ? Number(body.days) : undefined,
      min_score: typeof body.min_score === "number" ? body.min_score : undefined,
    }), { params: body });
    return c.json(wrapped.data, 200, { "X-Cache": wrapped.cached ? "HIT" : "MISS", "X-Cache-Age": String(wrapped.age_ms ?? 0) } as any);
  } catch (e) { return c.json({ error: "treasury_dts_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});

paidHttp.post("/paid/osint/openrouter-models", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    const wrapped = await getCachedOrLive(c.env as any, "openrouter-model-usage", async () => {
      const r = await fetch("https://openrouter.ai/api/v1/models", { headers: { "User-Agent": "agenttoll.dev/1.0" } });
      if (!r.ok) throw new Error(`openrouter ${r.status}`);
      const j = await r.json() as any;
      const models = Array.isArray(j?.data) ? j.data : [];
      return { fetched_at: new Date().toISOString(), count: models.length, models: models.slice(0, 300).map((m: any) => ({ id: m.id, name: m.name, context_length: m.context_length, pricing: m.pricing, created: m.created })), provenance: "https://openrouter.ai/api/v1/models" };
    }, { params: body });
    return c.json(wrapped.data, 200, { "X-Cache": wrapped.cached ? "HIT" : "MISS", "X-Cache-Age": String(wrapped.age_ms ?? 0) } as any);
  } catch (e) { return c.json({ error: "openrouter_models_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});

// ── Extra public feeds (v1.0) ────────────────────────────────────────
paidHttp.post("/paid/osint/github-trending", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    const wrapped = await getCachedOrLive(c.env as any, "github-trending", () => fetchGithubTrending({
      limit: typeof body.limit === "number" ? body.limit : undefined,
      language: body.language ? String(body.language) : undefined,
      since_days: typeof body.since_days === "number" ? body.since_days : undefined,
    }), { params: body });
    return c.json(wrapped.data, 200, { "X-Cache": wrapped.cached ? "HIT" : "MISS", "X-Cache-Age": String(wrapped.age_ms ?? 0) } as any);
  } catch (e) { return c.json({ error: "github_trending_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});

paidHttp.post("/paid/osint/hn-frontpage", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    const wrapped = await getCachedOrLive(c.env as any, "hn-frontpage", () => fetchHnFrontpage({
      limit: typeof body.limit === "number" ? body.limit : undefined,
      min_points: typeof body.min_points === "number" ? body.min_points : undefined,
    }), { params: body });
    return c.json(wrapped.data, 200, { "X-Cache": wrapped.cached ? "HIT" : "MISS", "X-Cache-Age": String(wrapped.age_ms ?? 0) } as any);
  } catch (e) { return c.json({ error: "hn_frontpage_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});

paidHttp.post("/paid/osint/usgs-quake", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    const wrapped = await getCachedOrLive(c.env as any, "usgs-quake", () => fetchUsgsQuakes({
      limit: typeof body.limit === "number" ? body.limit : undefined,
      min_mag: typeof body.min_mag === "number" ? body.min_mag : undefined,
    }), { params: body });
    return c.json(wrapped.data, 200, { "X-Cache": wrapped.cached ? "HIT" : "MISS", "X-Cache-Age": String(wrapped.age_ms ?? 0) } as any);
  } catch (e) { return c.json({ error: "usgs_quake_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});

paidHttp.post("/paid/osint/openaq-air", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    const wrapped = await getCachedOrLive(c.env as any, "openaq-air", () => fetchOpenAq({
      limit: typeof body.limit === "number" ? body.limit : undefined,
      country: body.country ? String(body.country) : undefined,
    }), { params: body });
    return c.json(wrapped.data, 200, { "X-Cache": wrapped.cached ? "HIT" : "MISS", "X-Cache-Age": String(wrapped.age_ms ?? 0) } as any);
  } catch (e) { return c.json({ error: "openaq_air_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});

// ─── Legal & Regulatory Routes (v0.11.0) ─────────────────────────────
paidHttp.post("/paid/legal/court-opinions", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try { return c.json(await searchCourtOpinions(body.query ? String(body.query) : "", body.court ? String(body.court) : undefined, typeof body.days_back === "number" ? body.days_back : undefined)); }
  catch (e) { return c.json({ error: "court_opinions_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});
paidHttp.post("/paid/legal/court-docket", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try { return c.json(await lookupCourtDocket(String(body.docket_id ?? ""))); }
  catch (e) { return c.json({ error: "court_docket_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});
paidHttp.post("/paid/legal/federal-register", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try { return c.json(await searchFederalRegister(body.query ? String(body.query) : "", body.agency ? String(body.agency) : undefined, body.type ? String(body.type) : undefined)); }
  catch (e) { return c.json({ error: "federal_register_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});
paidHttp.post("/paid/legal/patents", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try { return c.json(await searchPatents(body.query ? String(body.query) : "", typeof body.limit === "number" ? body.limit : undefined)); }
  catch (e) { return c.json({ error: "patents_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});
paidHttp.post("/paid/legal/regulations", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try { return c.json(await searchRegulations(body.query ? String(body.query) : "", body.status ? String(body.status) : undefined)); }
  catch (e) { return c.json({ error: "regulations_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});

// ─── Academic & Scientific Routes (v0.11.0) ──────────────────────────
paidHttp.post("/paid/academic/papers", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try { return c.json(await searchPapers(body.query ? String(body.query) : "", typeof body.limit === "number" ? body.limit : undefined)); }
  catch (e) { return c.json({ error: "papers_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});
paidHttp.post("/paid/academic/arxiv", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try { return c.json(await searchArxiv(body.query ? String(body.query) : "", body.category ? String(body.category) : undefined, typeof body.limit === "number" ? body.limit : undefined)); }
  catch (e) { return c.json({ error: "arxiv_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});
paidHttp.post("/paid/academic/pubmed", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try { return c.json(await searchPubmed(body.query ? String(body.query) : "", typeof body.limit === "number" ? body.limit : undefined)); }
  catch (e) { return c.json({ error: "pubmed_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});
paidHttp.post("/paid/academic/clinical-trials", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try { return c.json(await searchClinicalTrials(body.query ? String(body.query) : "", body.status ? String(body.status) : undefined, typeof body.limit === "number" ? body.limit : undefined)); }
  catch (e) { return c.json({ error: "clinical_trials_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});
paidHttp.post("/paid/academic/openalex", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try { return c.json(await searchOpenAlex(body.query ? String(body.query) : "", typeof body.limit === "number" ? body.limit : undefined)); }
  catch (e) { return c.json({ error: "openalex_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});

// ─── Public Health & Safety Routes (v0.11.0) ────────────────────────
paidHttp.post("/paid/health/drug-recalls", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try { return c.json(await searchDrugRecalls(body.query ? String(body.query) : undefined, typeof body.limit === "number" ? body.limit : undefined)); }
  catch (e) { return c.json({ error: "drug_recalls_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});
paidHttp.post("/paid/health/adverse-events", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try { return c.json(await searchAdverseEvents(body.drug ? String(body.drug) : "", typeof body.limit === "number" ? body.limit : undefined)); }
  catch (e) { return c.json({ error: "adverse_events_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});
paidHttp.post("/paid/health/product-recalls", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try { return c.json(await searchProductRecalls(body.query ? String(body.query) : undefined, typeof body.limit === "number" ? body.limit : undefined)); }
  catch (e) { return c.json({ error: "product_recalls_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});
paidHttp.post("/paid/health/vehicle-recalls", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try { return c.json(await searchVehicleRecalls(body.make ? String(body.make) : undefined, body.model ? String(body.model) : undefined, body.vin ? String(body.vin) : undefined)); }
  catch (e) { return c.json({ error: "vehicle_recalls_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});
paidHttp.post("/paid/health/drug-labels", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try { return c.json(await searchDrugLabels(body.drug_name ? String(body.drug_name) : "", typeof body.limit === "number" ? body.limit : undefined)); }
  catch (e) { return c.json({ error: "drug_labels_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});

// ─── Environmental & Climate Routes (v0.11.0) ───────────────────────
paidHttp.post("/paid/env/wildfires", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try { return c.json(await getWildfires(typeof body.limit === "number" ? body.limit : undefined, body.region ? String(body.region) : undefined)); }
  catch (e) { return c.json({ error: "wildfires_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});
paidHttp.post("/paid/env/weather-alerts", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try { return c.json(await getWeatherAlerts(body.state ? String(body.state) : undefined, body.zone ? String(body.zone) : undefined)); }
  catch (e) { return c.json({ error: "weather_alerts_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});
paidHttp.post("/paid/env/tides", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try { return c.json(await getTideData(body.station ? String(body.station) : undefined, body.date ? String(body.date) : undefined)); }
  catch (e) { return c.json({ error: "tides_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});
paidHttp.post("/paid/env/space-weather", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try { return c.json(await getSpaceWeather(body.type ? String(body.type) : undefined, typeof body.days === "number" ? body.days : undefined)); }
  catch (e) { return c.json({ error: "space_weather_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});
paidHttp.post("/paid/env/water-levels", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try { return c.json(await getWaterLevels(body.state ? String(body.state) : undefined, body.parameter_code ? String(body.parameter_code) : undefined)); }
  catch (e) { return c.json({ error: "water_levels_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});

// ─── Government Spending & Contracts Routes (v0.11.0) ───────────────
paidHttp.post("/paid/gov/federal-spending", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try { return c.json(await searchFederalSpending(body.agency ? String(body.agency) : undefined, body.recipient ? String(body.recipient) : undefined, typeof body.limit === "number" ? body.limit : undefined)); }
  catch (e) { return c.json({ error: "federal_spending_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});
paidHttp.post("/paid/gov/national-debt", async (c) => {
  try { return c.json(await getNationalDebt()); }
  catch (e) { return c.json({ error: "national_debt_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});
paidHttp.post("/paid/gov/federal-grants", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try { return c.json(await searchFederalGrants(body.query ? String(body.query) : undefined, body.status ? String(body.status) : undefined, typeof body.limit === "number" ? body.limit : undefined)); }
  catch (e) { return c.json({ error: "federal_grants_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});
paidHttp.post("/paid/gov/nonprofits", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try { return c.json(await searchNonprofitFilings(body.query ? String(body.query) : "", body.state ? String(body.state) : undefined)); }
  catch (e) { return c.json({ error: "nonprofits_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});
paidHttp.post("/paid/gov/economic-indicators", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try { return c.json(await getEconomicIndicators(body.country ? String(body.country) : undefined, body.indicator ? String(body.indicator) : undefined)); }
  catch (e) { return c.json({ error: "economic_indicators_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});
paidHttp.post("/paid/gov/lobbying", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try { return c.json(await searchLobbyingRecords(body.lobbyist ? String(body.lobbyist) : undefined, body.client ? String(body.client) : undefined, typeof body.year === "number" ? body.year : undefined)); }
  catch (e) { return c.json({ error: "lobbying_failed", message: e instanceof Error ? e.message : String(e) }, 502); }
});


// ── Finance, Polymarket advanced, Security extra, Social, Utility, Legal extra, Health extra, Gov extra, Academic extra, Media (v0.14) ──
paidHttp.post("/paid/finance/edgar", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await searchEdgarFilings(b.query ? String(b.query) : "", b.form_type ? String(b.form_type) : undefined, b.ticker ? String(b.ticker) : undefined, typeof b.limit === "number" ? b.limit : undefined)); } catch (e: any) { return c.json({ error: "edgar_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/finance/insider-trades", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await getInsiderTrades(b.ticker ? String(b.ticker) : undefined, typeof b.limit === "number" ? b.limit : undefined)); } catch (e: any) { return c.json({ error: "insider_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/finance/fred", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await getFredSeries(b.series_id ? String(b.series_id) : undefined, typeof b.limit === "number" ? b.limit : undefined)); } catch (e: any) { return c.json({ error: "fred_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/polymarket/combinatorial-arb", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await scanCombinatorialArb(typeof b.limit === "number" ? b.limit : undefined)); } catch (e: any) { return c.json({ error: "comb_arb_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/polymarket/orderbook-imbalance", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await getOrderbookImbalance(b.token_id ? String(b.token_id) : undefined, b.condition_id ? String(b.condition_id) : undefined, typeof b.limit === "number" ? b.limit : undefined)); } catch (e: any) { return c.json({ error: "obi_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/polymarket/smart-money", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await getSmartMoney(typeof b.limit === "number" ? b.limit : undefined, b.timeframe ? String(b.timeframe) : undefined)); } catch (e: any) { return c.json({ error: "smart_money_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/security/cve-search", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await searchCVEs(b.keyword ? String(b.keyword) : undefined, b.cve_id ? String(b.cve_id) : undefined, b.severity ? String(b.severity) : undefined, typeof b.limit === "number" ? b.limit : undefined)); } catch (e: any) { return c.json({ error: "cve_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/security/company-registry", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await searchCompanies(b.query ? String(b.query) : "", b.jurisdiction ? String(b.jurisdiction) : undefined, typeof b.limit === "number" ? b.limit : undefined)); } catch (e: any) { return c.json({ error: "company_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/social/reddit", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await searchReddit(b.query ? String(b.query) : "", b.subreddit ? String(b.subreddit) : undefined, b.sort ? String(b.sort) : undefined, typeof b.limit === "number" ? b.limit : undefined)); } catch (e: any) { return c.json({ error: "reddit_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/social/github-repo", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await getRepoIntel(b.repo ? String(b.repo) : "")); } catch (e: any) { return c.json({ error: "repo_intel_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/utility/currency", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await getExchangeRates(b.base ? String(b.base) : undefined, b.target ? String(b.target) : undefined)); } catch (e: any) { return c.json({ error: "currency_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/utility/business-days", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await getBusinessDays(b.start_date ? String(b.start_date) : undefined, b.end_date ? String(b.end_date) : undefined, typeof b.days_ahead === "number" ? b.days_ahead : undefined)); } catch (e: any) { return c.json({ error: "business_days_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/legal/judges", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await searchJudges(b.query ? String(b.query) : "", b.court ? String(b.court) : undefined)); } catch (e: any) { return c.json({ error: "judges_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/legal/trademarks", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await searchTrademarks(b.query ? String(b.query) : "", b.owner ? String(b.owner) : undefined)); } catch (e: any) { return c.json({ error: "trademarks_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/health/outbreaks", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await searchDiseaseOutbreaks(b.query ? String(b.query) : undefined, typeof b.limit === "number" ? b.limit : undefined)); } catch (e: any) { return c.json({ error: "outbreaks_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/health/food-safety", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await searchFoodSafety(b.query ? String(b.query) : undefined, typeof b.limit === "number" ? b.limit : undefined)); } catch (e: any) { return c.json({ error: "food_safety_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/gov/contracts", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await searchFederalContracts(b.query ? String(b.query) : undefined, b.agency ? String(b.agency) : undefined, typeof b.limit === "number" ? b.limit : undefined)); } catch (e: any) { return c.json({ error: "contracts_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/academic/paper-details", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await getPaperDetails(b.paperId ? String(b.paperId) : "")); } catch (e: any) { return c.json({ error: "paper_details_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/academic/citations", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await getCitationGraph(b.paperId ? String(b.paperId) : "", b.direction === "backward" ? "backward" : "forward")); } catch (e: any) { return c.json({ error: "citations_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/media/gen-video", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await genVideoIntel(b.query ? String(b.query) : "", b.model ? String(b.model) : undefined)); } catch (e: any) { return c.json({ error: "gen_video_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/media/model-settings", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await modelSettingsLookup(b.model ? String(b.model) : "", b.task ? String(b.task) : undefined)); } catch (e: any) { return c.json({ error: "model_settings_failed", message: e?.message ?? String(e) }, 502); } });

// ── Quick Tools routes (v0.14 — free no-key APIs) ──
paidHttp.post("/paid/env/space-weather-kp", async (c) => { try { return c.json(await getSpaceWeatherKp()); } catch (e: any) { return c.json({ error: "space_weather_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/env/weather-forecast", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await getWeatherForecast(typeof b.lat === "number" ? b.lat : 0, typeof b.lon === "number" ? b.lon : 0)); } catch (e: any) { return c.json({ error: "forecast_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/env/weather-current", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await getWeatherCurrent(typeof b.lat === "number" ? b.lat : 0, typeof b.lon === "number" ? b.lon : 0, b.variables ? String(b.variables) : undefined)); } catch (e: any) { return c.json({ error: "current_weather_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/env/aurora", async (c) => { try { return c.json(await getAuroraForecast()); } catch (e: any) { return c.json({ error: "aurora_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/env/marine", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await getMarineConditions(typeof b.lat === "number" ? b.lat : 0, typeof b.lon === "number" ? b.lon : 0)); } catch (e: any) { return c.json({ error: "marine_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/health/air-quality", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await getAirQualityIndex(typeof b.lat === "number" ? b.lat : 0, typeof b.lon === "number" ? b.lon : 0, b.variables ? String(b.variables) : undefined)); } catch (e: any) { return c.json({ error: "air_quality_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/gov/postal-lookup", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await getPostalLookup(b.country ? String(b.country) : "us", b.postal_code ? String(b.postal_code) : "")); } catch (e: any) { return c.json({ error: "postal_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/osint/ip-geo", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await getIpGeolocation(b.ip ? String(b.ip) : "")); } catch (e: any) { return c.json({ error: "ip_geo_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/osint/timezone", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await getTimezoneCurrent(b.timezone ? String(b.timezone) : "UTC")); } catch (e: any) { return c.json({ error: "timezone_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/osint/airport", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await getAirportStatus(b.icao ? String(b.icao) : "")); } catch (e: any) { return c.json({ error: "airport_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/security/dns-lookup", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await getDnsRecords(b.domain ? String(b.domain) : "", b.type ? String(b.type) : undefined)); } catch (e: any) { return c.json({ error: "dns_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/academic/isbn", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await getIsbnLookup(b.isbn ? String(b.isbn) : "")); } catch (e: any) { return c.json({ error: "isbn_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/finance/crypto-price", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await getCryptoPrice(b.coin ? String(b.coin) : "bitcoin", b.currency ? String(b.currency) : undefined)); } catch (e: any) { return c.json({ error: "crypto_price_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/finance/btc-balance", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await getBtcBalance(b.address ? String(b.address) : "", typeof b.limit === "number" ? b.limit : undefined)); } catch (e: any) { return c.json({ error: "btc_balance_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/finance/btc-fees", async (c) => { try { return c.json(await getBtcFees()); } catch (e: any) { return c.json({ error: "btc_fees_failed", message: e?.message ?? String(e) }, 502); } });
paidHttp.post("/paid/health/food-recall", async (c) => { const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as any)); try { return c.json(await getFoodRecalls(b.query ? String(b.query) : undefined, typeof b.limit === "number" ? b.limit : undefined)); } catch (e: any) { return c.json({ error: "food_recall_failed", message: e?.message ?? String(e) }, 502); } });

const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

type RpcReceipt = {
  transactionHash: string;
  blockNumber: string;
  status: string;
  logs: Array<{
    address: string;
    topics: string[];
    data: string;
    transactionHash: string;
  }>;
};

type AgentResource = {
  name: string;
  category: string;
  url: string;
  price: string;
  tags: string[];
  note: string;
};

const RESOURCE_ATLAS: AgentResource[] = [
  { name: "PayAI x402 facilitator", category: "payments", url: "https://facilitator.payai.network", price: "free tier", tags: ["x402", "base", "usdc", "facilitator"], note: "No-auth facilitator currently used by agenttoll.dev." },
  { name: "Coinbase CDP x402 facilitator", category: "payments", url: "https://docs.cdp.coinbase.com/x402", price: "account required", tags: ["x402", "coinbase", "cdp"], note: "More official path, but needs CDP API-key signing." },
  { name: "Cloudflare Workers", category: "compute", url: "https://workers.cloudflare.com/", price: "free tier", tags: ["edge", "worker", "fetch", "htmlrewriter"], note: "Good default for tiny paid agent APIs." },
  { name: "HTMLRewriter", category: "scraping", url: "https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/", price: "included", tags: ["html", "parser", "cloudflare"], note: "Worker-native HTML parser, no browser needed." },
  { name: "Cloudflare DNS over HTTPS", category: "data", url: "https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/", price: "free", tags: ["dns", "enrichment", "lead"], note: "Cheap DNS enrichment without a paid vendor." },
  { name: "Public APIs list", category: "data", url: "https://github.com/public-apis/public-apis", price: "free", tags: ["api", "directory", "data"], note: "Raw material for agent resource lookup." },
  { name: "Awesome self-hosted", category: "software", url: "https://github.com/awesome-selfhosted/awesome-selfhosted", price: "free", tags: ["self-hosted", "alternatives", "software"], note: "Good source for replacement tools and vertical software." },
  { name: "AgenC", category: "marketplace", url: "https://agenc.ag", price: "market-priced", tags: ["agents", "solana", "escrow", "tasks"], note: "Agent labor marketplace. Useful pattern source for receipts and escrow." },
  { name: "x402scan", category: "discovery", url: "https://x402scan.com/", price: "free", tags: ["x402", "directory", "payments"], note: "Discovery surface for x402 endpoints." },
  { name: "CDP x402 Bazaar API", category: "discovery", url: "https://api.cdp.coinbase.com/platform/v2/x402/discovery/search", price: "free read", tags: ["x402", "bazaar", "cdp", "catalog"], note: "Semantic search over listed x402 resources; filter by network eip155:8453." },
  { name: "awesome-x402", category: "discovery", url: "https://github.com/xpaysh/awesome-x402", price: "free", tags: ["x402", "sdk", "facilitator"], note: "Curated x402 SDKs, facilitators, and examples." },
  { name: "Exa search (x402)", category: "data", url: "https://api.exa.ai/search", price: "x402 ~$0.007", tags: ["search", "x402", "bazaar"], note: "Listed on Bazaar with schemas; web search for agents." },
  { name: "search.gedx402.com", category: "data", url: "https://search.gedx402.com/v1/search", price: "x402", tags: ["search", "x402", "base"], note: "Paid web search on Base mainnet." },
  { name: "x402.org ecosystem", category: "discovery", url: "https://www.x402.org/ecosystem", price: "free", tags: ["x402", "directory"], note: "Official ecosystem directory." },
  { name: "Playwright", category: "scraping", url: "https://playwright.dev/", price: "free/self-hosted", tags: ["browser", "automation", "scraping"], note: "Use only when Worker fetch is not enough." },
  { name: "NocoDB", category: "sales", url: "https://www.nocodb.com/", price: "open source", tags: ["crm", "database", "airtable"], note: "Self-hosted Airtable-style backend for lead workflows." },
  { name: "Twenty CRM", category: "sales", url: "https://twenty.com/", price: "open source", tags: ["crm", "sales", "leads"], note: "Open source CRM option for lead-gen operations." },
];

function normalizeDomainInput(input: string) {
  return input.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "");
}

function normalizeSiteUrl(input: string) {
  const trimmed = input.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function unique<T>(items: T[]) {
  return Array.from(new Set(items));
}

function scoreLeadFromSignals(enrichment: Awaited<ReturnType<typeof enrichDomain>>) {
  let score = 0;
  const reasons: string[] = [];
  const penalties: string[] = [];

  if (enrichment.https) { score += 10; reasons.push("HTTPS enabled"); }
  if (enrichment.status > 0 && enrichment.status < 400) { score += 15; reasons.push(`homepage returned HTTP ${enrichment.status}`); }
  else { score -= 15; penalties.push(`homepage status ${enrichment.status || "unreachable"}`); }
  if (enrichment.description.length > 80) { score += 10; reasons.push("clear meta description"); }
  if (enrichment.tech_stack.length >= 2) { score += 15; reasons.push(`${enrichment.tech_stack.length} tech signals`); }
  if (enrichment.tech_stack.some((t) => ["hubspot", "intercom", "stripe", "shopify"].includes(t))) { score += 15; reasons.push("commercial tooling detected"); }
  if (Object.keys(enrichment.social).length > 0) { score += 10; reasons.push("social links found"); }
  if (enrichment.contact_links.length > 0) { score += 15; reasons.push("contact/about/pricing paths found"); }
  if (enrichment.dns.a.length > 0) { score += 5; reasons.push("A records found"); }
  if (enrichment.detected_platform) { score += 5; reasons.push(`${enrichment.detected_platform} platform cue`); }
  if (enrichment.error) { score -= 20; penalties.push(enrichment.error); }

  score = Math.max(0, Math.min(100, score));
  const band = score >= 75 ? "strong" : score >= 50 ? "workable" : score >= 30 ? "weak" : "poor";
  return { score, band, reasons, penalties };
}

async function detectStack(url: string) {
  const scrape = await scrapeUrl(normalizeSiteUrl(url));
  return {
    url: scrape.final_url,
    status: scrape.status,
    title: scrape.title,
    tech_stack: scrape.tech_signals,
    framework: scrape.tech_signals.find((t) => ["next.js", "nuxt", "react", "vue", "angular", "svelte"].includes(t)) ?? null,
    platform: scrape.tech_signals.find((t) => ["wordpress", "shopify", "squarespace", "wix", "webflow", "ghost"].includes(t)) ?? null,
    analytics: scrape.tech_signals.filter((t) => ["google-analytics", "hotjar", "plausible", "segment", "sentry"].includes(t)),
    commerce: scrape.tech_signals.filter((t) => ["stripe", "shopify"].includes(t)),
    checked_at: new Date().toISOString(),
    error: scrape.error,
  };
}

async function extractContacts(url: string) {
  // secrets-only scrub so business emails/phones remain extractable
  const scrape = await scrapeUrl(normalizeSiteUrl(url), { scrub: "secrets" });
  const text = `${scrape.title}\n${scrape.description}\n${scrape.text_content}\n${scrape.links.map((l) => `${l.text} ${l.href}`).join("\n")}`;
  const emails = unique(Array.from(text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)).map((m) => m[0].toLowerCase())).slice(0, 25);
  const phones = unique(Array.from(text.matchAll(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/g)).map((m) => m[0])).slice(0, 25);
  const social = scrape.links.filter((l) => /linkedin\.com|github\.com|twitter\.com|x\.com|youtube\.com|discord\.(gg|com)|facebook\.com|instagram\.com/i.test(l.href)).slice(0, 25);
  const contact_links = scrape.links.filter((l) => /contact|about|team|sales|pricing|careers|jobs|support/i.test(`${l.href} ${l.text}`)).slice(0, 25);
  // Business contact product keeps emails/phones; still force secret scrub on all string fields.
  return scrubContactPayload({
    url: scrape.final_url,
    status: scrape.status,
    title: scrubText(scrape.title || "", "secrets"),
    emails,
    phones,
    social,
    contact_links,
    checked_at: new Date().toISOString(),
    error: scrape.error,
    scrub_policy: "secrets_only_contacts_preserved",
  });
}

async function scoreLead(domain: string) {
  const enrichment = await enrichDomain(domain);
  return {
    domain: enrichment.domain,
    company_name: enrichment.company_name,
    ...scoreLeadFromSignals(enrichment),
    signals: {
      tech_stack: enrichment.tech_stack,
      social_count: Object.keys(enrichment.social).length,
      contact_link_count: enrichment.contact_links.length,
      platform: enrichment.detected_platform,
      dns_a_count: enrichment.dns.a.length,
    },
    recommended_next_action: enrichment.contact_links[0] ? "open_contact_or_pricing_path" : "manual_review",
    enriched_at: enrichment.enriched_at,
  };
}

async function checkAgentPolicy(domain: string) {
  const base = `https://${normalizeDomainInput(domain)}`;
  const paths = ["/robots.txt", "/llms.txt", "/.well-known/agent.json", "/.well-known/security.txt"];
  const checks = await Promise.all(paths.map(async (path) => {
    const url = `${base}${path}`;
    try {
      const response = await fetch(url, { headers: { "User-Agent": "agenttoll.dev/1.0" } });
      const text = await response.text();
      return {
        path,
        url,
        status: response.status,
        found: response.status >= 200 && response.status < 400,
        snippet: text.slice(0, 1200),
      };
    } catch (error) {
      return { path, url, status: 0, found: false, snippet: "", error: error instanceof Error ? error.message : String(error) };
    }
  }));

  const robots = checks.find((check) => check.path === "/robots.txt")?.snippet ?? "";
  return {
    domain: normalizeDomainInput(domain),
    checked_at: new Date().toISOString(),
    has_robots: checks.some((check) => check.path === "/robots.txt" && check.found),
    has_llms_txt: checks.some((check) => check.path === "/llms.txt" && check.found),
    has_agent_json: checks.some((check) => check.path === "/.well-known/agent.json" && check.found),
    has_security_txt: checks.some((check) => check.path === "/.well-known/security.txt" && check.found),
    robots_mentions_ai: /ai|agent|bot|gpt|anthropic|openai|claude/i.test(robots),
    checks,
  };
}

function findAgentResource(query: string, category?: string) {
  const q = query.toLowerCase().trim();
  const c = category?.toLowerCase().trim();
  const terms = q.split(/\s+/).filter(Boolean);
  return RESOURCE_ATLAS
    .filter((item) => !c || item.category.includes(c) || item.tags.some((tag) => tag.includes(c)))
    .map((item) => {
      const haystack = `${item.name} ${item.category} ${item.tags.join(" ")} ${item.note}`.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0) + (c && item.category.includes(c) ? 2 : 0);
      return { ...item, score, source: "atlas" as const };
    })
    .filter((item) => item.score > 0 || !q)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 8);
}

const BAZAAR_SEARCH_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/search";

async function searchBazaarLive(query: string, limit = 6) {
  const url = new URL(BAZAAR_SEARCH_URL);
  url.searchParams.set("query", query.trim() || "search");
  url.searchParams.set("network", SERVICE.network);
  url.searchParams.set("limit", String(Math.min(20, Math.max(1, limit))));
  try {
    const response = await fetch(url.toString(), {
      headers: { Accept: "application/json", "User-Agent": "agenttoll.dev/1.0" },
    });
    if (!response.ok) return [];
    const data = await response.json() as {
      resources?: Array<{ resource?: string; description?: string; metadata?: { description?: string } }>;
    };
    return (data.resources ?? [])
      .filter((row) => row.resource)
      .map((row) => {
        let host = row.resource ?? "";
        try {
          const parsed = new URL(row.resource!);
          host = `${parsed.hostname}${parsed.pathname}`.slice(0, 72);
        } catch {
          host = (row.resource ?? "").slice(0, 72);
        }
        const note = (row.metadata?.description ?? row.description ?? "Listed on CDP x402 Bazaar.").slice(0, 220);
        return {
          name: host,
          category: "x402-bazaar",
          url: row.resource!,
          price: "x402 USDC",
          tags: ["x402", "bazaar", "live"],
          note,
          score: 10,
          source: "cdp_bazaar" as const,
        };
      });
  } catch {
    return [];
  }
}

async function findAgentResourceMerged(query: string, category?: string) {
  const local = findAgentResource(query, category);
  const wantLive = Boolean(query.trim()) && (!category || ["discovery", "x402", "data", "payments"].includes(category.toLowerCase()));
  const live = wantLive ? await searchBazaarLive(query) : [];
  const seen = new Set<string>();
  const merged = [...live, ...local].filter((item) => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
  return merged.slice(0, 10);
}

async function proxyBazaarSearch(request: Request) {
  const incoming = new URL(request.url);
  const query = incoming.searchParams.get("query") ?? "search";
  const limit = Math.min(20, Math.max(1, Number.parseInt(incoming.searchParams.get("limit") ?? "10", 10) || 10));
  const network = incoming.searchParams.get("network") ?? SERVICE.network;
  const target = new URL(BAZAAR_SEARCH_URL);
  target.searchParams.set("query", query);
  target.searchParams.set("network", network);
  target.searchParams.set("limit", String(limit));
  const response = await fetch(target.toString(), {
    headers: { Accept: "application/json", "User-Agent": "agenttoll.dev/1.0" },
  });
  const text = await response.text();
  return new Response(text, {
    status: response.status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=120",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function validateAgentManifest(manifestJson: string) {
  let manifest: any;
  try {
    manifest = JSON.parse(manifestJson);
  } catch (error) {
    return { valid: false, errors: ["manifest_json is not valid JSON"], warnings: [], monetizable: false };
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const required = ["name", "description"];
  for (const field of required) if (!manifest[field]) errors.push(`missing ${field}`);
  const endpoint = manifest.mcp || manifest.endpoint || manifest.endpoints?.mcp;
  if (!endpoint) errors.push("missing MCP endpoint");
  if (!Array.isArray(manifest.tools) || manifest.tools.length === 0) errors.push("missing non-empty tools array");
  if (!manifest.payments && !manifest.payment) warnings.push("missing payment metadata");
  const payments = manifest.payments ?? manifest.payment ?? {};
  if (payments.protocol && payments.protocol !== "x402") warnings.push("payment protocol is not x402");
  if (!payments.network) warnings.push("missing payment network");
  if (!payments.asset && !payments.asset_contract) warnings.push("missing payment asset");

  const toolWarnings = Array.isArray(manifest.tools)
    ? manifest.tools.flatMap((tool: any, index: number) => {
        const out: string[] = [];
        if (!tool.name) out.push(`tool[${index}] missing name`);
        if (!tool.description) out.push(`tool[${index}] missing description`);
        if (!tool.input && !tool.input_schema) out.push(`tool[${index}] missing input schema`);
        if (!tool.price_usd && !tool.price && !tool.free) out.push(`tool[${index}] missing price/free marker`);
        return out;
      })
    : [];

  return {
    valid: errors.length === 0,
    monetizable: errors.length === 0 && !warnings.includes("missing payment metadata"),
    errors,
    warnings: [...warnings, ...toolWarnings],
    normalized: {
      name: manifest.name ?? null,
      endpoint: endpoint ?? null,
      tool_count: Array.isArray(manifest.tools) ? manifest.tools.length : 0,
      payment_protocol: payments.protocol ?? null,
      payment_network: payments.network ?? null,
    },
  };
}

export class TollboothMCP extends McpAgent<Env> {
  server = withX402(
    new McpServer({ name: "tollbooth", version: SERVICE.version }),
    X402_CONFIG,
  );

  async init() {
    this.server.tool(
      "ping",
      "Health check. Returns pong + server time + tool catalog.",
      {},
      async () => ({
        content: [{
          type: "text",
          text: JSON.stringify({
            pong: true,
            server_time: new Date().toISOString(),
            service: `tollbooth v${SERVICE.version}`,
            network: SERVICE.network,
            tools: TOOLS,
          }),
        }],
      }),
    );

    this.server.paidTool(
      "scrape",
      "Fetch a URL and return clean structured content: title, description, meta tags, text content, headings, links, and tech stack signals. Works on HTML and JSON pages.",
      0.01,
      {
        url: z.string().describe("The URL to scrape (include https://)"),
      },
      {},
      async ({ url }) => {
        const result = await scrapeUrl(url);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(result),
          }],
        };
      },
    );

    this.server.paidTool(
      "detect_stack",
      "Fingerprint a URL for framework, analytics, hosting, payment, CRM, and site-platform signals.",
      0.02,
      { url: z.string().describe("The URL to inspect (include https://)") },
      {},
      async ({ url }) => ({ content: [{ type: "text", text: JSON.stringify(await detectStack(url)) }] }),
    );

    this.server.paidTool(
      "extract_contacts",
      "Extract visible emails, phone-like strings, social links, and contact/about/pricing/careers URLs from a page.",
      0.02,
      { url: z.string().describe("The URL to inspect (include https://)") },
      {},
      async ({ url }) => ({ content: [{ type: "text", text: JSON.stringify(await extractContacts(url)) }] }),
    );

    this.server.paidTool(
      "score_lead",
      "Score a company domain for outbound fit using HTTPS, DNS, tech stack, contact paths, social links, platform, and copy depth.",
      0.03,
      { domain: z.string().describe("Company domain, e.g. stripe.com") },
      {},
      async ({ domain }) => ({ content: [{ type: "text", text: JSON.stringify(await scoreLead(domain)) }] }),
    );

    this.server.paidTool(
      "check_agent_policy",
      "Check robots.txt, llms.txt, security.txt, and agent.json for crawl/discovery signals before an agent touches a site.",
      0.01,
      { domain: z.string().describe("Domain to check, e.g. example.com") },
      {},
      async ({ domain }) => ({ content: [{ type: "text", text: JSON.stringify(await checkAgentPolicy(domain)) }] }),
    );

    this.server.paidTool(
      "find_agent_resource",
      "Search a small curated atlas of agent-useful APIs, self-hosted tools, payment rails, scraping helpers, and automation primitives.",
      0.01,
      {
        query: z.string().describe("Search query"),
        category: z.string().optional().describe("Optional category filter"),
      },
      {},
      async ({ query, category }) => ({ content: [{ type: "text", text: JSON.stringify({ query, category, results: await findAgentResourceMerged(query, category) }) }] }),
    );

    this.server.paidTool(
      "validate_agent_manifest",
      "Validate an agent manifest for identity, endpoint, tools, pricing, and payment fields.",
      0.03,
      { manifest_json: z.string().describe("agent manifest as a JSON string") },
      {},
      async ({ manifest_json }) => ({ content: [{ type: "text", text: JSON.stringify(validateAgentManifest(manifest_json)) }] }),
    );

    this.server.paidTool(
      "enrich_lead",
      "Enrich a company domain. Returns company name, description, detected tech stack, social media links, DNS records, platform detection (WordPress/Shopify/etc.), and contact page links. Useful for lead scoring and prospect research.",
      0.05,
      {
        domain: z.string().describe("Company domain (e.g. stripe.com or https://stripe.com)"),
      },
      {},
      async ({ domain }) => {
        const result = await enrichDomain(domain);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(result),
          }],
        };
      },
    );

    this.server.paidTool(
      "polymarket_event_scan",
      "Scan one live Polymarket negRisk event for fee-adjusted outcome-sum violations. Intelligence only; verify CLOB depth and resolution rules before acting.",
      0.03,
      {
        slug: z.string().describe("Polymarket event slug"),
        min_edge: z.number().min(0).max(0.5).optional().describe("Minimum net edge, default 0.02"),
        min_liquidity: z.number().min(0).optional().describe("Minimum liquidity per leg in USD, default 1000"),
      },
      {},
      async ({ slug, min_edge, min_liquidity }) => ({
        content: [{ type: "text", text: JSON.stringify(await scanPolymarketEvent({ slug, minEdge: min_edge, minLiquidity: min_liquidity })) }],
      }),
    );

    this.server.paidTool(
      "polymarket_market_scan",
      "Scan high-volume active Polymarket markets for resolution candidates and fee-adjusted YES+NO bundle violations. Intelligence only; verify live books and rules before acting.",
      0.05,
      {
        limit: z.number().int().min(10).max(200).optional().describe("Markets to scan, default 100"),
        min_certainty: z.number().min(0.5).max(1).optional().describe("Resolution-candidate threshold, default 0.95"),
        min_edge: z.number().min(0).max(0.5).optional().describe("Minimum bundle net edge, default 0.02"),
        min_liquidity: z.number().min(0).optional().describe("Minimum liquidity in USD, default 1000"),
        min_volume_24h: z.number().min(0).optional().describe("Minimum 24h volume in USD, default 5000"),
      },
      {},
      async ({ limit, min_certainty, min_edge, min_liquidity, min_volume_24h }) => ({
        content: [{ type: "text", text: JSON.stringify(await scanPolymarketMarkets({
          limit,
          minCertainty: min_certainty,
          minEdge: min_edge,
          minLiquidity: min_liquidity,
          minVolume24h: min_volume_24h,
        })) }],
      }),
    );

    this.server.paidTool(
      "cross_platform_arb_scan",
      "Match live Polymarket and Kalshi markets for a topic and compare complementary asks after conservative fee estimates. Intelligence only; verify both rulebooks before acting.",
      0.10,
      {
        query: z.string().min(2).max(100).describe("Topic, entity, asset, or market phrase such as bitcoin"),
        min_similarity: z.number().min(0.4).max(1).optional().describe("Minimum semantic-token match score, default 0.62"),
        min_net_edge: z.number().min(0).max(0.5).optional().describe("Minimum fee-adjusted edge, default 0.015"),
        polymarket_limit: z.number().int().min(100).max(1000).optional().describe("Polymarket markets to screen, default 1000"),
        kalshi_max_pages: z.number().int().min(1).max(20).optional().describe("Kalshi pages of 1000 markets, default 12"),
        max_matches: z.number().int().min(1).max(50).optional().describe("Maximum matches and opportunities returned, default 25"),
      },
      {},
      async ({ query, min_similarity, min_net_edge, polymarket_limit, kalshi_max_pages, max_matches }) => ({
        content: [{ type: "text", text: JSON.stringify(await scanCrossPlatformMarkets({
          query,
          minSimilarity: min_similarity,
          minNetEdge: min_net_edge,
          polymarketLimit: polymarket_limit,
          kalshiMaxPages: kalshi_max_pages,
          maxMatches: max_matches,
        })) }],
      }),
    );

    // ─── Agent Security Tools ──────────────────────────────────────────────

    this.server.paidTool(
      "agent_threat_intel",
      "Query the OWASP Agentic Top 10 threat catalog (ASI01-ASI10). Returns threats, detection hints, mitigations, and mapped detection rule IDs.",
      0.03,
      {
        category: z.string().optional().describe("Filter by category, e.g. 'prompt injection', 'supply chain'"),
        id: z.string().optional().describe("Specific threat ID, e.g. ASI04"),
        severity: z.string().optional().describe("Filter: critical, high, medium"),
      },
      {},
      async ({ category, id, severity }) => ({
        content: [{ type: "text", text: JSON.stringify(queryThreatCatalog({ category, id, severity })) }],
      }),
    );

    this.server.paidTool(
      "mcp_supply_chain_iocs",
      "Query known-malicious MCP packages, versions, C2 hosts, and email IOCs. The virus database for MCP.",
      0.02,
      {
        package: z.string().optional().describe("npm package name to check"),
        host: z.string().optional().describe("C2 host to check"),
      },
      {},
      async ({ package: pkg, host }) => ({
        content: [{ type: "text", text: JSON.stringify(queryMcpIocs({ package: pkg, host })) }],
      }),
    );

    this.server.paidTool(
      "agent_trifecta_score",
      "Score an agent's lethal trifecta risk (private data + untrusted content + outbound actions). Returns risk level, missing controls, and decomposition advice.",
      0.05,
      {
        has_private_data: z.boolean().describe("Does the agent access private/sensitive data?"),
        has_untrusted_content: z.boolean().describe("Does the agent process untrusted external content?"),
        has_outbound_actions: z.boolean().describe("Can the agent take outbound actions (send, write, call APIs)?"),
        compensating_controls: z.array(z.string()).describe("Controls in place, e.g. ['redact_secrets', 'smart_approvals']"),
      },
      {},
      async ({ has_private_data, has_untrusted_content, has_outbound_actions, compensating_controls }) => ({
        content: [{ type: "text", text: JSON.stringify(scoreTrifecta({ has_private_data, has_untrusted_content, has_outbound_actions, compensating_controls })) }],
      }),
    );

    this.server.paidTool(
      "agent_security_policies",
      "Get drop-in agent security policy templates by profile (coding-agent, browser-agent, payment-agent, research-agent).",
      0.05,
      {
        profile: z.string().optional().describe("Agent profile: coding-agent, browser-agent, payment-agent, research-agent"),
      },
      {},
      async ({ profile }) => ({
        content: [{ type: "text", text: JSON.stringify(getPolicyTemplates({ profile })) }],
      }),
    );

    // ── OSINT (OSINT: scenario engine + research pack + intervention-signal + feed monitor) ──
    this.server.paidTool(
      "geo_pulse",
      "Composite geopolitical intervention signal — GDELT + BBC + AlJazeera + ADS-B mil + prediction-market boosters (intervention signal pattern). Returns alert_level + signals array.",
      0.04,
      {
        region: z.string().optional().describe("global|middle_east|ukraine|taiwan|asia_pacific"),
        min_confidence: z.number().min(0).max(1).optional().describe("Min confidence 0-1, default 0.6"),
        hours_back: z.number().int().min(1).max(72).optional().describe("Hours back, default 6"),
        include_thermal: z.boolean().optional().describe("Include thermal/firms heuristic"),
      },
      {},
      async (args) => ({ content: [{ type: "text", text: JSON.stringify(await queryGeoPulse(args)) }] }),
    );
    this.server.paidTool(
      "flight_intel",
      "Exec-jet + military aircraft intel — TEB/VNY/DCA geofence, tail filter, B-52/F-35/E-3 detection via adsb.lol open. M&A / defense Polymarket edge.",
      0.03,
      {
        airport_code: z.string().optional().describe("Airport ICAO/IATA e.g. TEB, VNY, DCA"),
        tail_number: z.string().optional().describe("Tail e.g. N123AB"),
        hours_back: z.number().int().min(1).max(72).optional().describe("Hours back, default 12"),
      },
      {},
      async (args) => ({ content: [{ type: "text", text: JSON.stringify(await queryFlightIntel(args)) }] }),
    );
    this.server.paidTool(
      "research_pack",
      "Multi-source OSINT research pack — GDELT + BBC + HN + Reddit, 4-layer verification layer (existence+recency+multi-source+domain allowlist) + combined relevance scoring. research pack pipeline.",
      0.05,
      {
        topic: z.string().min(3).max(200).describe("Research topic query"),
        domains: z.array(z.string()).optional().describe("Optional domain filter allowlist"),
        include_sources: z.array(z.string()).optional().describe("Sources to include: gdelt, bbc, hn, reddit"),
        hours_back: z.number().int().min(1).max(720).optional().describe("Hours back, default 24"),
      },
      {},
      async (args) => ({ content: [{ type: "text", text: JSON.stringify(await queryResearchPack(args)) }] }),
    );
    this.server.paidTool(
      "scenario_verdict",
      "Scenario engine seed→entity→3-scenario verdict.json + composite YES prob mapped to market question. Input raw seed text + question, get bear/base/bull scenarios + fair_price_hint.",
      0.05,
      {
        seed_text: z.string().min(10).max(5000).describe("Raw seed text / headline pack"),
        market_question: z.string().min(5).max(500).describe("Polymarket/Yes-No market question"),
        context: z.string().max(2000).optional().describe("Optional context"),
      },
      {},
      async (args) => ({ content: [{ type: "text", text: JSON.stringify(await queryScenarioVerdict(args)) }] }),
    );
    this.server.paidTool(
      "weather_bias",
      "Weather bias vs recent mean — uses Open-Meteo archive+forecast and ticker mapping for Kalshi HIGH* fade edge.",
      0.03,
      {
        city: z.string().min(2).max(30).describe("NYC|CHI|MIA|LAX or lat,lon = NYC default"),
        model: z.string().max(50).optional().describe("Model name for provenance"),
        days_back: z.number().int().min(2).max(30).optional().describe("Days back for anomaly, default 7"),
      },
      {},
      async (args) => ({ content: [{ type: "text", text: JSON.stringify(await queryWeatherBias(args)) }] }),
    );
    this.server.paidTool(
      "supply_stress",
      "Supply-chain stress index — CBP BWT + GDELT chokepoint mentions + AIS/MarineTraffic hint, port congestion for freight/commodity/middle_east Polymarket edge.",
      0.03,
      {
        ports: z.array(z.string()).optional().describe("Ports e.g. LAX,NYC,HOU,LGB"),
        chokepoints: z.array(z.string()).optional().describe("Chokepoints e.g. hormuz,bab-el-mandeb,suez,bosphorus"),
      },
      {},
      async (args) => ({ content: [{ type: "text", text: JSON.stringify(await querySupplyStress(args)) }] }),
    );
    this.server.paidTool(
      "regulatory_pulse",
      "Regulatory pulse — SEC Atom RSS + openFDA adverse + USPTO TSDR + FCC OET + FAA registry hints for bio/tech Polymarkets. Returns events by org + provenance.",
      0.03,
      {
        org: z.string().optional().describe("all|sec|fda|uspto|fcc|faa|openfda"),
        hours_back: z.number().int().min(1).max(720).optional().describe("Hours back, default 24"),
      },
      {},
      async (args) => ({ content: [{ type: "text", text: JSON.stringify(await queryRegulatoryPulse(args)) }] }),
    );
    this.server.paidTool(
      "attention_momentum",
      "Attention momentum — HN Algolia + Reddit JSON velocity scoring, points/hr + momentum_score, viral flag for culture/pop/app-rank/YouTube/npm-dl Polymarkets. Proxies: pypistats, api.npmjs.org.",
      0.02,
      {
        query: z.string().max(200).optional().describe("Topic filter e.g. Claude Code"),
        window: z.string().optional().describe("1h|6h|24h, default 6h"),
      },
      {},
      async (args) => ({ content: [{ type: "text", text: JSON.stringify(await queryAttentionMomentum(args)) }] }),
    );
    this.server.paidTool(
      "sec_8k_velocity",
      "SEC 8-K velocity — EFTS FullTextSearch + Atom current, 1h spike vs 24h mean >3x, Item 1.05/2.02/5.02 boost. Earnings/merger/legal prediction-market lead. 9/sec TokenBucket, UA CompanyName Email per 17 CFR 200.80.",
      0.03,
      {
        hours: z.number().int().min(1).max(72).optional().describe("Hours back, default 6"),
        limit: z.number().int().min(10).max(200).optional().describe("Max rows, default 100"),
        min_score: z.number().min(0).max(1).optional().describe("Min score filter"),
      },
      {},
      async (args) => ({ content: [{ type: "text", text: JSON.stringify(await querySec8kVelocity(args)) }] }),
    );
    this.server.paidTool(
      "fred_surprises",
      "FRED rates surprise — DGS10 10Y + DGS2 2Y csv public-domain no-key, spread + inversion flag, delta scoring for FOMC Fed funds + rates markets. TokenBucket 2/s polite.",
      0.02,
      {
        days: z.number().int().min(5).max(90).optional().describe("Days back, default 14"),
        min_score: z.number().min(0).max(1).optional().describe("Min score"),
      },
      {},
      async (args) => ({ content: [{ type: "text", text: JSON.stringify(await queryFredSurprises(args)) }] }),
    );
    this.server.paidTool(
      "treasury_dts",
      "Treasury DTS TGA — operating_cash_balance free gov public-domain, TGA close $B d/d delta, deposits/withdrawals enrichment. Liquidity / debt-ceiling / SPX direction edge, 2nd upstream.",
      0.04,
      {
        days: z.number().int().min(2).max(30).optional().describe("Days back, default 7"),
        min_score: z.number().min(0).max(1).optional().describe("Min score"),
      },
      {},
      async (args) => ({ content: [{ type: "text", text: JSON.stringify(await queryTreasuryDts(args)) }] }),
    );

    // ── Extra public feeds (v1.0) — cached MCP tools ──────────────────
    this.server.paidTool(
      "openrouter_models",
      "OpenRouter model catalog — id, name, context_length, pricing, created. Cached 1h, auto-fetched via public API. For model routing decisions.",
      0.02,
      {
        limit: z.number().int().min(10).max(300).optional().describe("Max models to return, default 100"),
        min_context: z.number().int().min(0).optional().describe("Min context length filter"),
      },
      {},
      async (args) => {
        const data = await mcpGetCachedOrLive(this.env, "openrouter-model-usage", async () => {
          const r = await fetch("https://openrouter.ai/api/v1/models", { headers: { "User-Agent": "agenttoll.dev/1.0" } });
          if (!r.ok) throw new Error(`openrouter ${r.status}`);
          const j = await r.json() as any;
          let models = Array.isArray(j?.data) ? j.data : [];
          if (args.min_context) models = models.filter((m: any) => (m.context_length ?? 0) >= args.min_context!);
          const limit = args.limit ?? 100;
          return { fetched_at: new Date().toISOString(), count: models.length, models: models.slice(0, limit).map((m: any) => ({ id: m.id, name: m.name, context_length: m.context_length, pricing: m.pricing, created: m.created })), provenance: "https://openrouter.ai/api/v1/models" };
        }, args);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.paidTool(
      "github_trending",
      "GitHub trending repos — stars >20 + recent push, sorted by stars desc. Public GitHub Search API no-key. Momentum proxy for dev tooling / open source virality.",
      0.02,
      {
        limit: z.number().int().min(5).max(50).optional().describe("Max repos, default 25"),
        language: z.string().max(50).optional().describe("Filter by language e.g. TypeScript"),
        since_days: z.number().int().min(1).max(90).optional().describe("Pushed within N days, default 7"),
      },
      {},
      async (args) => {
        const data = await mcpGetCachedOrLive(this.env, "github-trending", () => fetchGithubTrending(args), args);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.paidTool(
      "hn_frontpage",
      "HN frontpage live — Algolia front_page tag, dwell = points/(age_h+2). Cache 10min. Top stories sorted by dwell for attention-momentum edge.",
      0.02,
      {
        limit: z.number().int().min(5).max(50).optional().describe("Max stories, default 30"),
        min_points: z.number().int().min(0).optional().describe("Min points filter"),
      },
      {},
      async (args) => {
        const data = await mcpGetCachedOrLive(this.env, "hn-frontpage", () => fetchHnFrontpage(args), args);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.paidTool(
      "usgs_quake",
      "USGS all-day earthquakes — mag, place, time, tsunami, felt, coords, depth. Public USGS GeoJSON no-key. Disaster / insurance / commodity market tail-risk pulse.",
      0.02,
      {
        limit: z.number().int().min(5).max(200).optional().describe("Max quakes, default 50"),
        min_mag: z.number().min(0).max(10).optional().describe("Min magnitude e.g. 2.5"),
      },
      {},
      async (args) => {
        const data = await mcpGetCachedOrLive(this.env, "usgs-quake", () => fetchUsgsQuakes(args), args);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    this.server.paidTool(
      "openaq_air",
      "OpenAQ air quality — PM2.5/PM10/NO2/O3 by city/country, lastUpdated. v3 API + v2 fallback. Env / health / geo pulse. For PM market disclaimers.",
      0.02,
      {
        limit: z.number().int().min(5).max(100).optional().describe("Max locations, default 30"),
        country: z.string().max(10).optional().describe("ISO country code e.g. US"),
      },
      {},
      async (args) => {
        const data = await mcpGetCachedOrLive(this.env, "openaq-air", () => fetchOpenAq(args), args);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );

    // ── Legal & Regulatory Tools (v0.11.0) ──────────────────────────
    this.server.paidTool("court_opinions", "Search US federal court opinions by keyword, court, date via CourtListener (Free Law Project). Keyless.", 0.05, { query: z.string().describe("Search terms"), court: z.string().optional().describe("e.g. scotus, ca9"), days_back: z.number().int().optional().describe("Days back, default 90") }, {}, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await searchCourtOpinions(args.query, args.court, args.days_back)) }] }) );
    this.server.paidTool("court_docket", "Look up a federal court docket by ID via CourtListener RECAP archive. Parties, filings, dates.", 0.05, { docket_id: z.string().describe("Docket ID") }, {}, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await lookupCourtDocket(args.docket_id)) }] }) );
    this.server.paidTool("federal_register", "Search the daily Federal Register — proposed rules, final rules, presidential notices.", 0.03, { query: z.string().describe("Search terms"), agency: z.string().optional().describe("e.g. SEC, EPA"), type: z.string().optional().describe("RULE, NOTICE, PRORULE") }, {}, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await searchFederalRegister(args.query, args.agency, args.type)) }] }) );
    this.server.paidTool("patents_search", "Full-text patent search via Google Patents. Titles, assignees, dates, abstracts.", 0.04, { query: z.string().describe("Patent search terms"), limit: z.number().int().min(5).max(50).optional().describe("Max results, default 20") }, {}, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await searchPatents(args.query, args.limit)) }] }) );
    this.server.paidTool("regulations_search", "Search open rulemakings and public dockets. Falls back to Federal Register if no API key.", 0.03, { query: z.string().describe("Search terms"), status: z.string().optional().describe("e.g. open, closed") }, {}, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await searchRegulations(args.query, args.status)) }] }) );

    // ── Academic & Scientific Tools (v0.11.0) ───────────────────────
    this.server.paidTool("search_papers", "Search 226M+ academic papers across all fields with AI-ranked relevance via Semantic Scholar Graph API.", 0.04, { query: z.string().describe("Research query"), limit: z.number().int().min(5).max(50).optional().describe("Max results, default 20") }, {}, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await searchPapers(args.query, args.limit)) }] }) );
    this.server.paidTool("search_arxiv", "Search arXiv preprints in CS, physics, math, biology. Titles, authors, abstracts, categories.", 0.02, { query: z.string().describe("Search terms"), category: z.string().optional().describe("e.g. cs.CL, cs.LG"), limit: z.number().int().min(5).max(50).optional().describe("Max results, default 20") }, {}, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await searchArxiv(args.query, args.category, args.limit)) }] }) );
    this.server.paidTool("search_pubmed", "Search 37M+ biomedical papers via NCBI PubMed. PMIDs, titles, authors, journals.", 0.03, { query: z.string().describe("Biomedical query"), limit: z.number().int().min(5).max(50).optional().describe("Max results, default 20") }, {}, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await searchPubmed(args.query, args.limit)) }] }) );
    this.server.paidTool("clinical_trials", "Search 480K+ clinical studies via ClinicalTrials.gov v2. Status, sponsors, phases, results.", 0.04, { query: z.string().describe("Trial query"), status: z.string().optional().describe("RECRUITING, COMPLETED"), limit: z.number().int().min(5).max(50).optional().describe("Max results, default 20") }, {}, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await searchClinicalTrials(args.query, args.status, args.limit)) }] }) );
    this.server.paidTool("search_openalex", "Search 250M+ works via OpenAlex with institution data, bibliometrics, citation counts.", 0.03, { query: z.string().describe("Research query"), limit: z.number().int().min(5).max(50).optional().describe("Max results, default 20") }, {}, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await searchOpenAlex(args.query, args.limit)) }] }) );

    // ── Public Health & Safety Tools (v0.11.0) ──────────────────────
    this.server.paidTool("drug_recalls", "Search FDA drug/device/food enforcement recalls via openFDA. Severity, classification, recalling firm.", 0.03, { query: z.string().optional().describe("Search terms"), limit: z.number().int().min(5).max(50).optional().describe("Max results, default 20") }, {}, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await searchDrugRecalls(args.query, args.limit)) }] }) );
    this.server.paidTool("adverse_events", "Search 20M+ FDA adverse drug event reports via openFDA. Patient outcomes, drugs, reactions.", 0.04, { drug: z.string().describe("Drug name"), limit: z.number().int().min(5).max(50).optional().describe("Max results, default 20") }, {}, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await searchAdverseEvents(args.drug, args.limit)) }] }) );
    this.server.paidTool("product_recalls", "Search CPSC consumer product recalls via saferproducts.gov. Hazards, manufacturers, remedies.", 0.03, { query: z.string().optional().describe("Product search"), limit: z.number().int().min(5).max(50).optional().describe("Max results, default 20") }, {}, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await searchProductRecalls(args.query, args.limit)) }] }) );
    this.server.paidTool("vehicle_recalls", "Search NHTSA vehicle recalls by make, model, or VIN. Campaign numbers, defect descriptions.", 0.03, { make: z.string().optional().describe("e.g. Toyota"), model: z.string().optional().describe("e.g. Camry"), vin: z.string().optional().describe("17-char VIN") }, {}, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await searchVehicleRecalls(args.make, args.model, args.vin)) }] }) );
    this.server.paidTool("drug_labels", "Search official FDA drug labels via openFDA. Dosage, warnings, contraindications, active ingredients.", 0.03, { drug_name: z.string().describe("Drug name"), limit: z.number().int().min(5).max(50).optional().describe("Max results, default 10") }, {}, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await searchDrugLabels(args.drug_name, args.limit)) }] }) );

    // ── Environmental & Climate Tools (v0.11.0) ─────────────────────
    this.server.paidTool("wildfires", "Active wildfire detections from NASA FIRMS satellites. Lat/lon, brightness, confidence, scan time.", 0.03, { limit: z.number().int().min(10).max(100).optional().describe("Max results, default 50"), region: z.string().optional().describe("e.g. us-west, california") }, {}, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await getWildfires(args.limit, args.region)) }] }) );
    this.server.paidTool("weather_alerts", "Active NOAA NWS severe weather alerts — watches, warnings, advisories by state or zone.", 0.02, { state: z.string().optional().describe("2-letter state code e.g. CA"), zone: z.string().optional().describe("NWS zone ID") }, {}, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await getWeatherAlerts(args.state, args.zone)) }] }) );
    this.server.paidTool("tide_data", "NOAA tide predictions and observed water levels for coastal stations.", 0.03, { station: z.string().optional().describe("NOAA station ID"), date: z.string().optional().describe("YYYYMMDD") }, {}, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await getTideData(args.station, args.date)) }] }) );
    this.server.paidTool("space_weather", "NOAA space weather — solar flares, geomagnetic storms, solar wind speed, Kp index.", 0.02, { type: z.string().optional().describe("planetary_k_index, solar_wind, flare"), days: z.number().int().min(1).max(7).optional().describe("Days back, default 1") }, {}, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await getSpaceWeather(args.type, args.days)) }] }) );
    this.server.paidTool("water_levels", "Real-time USGS river/stream flow and flood data. Gauge height, discharge, percentiles by state.", 0.03, { state: z.string().optional().describe("2-letter state code"), parameter_code: z.string().optional().describe("USGS param code, default 00060") }, {}, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await getWaterLevels(args.state, args.parameter_code)) }] }) );

    // ── Government Spending & Contracts Tools (v0.11.0) ─────────────
    this.server.paidTool("federal_spending", "Search $6T+ federal budget by agency, recipient, or keyword via USAspending.gov API.", 0.04, { agency: z.string().optional().describe("e.g. Department of Defense"), recipient: z.string().optional().describe("Recipient name"), limit: z.number().int().min(5).max(50).optional().describe("Max results, default 20") }, {}, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await searchFederalSpending(args.agency, args.recipient, args.limit)) }] }) );
    this.server.paidTool("national_debt", "US national debt to the penny via Treasury FiscalData. Total debt, debt by instrument.", 0.02, {}, {}, async () => ({ content: [{ type: "text", text: JSON.stringify(await getNationalDebt()) }] }) );
    this.server.paidTool("federal_grants", "Search Grants.gov for open federal funding opportunities. Agency, eligibility, deadline.", 0.03, { query: z.string().optional().describe("Keyword search"), status: z.string().optional().describe("open, forecasted"), limit: z.number().int().min(5).max(50).optional().describe("Max results, default 20") }, {}, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await searchFederalGrants(args.query, args.status, args.limit)) }] }) );
    this.server.paidTool("nonprofit_filings", "Search nonprofit IRS 990 filings via ProPublica Nonprofit Explorer. Revenue, expenses, exec comp.", 0.03, { query: z.string().describe("Organization name"), state: z.string().optional().describe("2-letter state code") }, {}, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await searchNonprofitFilings(args.query, args.state)) }] }) );
    this.server.paidTool("economic_indicators", "GDP, CPI, unemployment, trade data via World Bank API. Multi-year time series.", 0.03, { country: z.string().optional().describe("ISO code e.g. US"), indicator: z.string().optional().describe("e.g. NY.GDP.MKTP.CD") }, {}, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await getEconomicIndicators(args.country, args.indicator)) }] }) );
    this.server.paidTool("lobbying_records", "Search FEC lobbying disclosure records. Lobbyists, clients, amounts, issues lobbied.", 0.04, { lobbyist: z.string().optional().describe("Lobbyist name"), client: z.string().optional().describe("Client/org name"), year: z.number().int().optional().describe("4-digit year") }, {}, async (args) => ({ content: [{ type: "text", text: JSON.stringify(await searchLobbyingRecords(args.lobbyist, args.client, args.year)) }] }) );

    // ── v0.14 new tools ──
    this.server.paidTool("edgar_filings", "Search SEC EDGAR full-text filings by company, form type, or ticker.", 0.03, { query: z.string(), form_type: z.string().optional(), ticker: z.string().optional() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await searchEdgarFilings(args.query, args.form_type, args.ticker)) }] }) );
    this.server.paidTool("insider_trades", "SEC Form 4 insider transactions.", 0.03, { ticker: z.string().optional(), limit: z.number().int().optional() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await getInsiderTrades(args.ticker, args.limit)) }] }) );
    this.server.paidTool("fred_series", "FRED economic data series.", 0.02, { series_id: z.string().optional(), limit: z.number().int().optional() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await getFredSeries(args.series_id, args.limit)) }] }) );
    this.server.paidTool("combinatorial_arb", "Polymarket negRisk combinatorial arbitrage scan.", 0.06, { limit: z.number().int().optional() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await scanCombinatorialArb(args.limit)) }] }) );
    this.server.paidTool("orderbook_imbalance", "Polymarket CLOB orderbook imbalance.", 0.04, { token_id: z.string().optional(), condition_id: z.string().optional() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await getOrderbookImbalance(args.token_id, args.condition_id)) }] }) );
    this.server.paidTool("smart_money", "Polymarket leaderboard and top trader activity.", 0.05, { limit: z.number().int().optional(), timeframe: z.string().optional() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await getSmartMoney(args.limit, args.timeframe)) }] }) );
    this.server.paidTool("cve_search", "Search NIST NVD CVE database.", 0.02, { keyword: z.string().optional(), cve_id: z.string().optional(), severity: z.string().optional() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await searchCVEs(args.keyword, args.cve_id, args.severity)) }] }) );
    this.server.paidTool("company_registry", "Search company registries.", 0.03, { query: z.string(), jurisdiction: z.string().optional() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await searchCompanies(args.query, args.jurisdiction)) }] }) );
    this.server.paidTool("reddit_search", "Search Reddit.", 0.02, { query: z.string(), subreddit: z.string().optional(), sort: z.string().optional() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await searchReddit(args.query, args.subreddit, args.sort)) }] }) );
    this.server.paidTool("github_repo_intel", "GitHub repo intelligence.", 0.03, { repo: z.string() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await getRepoIntel(args.repo)) }] }) );
    this.server.paidTool("currency_rates", "Live currency exchange rates.", 0.01, { base: z.string().optional(), target: z.string().optional() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await getExchangeRates(args.base, args.target)) }] }) );
    this.server.paidTool("business_days", "Business days calculator.", 0.01, { start_date: z.string().optional(), end_date: z.string().optional(), days_ahead: z.number().int().optional() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await getBusinessDays(args.start_date, args.end_date, args.days_ahead)) }] }) );
    this.server.paidTool("judges_search", "Search federal and state judges.", 0.04, { query: z.string(), court: z.string().optional() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await searchJudges(args.query, args.court)) }] }) );
    this.server.paidTool("trademarks_search", "Search USPTO trademarks.", 0.03, { query: z.string(), owner: z.string().optional() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await searchTrademarks(args.query, args.owner)) }] }) );
    this.server.paidTool("disease_outbreaks", "CDC disease outbreak data.", 0.03, { query: z.string().optional() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await searchDiseaseOutbreaks(args.query)) }] }) );
    this.server.paidTool("food_safety", "openFDA food enforcement.", 0.02, { query: z.string().optional() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await searchFoodSafety(args.query)) }] }) );
    this.server.paidTool("federal_contracts", "Federal contracts via USAspending.gov.", 0.04, { query: z.string().optional(), agency: z.string().optional() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await searchFederalContracts(args.query, args.agency)) }] }) );
    this.server.paidTool("paper_details", "Paper metadata via Semantic Scholar.", 0.02, { paperId: z.string() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await getPaperDetails(args.paperId)) }] }) );
    this.server.paidTool("citation_graph", "Citation graph via Semantic Scholar.", 0.03, { paperId: z.string(), direction: z.string().optional() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await getCitationGraph(args.paperId, args.direction === "backward" ? "backward" : "forward")) }] }) );
    this.server.paidTool("gen_video_intel", "Generative video model intelligence.", 0.05, { query: z.string().optional(), model: z.string().optional() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await genVideoIntel(args.query ?? "", args.model)) }] }) );
    this.server.paidTool("model_settings_lookup", "AI model recommended settings.", 0.02, { model: z.string(), task: z.string().optional() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await modelSettingsLookup(args.model, args.task)) }] }) );

    // ── Quick Tools (v0.14) ──
    this.server.paidTool("space_weather_kp", "Current planetary K-index and geomagnetic storm conditions.", 0.03, {}, {}, async () => ({ content: [{ type: "text" as const, text: JSON.stringify(await getSpaceWeatherKp()) }] }) );
    this.server.paidTool("weather_forecast_grid", "Detailed NWS 7-day forecast for US lat/lon.", 0.02, { lat: z.number(), lon: z.number() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await getWeatherForecast(args.lat, args.lon)) }] }) );
    this.server.paidTool("weather_current_global", "Current weather for any global coordinate.", 0.02, { lat: z.number(), lon: z.number(), variables: z.string().optional() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await getWeatherCurrent(args.lat, args.lon, args.variables)) }] }) );
    this.server.paidTool("aurora_forecast", "NOAA aurora oval forecast.", 0.03, {}, {}, async () => ({ content: [{ type: "text" as const, text: JSON.stringify(await getAuroraForecast()) }] }) );
    this.server.paidTool("marine_conditions", "Marine conditions for any ocean coordinate.", 0.03, { lat: z.number(), lon: z.number() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await getMarineConditions(args.lat, args.lon)) }] }) );
    this.server.paidTool("air_quality_index", "PM2.5, UV index, pollutants for any location.", 0.03, { lat: z.number(), lon: z.number() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await getAirQualityIndex(args.lat, args.lon)) }] }) );
    this.server.paidTool("postal_code_lookup", "City, state, geo for postal/zip codes (60+ countries).", 0.02, { country: z.string(), postal_code: z.string() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await getPostalLookup(args.country, args.postal_code)) }] }) );
    this.server.paidTool("ip_geolocation", "Geolocate an IP address.", 0.02, { ip: z.string() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await getIpGeolocation(args.ip)) }] }) );
    this.server.paidTool("timezone_current", "Current time for any IANA timezone.", 0.01, { timezone: z.string() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await getTimezoneCurrent(args.timezone)) }] }) );
    this.server.paidTool("airport_status", "Airport details by ICAO code.", 0.02, { icao: z.string() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await getAirportStatus(args.icao)) }] }) );
    this.server.paidTool("dns_records_lookup", "DNS resolution via Cloudflare DoH.", 0.02, { domain: z.string(), type: z.string().optional() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await getDnsRecords(args.domain, args.type)) }] }) );
    this.server.paidTool("isbn_book_lookup", "Book metadata by ISBN via Open Library.", 0.02, { isbn: z.string() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await getIsbnLookup(args.isbn)) }] }) );
    this.server.paidTool("crypto_price_simple", "Cryptocurrency price via CoinGecko.", 0.02, { coin: z.string(), currency: z.string().optional() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await getCryptoPrice(args.coin, args.currency)) }] }) );
    this.server.paidTool("btc_address_balance", "Bitcoin address balance and tx history.", 0.03, { address: z.string() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await getBtcBalance(args.address)) }] }) );
    this.server.paidTool("btc_mempool_fees", "Recommended Bitcoin network fees.", 0.02, {}, {}, async () => ({ content: [{ type: "text" as const, text: JSON.stringify(await getBtcFees()) }] }) );
    this.server.paidTool("food_recall_check", "Search openFDA food enforcement and recalls.", 0.02, { query: z.string().optional() }, {}, async (args: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(await getFoodRecalls(args.query)) }] }) );
  }
}

function serviceInfo() {
  return {
    service: SERVICE.slug,
    name: SERVICE.name,
    version: SERVICE.version,
    description: SERVICE.description,
    endpoints: {
      mcp: `${SERVICE.origin}${SERVICE.mcpPath}`,
      mcp_manifest: `${SERVICE.origin}/.well-known/mcp.json`,
      info: `${SERVICE.origin}/api/info`,
      system_info: `${SERVICE.origin}/api/system/info`,
      agent: `${SERVICE.origin}/.well-known/agent.json`,
      x402: `${SERVICE.origin}/.well-known/x402`,
      x402_json: `${SERVICE.origin}/.well-known/x402.json`,
      quote: `${SERVICE.origin}/api/quote?tool=trending_markets`,
      receipt: `${SERVICE.origin}/receipt/{tx}`,
      docs: `${SERVICE.origin}/docs`,
      discovery: `${SERVICE.origin}/discovery`,
      llms: `${SERVICE.origin}/llms.txt`,
      llms_full: `${SERVICE.origin}/llms-full.txt`,
      openapi: `${SERVICE.origin}/openapi.json`,
      openapi_alias: `${SERVICE.origin}/api/openapi.json`,
      agent_manifest: `${SERVICE.origin}/.well-known/agent.json`,
      bazaar_search: `${SERVICE.origin}/api/x402/bazaar/search?query=search&limit=10`,
      polymarket_event_scan: `${SERVICE.origin}/paid/polymarket/event-scan`,
      polymarket_market_scan: `${SERVICE.origin}/paid/polymarket/market-scan`,
      cross_platform_arb_scan: `${SERVICE.origin}/paid/markets/cross-platform-scan`,
      agent_threat_intel: `${SERVICE.origin}/paid/security/threat-intel`,
      mcp_supply_chain_iocs: `${SERVICE.origin}/paid/security/mcp-iocs`,
      agent_trifecta_score: `${SERVICE.origin}/paid/security/trifecta-score`,
      agent_security_policies: `${SERVICE.origin}/paid/security/policies`,
      // OSINT (OSINT stack)
      geo_pulse: `${SERVICE.origin}/paid/osint/geo-pulse`,
      flight_intel: `${SERVICE.origin}/paid/osint/flight-intel`,
      research_pack: `${SERVICE.origin}/paid/osint/research-pack`,
      scenario_verdict: `${SERVICE.origin}/paid/osint/scenario-verdict`,
      weather_bias: `${SERVICE.origin}/paid/osint/weather-bias`,
      supply_stress: `${SERVICE.origin}/paid/osint/supply-stress`,
      regulatory_pulse: `${SERVICE.origin}/paid/osint/regulatory-pulse`,
      attention_momentum: `${SERVICE.origin}/paid/osint/attention-momentum`,
      sec_8k_velocity: `${SERVICE.origin}/paid/osint/sec-8k-velocity`,
      fred_surprises: `${SERVICE.origin}/paid/osint/fred-surprises`,
      treasury_dts: `${SERVICE.origin}/paid/osint/treasury-dts`,
    },
    x402_discovery: {
      bazaar_search_proxy: `${SERVICE.origin}/api/x402/bazaar/search`,
      cdp_catalog: "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources",
      facilitator: SERVICE.facilitator,
      network: SERVICE.network,
    },
    payments: {
      protocol: "x402",
      scheme: "exact",
      network: SERVICE.network,
      network_name: SERVICE.networkName,
      asset: "USDC",
      asset_contract: SERVICE.usdc,
      facilitator: SERVICE.facilitator,
      seller: SERVICE.seller,
    },
    tools: TOOLS,
  };
}

function agentJson() {
  return {
    schema_version: "0.1",
    version: SERVICE.version,
    name: SERVICE.name,
    description: SERVICE.description,
    homepage: SERVICE.origin,
    mcp: `${SERVICE.origin}${SERVICE.mcpPath}`,
    contact: {
      name: "Hu White",
      email: "memerhuwhite@gmail.com",
    },
    payments: serviceInfo().payments,
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      price_usd: tool.price_usd,
      description: tool.description,
      input: tool.input,
    })),
  };
}

function categorySummaries() {
  return TOOL_CATEGORIES.map((category) => ({
    name: category.name,
    tool_count: category.tools.filter((name) => TOOLS.some((tool) => tool.name === name)).length,
    tools: category.tools.filter((name) => TOOLS.some((tool) => tool.name === name)),
  })).filter((category) => category.tool_count > 0);
}

function toolHttpUrl(tool: (typeof TOOLS)[number]) {
  return "http_path" in tool ? `${SERVICE.origin}${tool.http_path}` : null;
}

function toolQuotePayload(tool: (typeof TOOLS)[number]) {
  const httpEndpoint = toolHttpUrl(tool);
  return {
    service: SERVICE.name,
    tool: tool.name,
    category: categoryForTool(tool.name),
    description: tool.description,
    price_usd: tool.price_usd,
    amount: `$${tool.price_usd}`,
    payment: {
      protocol: "x402",
      scheme: "exact",
      network: SERVICE.network,
      network_name: SERVICE.networkName,
      asset: "USDC",
      asset_contract: SERVICE.usdc,
      pay_to: SERVICE.seller,
      facilitator: SERVICE.facilitator,
    },
    endpoints: {
      mcp: `${SERVICE.origin}${SERVICE.mcpPath}`,
      ...(httpEndpoint ? { http: httpEndpoint } : {}),
      quote: `${SERVICE.origin}/api/quote?tool=${encodeURIComponent(tool.name)}`,
      tool_page: `${SERVICE.origin}/tools/${tool.name}`,
    },
    input: tool.input,
    example: tool.example,
  };
}

function quoteTool(url: URL) {
  const requested = url.searchParams.get("tool") ?? url.searchParams.get("name");
  if (!requested) {
    return jsonResponse({
      service: SERVICE.name,
      description: "Free quote endpoint for agenttoll.dev paid tools. Pass ?tool=<tool_name> to price one call before payment.",
      example: `${SERVICE.origin}/api/quote?tool=trending_markets`,
      tools: TOOLS.map((tool) => ({ name: tool.name, price_usd: tool.price_usd, quote: `${SERVICE.origin}/api/quote?tool=${encodeURIComponent(tool.name)}` })),
    });
  }

  const normalized = requested.trim().toLowerCase();
  const tool = TOOLS.find((candidate) => candidate.name.toLowerCase() === normalized || ("http_path" in candidate && candidate.http_path.toLowerCase() === normalized));
  if (!tool) {
    return jsonResponse({
      error: "tool_not_found",
      message: `No paid tool matched ${requested}`,
      tools: TOOLS.map((candidate) => candidate.name),
    }, 404);
  }

  return jsonResponse(toolQuotePayload(tool));
}

function systemInfo() {
  const info = serviceInfo();
  return {
    product: SERVICE.name,
    service: SERVICE.slug,
    version: SERVICE.version,
    description: SERVICE.description,
    network: SERVICE.network,
    network_name: SERVICE.networkName,
    payment_assets: ["USDC"],
    payment_modes: ["x402"],
    seller: SERVICE.seller,
    facilitator: SERVICE.facilitator,
    asset_contracts: {
      USDC: SERVICE.usdc,
    },
    tool_count: TOOLS.length,
    resource_count: TOOLS.length + 4,
    categories: categorySummaries(),
    price_range_usd: {
      min: Math.min(...TOOLS.map((tool) => Number(tool.price_usd))).toFixed(2),
      max: Math.max(...TOOLS.map((tool) => Number(tool.price_usd))).toFixed(2),
    },
    discovery: {
      homepage: SERVICE.origin,
      docs: `${SERVICE.origin}/docs`,
      discovery_page: `${SERVICE.origin}/discovery`,
      tools: `${SERVICE.origin}/tools`,
      mcp: `${SERVICE.origin}${SERVICE.mcpPath}`,
      mcp_manifest: `${SERVICE.origin}/.well-known/mcp.json`,
      agent: `${SERVICE.origin}/.well-known/agent.json`,
      x402: `${SERVICE.origin}/.well-known/x402`,
      x402_json: `${SERVICE.origin}/.well-known/x402.json`,
      openapi: `${SERVICE.origin}/openapi.json`,
      openapi_alias: `${SERVICE.origin}/api/openapi.json`,
      llms: `${SERVICE.origin}/llms.txt`,
      llms_full: `${SERVICE.origin}/llms-full.txt`,
      quote: `${SERVICE.origin}/api/quote?tool=trending_markets`,
    },
    endpoints: info.endpoints,
  };
}

function mcpManifest() {
  return {
    mcpUrl: `${SERVICE.origin}${SERVICE.mcpPath}`,
    fullRosterUrl: `${SERVICE.origin}/tools`,
    name: SERVICE.name,
    version: SERVICE.version,
    description: `${SERVICE.description} Paid calls use x402. No API key or account is required for wallet-paying agents.`,
    capabilities: TOOLS.map((tool) => tool.name),
    auth: {
      modes: ["x402"],
      note: "Paid tool calls return an x402 payment challenge. Sign and retry with the payment header from an x402-capable client.",
    },
    payments: serviceInfo().payments,
    discovery: {
      systemInfo: `${SERVICE.origin}/api/system/info`,
      agentJson: `${SERVICE.origin}/.well-known/agent.json`,
      x402: `${SERVICE.origin}/.well-known/x402`,
      llms: `${SERVICE.origin}/llms.txt`,
      llmsFull: `${SERVICE.origin}/llms-full.txt`,
      quote: `${SERVICE.origin}/api/quote?tool=trending_markets`,
    },
    docsUrl: `${SERVICE.origin}/docs`,
    openapiUrl: `${SERVICE.origin}/openapi.json`,
    x402Url: `${SERVICE.origin}/.well-known/x402`,
  };
}

function llmsFullText() {
  const lines = [
    `# ${SERVICE.name}`,
    "",
    SERVICE.description,
    "",
    "agenttoll.dev sells paid data calls to AI agents. Agents discover tools, request a call, receive an HTTP 402 challenge, pay in Base USDC with x402, and receive structured JSON.",
    "",
    "## Payment",
    "",
    `- Protocol: x402`,
    `- Scheme: exact`,
    `- Network: ${SERVICE.network} (${SERVICE.networkName})`,
    `- Asset: USDC (${SERVICE.usdc})`,
    `- Seller wallet: ${SERVICE.seller}`,
    `- Facilitator: ${SERVICE.facilitator}`,
    "- API keys: not required for x402 paid calls",
    "",
    "## Discovery",
    "",
    `- Human discovery page: ${SERVICE.origin}/discovery`,
    `- Tool directory: ${SERVICE.origin}/tools`,
    `- MCP endpoint: ${SERVICE.origin}${SERVICE.mcpPath}`,
    `- MCP manifest: ${SERVICE.origin}/.well-known/mcp.json`,
    `- Agent manifest: ${SERVICE.origin}/.well-known/agent.json`,
    `- x402 resources: ${SERVICE.origin}/.well-known/x402`,
    `- Full x402 catalog: ${SERVICE.origin}/.well-known/x402.json`,
    `- OpenAPI: ${SERVICE.origin}/openapi.json`,
    `- System info: ${SERVICE.origin}/api/system/info`,
    `- Quote endpoint: ${SERVICE.origin}/api/quote?tool=trending_markets`,
    "",
    "## How to use a tool",
    "",
    "1. Pick a tool from /tools, /api/system/info, /.well-known/agent.json, or /.well-known/mcp.json.",
    "2. Price it with /api/quote?tool=<tool_name>.",
    "3. Call the MCP tool or HTTP endpoint.",
    "4. Sign the x402 challenge and retry with the payment header.",
    "5. Read the JSON response. Verify any on-chain payment with /receipt/<tx>.",
    "",
    "## Categories",
    "",
    ...categorySummaries().flatMap((category) => [`### ${category.name}`, "", `${category.tool_count} tools: ${category.tools.join(", ")}.`, ""]),
    "## Tools",
    "",
    ...TOOLS.flatMap((tool) => {
      const quote = toolQuotePayload(tool);
      return [
        `### ${tool.name}`,
        "",
        `Category: ${quote.category}`,
        `Price: $${tool.price_usd} per call`,
        `Description: ${tool.description}`,
        `Quote: ${quote.endpoints.quote}`,
        `Tool page: ${quote.endpoints.tool_page}`,
        ...(quote.endpoints.http ? [`HTTP endpoint: ${quote.endpoints.http}`] : [`MCP endpoint: ${quote.endpoints.mcp}`]),
        `Input: ${JSON.stringify(tool.input)}`,
        `Example: ${JSON.stringify(tool.example)}`,
        "",
      ];
    }),
  ];
  return `${lines.join("\n")}\n`;
}

function toolJsonSchema(tool: (typeof TOOLS)[number]) {
  const properties: Record<string, { type: string; description: string }> = {};
  const required: string[] = [];
  for (const [key, hint] of Object.entries(tool.input)) {
    const optional = /optional/i.test(hint);
    properties[key] = { type: "string", description: hint };
    if (!optional) required.push(key);
  }
  return { type: "object" as const, properties, ...(required.length ? { required } : {}) };
}

/** x402scan registerFromOrigin fetches this path *without* .json first (Archonics recipe). */
function x402WellKnownPlain() {
  const mcp = `${SERVICE.origin}${SERVICE.mcpPath}`;
  return {
    version: 1,
    x402Version: 2,
    name: SERVICE.name,
    origin: SERVICE.origin,
    mcp,
    resources: [
      mcp,
      ...TOOLS.map((t) => `${mcp}#${t.name}`),
      `${SERVICE.origin}/paid/polymarket/event-scan`,
      `${SERVICE.origin}/paid/polymarket/market-scan`,
      `${SERVICE.origin}/paid/markets/cross-platform-scan`,
    ],
    tools: TOOLS.map((t) => t.name),
  };
}

/** Full discovery catalog for x402scan / AgentGrade / manual directory crawlers. */
function x402WellKnownJson() {
  const mcp = `${SERVICE.origin}${SERVICE.mcpPath}`;
  return {
    version: 1,
    x402Version: 2,
    schema_version: "0.1",
    name: SERVICE.name,
    description: SERVICE.description,
    homepage: SERVICE.origin,
    iconUrl: `${SERVICE.origin}/favicon.ico`,
    contact: agentJson().contact,
    payments: serviceInfo().payments,
    mcp,
    resources: TOOLS.map((tool) => {
      const schema = toolJsonSchema(tool);
      const httpPath = "http_path" in tool ? tool.http_path : null;
      const isHttp = Boolean(httpPath);
      return {
        type: isHttp ? "http" : "mcp",
        resource: isHttp ? `${SERVICE.origin}${httpPath}` : mcp,
        ...(isHttp ? { method: "POST" } : { toolName: tool.name }),
        description: tool.description,
        price_usd: tool.price_usd,
        network: SERVICE.network,
        payTo: SERVICE.seller,
        tags: [isHttp ? "http" : "mcp", "x402", "agents", tool.name],
        outputSchema: {
          input: {
            type: isHttp ? "http" : "mcp",
            method: isHttp ? "POST" : "tools/call",
            discoverable: true,
            ...(!isHttp ? { toolName: tool.name } : {}),
            bodyType: "json",
            schema,
            body: tool.example,
          },
          output: {
            ok: true,
            tool: tool.name,
            result: {},
          },
        },
      };
    }),
    listing: {
      x402scan_register: `POST https://www.x402scan.com/api/trpc/public.resources.registerFromOrigin {"json":{"origin":"${SERVICE.origin}"}}`,
      cdp_merchant: `https://api.cdp.coinbase.com/platform/v2/x402/discovery/merchant?payTo=${SERVICE.seller}`,
      open402: "https://agentinternetruntime.com/open-402-directory",
      awesome_x402: "https://github.com/xpaysh/awesome-x402",
    },
  };
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=60",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function textResponse(text: string, status = 200) {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function htmlResponse(html: string) {
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}

function addressFromTopic(topic: string) {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function formatUsdc(raw: bigint) {
  const whole = raw / 1_000_000n;
  const frac = (raw % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

async function getTransactionReceipt(tx: string): Promise<RpcReceipt | null> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch("https://mainnet.base.org", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getTransactionReceipt",
          params: [tx],
        }),
      });

      if (!response.ok) {
        throw new Error(`Base RPC returned ${response.status}`);
      }

      const body = await response.json() as { result?: RpcReceipt | null; error?: { message?: string } };
      if (body.error) {
        throw new Error(body.error.message ?? "Base RPC error");
      }
      return body.result ?? null;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }

  throw lastError ?? new Error("Base RPC failed");
}

async function receiptResponse(tx: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) {
    return jsonResponse({ error: "invalid_tx_hash" }, 400);
  }

  const receipt = await getTransactionReceipt(tx);
  if (!receipt) {
    return jsonResponse({
      service: SERVICE.slug,
      tx,
      verified: false,
      status: "not_found_or_pending",
      network: SERVICE.network,
    }, 404);
  }

  const seller = SERVICE.seller.toLowerCase();
  const usdc = SERVICE.usdc.toLowerCase();
  const transfers = receipt.logs
    .filter((log) => log.address.toLowerCase() === usdc)
    .filter((log) => log.topics[0]?.toLowerCase() === transferTopic)
    .filter((log) => log.topics.length >= 3)
    .map((log) => ({
      from: addressFromTopic(log.topics[1]),
      to: addressFromTopic(log.topics[2]),
      amount_atomic: BigInt(log.data).toString(),
      amount_usdc: formatUsdc(BigInt(log.data)),
    }));

  const matching = transfers.filter((transfer) => transfer.to === seller);

  return jsonResponse({
    service: SERVICE.slug,
    verified: receipt.status === "0x1" && matching.length > 0,
    tx: receipt.transactionHash,
    status: receipt.status === "0x1" ? "success" : "failed",
    block_number: Number.parseInt(receipt.blockNumber, 16),
    network: SERVICE.network,
    network_name: SERVICE.networkName,
    asset: "USDC",
    asset_contract: SERVICE.usdc,
    seller: SERVICE.seller,
    transfers_to_seller: matching,
    all_usdc_transfers: transfers,
    explorer: `https://basescan.org/tx/${receipt.transactionHash}`,
  });
}


// ════════════════════════════════════════════════════════════════════════
// LANDING PAGE REDESIGN — shader background + tools directory
// ════════════════════════════════════════════════════════════════════════

const SHARED_CSS = `:root {
  color-scheme: dark;
  --bg: #06080c;
  --bg-glass: rgba(10, 14, 22, 0.72);
  --bg-card: rgba(16, 22, 34, 0.6);
  --border: rgba(56, 78, 112, 0.25);
  --border-hover: rgba(86, 116, 162, 0.4);
  --text: #e8eef6;
  --text-2: #8b9bb4;
  --text-3: #5a6b85;
  --accent: #2dd4bf;
  --accent-2: #0ea5e9;
  --accent-dim: rgba(45, 212, 191, 0.12);
  --price: #4ade80;
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
  --duration-fast: 160ms;
  --duration-ui: 220ms;
  --focus-ring: 0 0 0 3px rgba(45, 212, 191, 0.32);
  --rail-glow: 0 0 36px rgba(45, 212, 191, 0.16);
}
* { margin: 0; padding: 0; box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  font-family: 'Inter', system-ui, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
  overflow-x: hidden;
  -webkit-font-smoothing: antialiased;
}
/* Shader canvas */
#shader-bg {
  position: fixed;
  top: 0; left: 0;
  width: 100%; height: 100%;
  z-index: 0;
  opacity: 0.35;
}
/* Glass overlay to dim shader for readability */
.glass-overlay {
  position: fixed;
  top: 0; left: 0;
  width: 100%; height: 100%;
  z-index: 1;
  background: radial-gradient(ellipse at center top, transparent 0%, rgba(6, 8, 12, 0.85) 70%);
  pointer-events: none;
}
/* Nav */
nav {
  position: relative;
  z-index: 10;
  display: flex;
  justify-content: space-between;
  align-items: center;
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px 32px;
}
nav .logo {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 600;
  font-size: 16px;
  color: var(--text);
  letter-spacing: -0.02em;
  text-decoration: none;
  padding: 4px 6px;
  border-radius: 8px;
  transition: color var(--duration-fast) ease, box-shadow var(--duration-fast) ease;
}
nav .logo span { color: var(--accent); }
nav .links { display: flex; gap: 28px; align-items: center; }
nav .links a {
  color: var(--text-2);
  text-decoration: none;
  font-size: 14px;
  font-weight: 500;
  border-radius: 8px;
  transition: color var(--duration-fast) ease, background-color var(--duration-fast) ease, box-shadow var(--duration-fast) ease;
}
nav .links a:hover { color: var(--text); }
nav .logo:focus,
nav .links a:focus,
.btn:focus,
.cat-card:focus,
.tool-card:focus,
.search-bar:focus,
.nav-toggle:focus,
nav .logo:focus-visible,
nav .links a:focus-visible,
.btn:focus-visible,
.cat-card:focus-visible,
.tool-card:focus-visible,
.search-bar:focus-visible,
.nav-toggle:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
nav .links .cta {
  background: var(--accent-dim);
  border: 1px solid rgba(45, 212, 191, 0.3);
  padding: 8px 16px;
  border-radius: 8px;
  color: var(--accent);
}
/* Layout */
main {
  position: relative;
  z-index: 5;
  max-width: 1200px;
  margin: 0 auto;
  padding: 0 32px;
}
/* Hero */
.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 80px 0 100px;
  min-height: 70vh;
  justify-content: center;
}
.hero .badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-radius: 100px;
  background: var(--accent-dim);
  border: 1px solid rgba(45, 212, 191, 0.2);
  font-size: 13px;
  font-weight: 500;
  color: var(--accent);
  margin-bottom: 28px;
  backdrop-filter: blur(10px);
}
.hero .badge::before {
  content: '';
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent);
  animation: pulse 2s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
.hero h1 {
  font-size: clamp(40px, 7vw, 84px);
  font-weight: 800;
  line-height: 1.1;
  letter-spacing: -0.05em;
  margin-bottom: 24px;
  padding-bottom: 0.08em;
  padding-right: 0.1em;
  max-width: 900px;
  color: var(--text);
  text-shadow: 0 0 42px rgba(45, 212, 191, 0.10), 0 1px 0 rgba(255,255,255,0.12);
}
.hero p.sub {
  font-size: clamp(16px, 2vw, 20px);
  color: var(--text-2);
  max-width: 620px;
  margin-bottom: 36px;
  line-height: 1.5;
}
.hero .actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  justify-content: center;
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 22px;
  border-radius: 10px;
  font-weight: 600;
  font-size: 15px;
  text-decoration: none;
  transition: transform var(--duration-fast) var(--ease-out), box-shadow var(--duration-ui) var(--ease-out), border-color var(--duration-fast) ease, background-color var(--duration-fast) ease;
  backdrop-filter: blur(10px);
}
.btn-primary {
  background: var(--accent);
  color: #06080c;
  box-shadow: 0 0 30px rgba(45, 212, 191, 0.3);
}
.btn-primary:hover { box-shadow: 0 0 50px rgba(45, 212, 191, 0.5); transform: translateY(-1px); }
.btn:active { transform: scale(0.97); }
.btn-ghost {
  background: var(--bg-glass);
  border: 1px solid var(--border);
  color: var(--text);
}
.btn-ghost:hover { border-color: var(--border-hover); }
/* Stats bar */
.stats {
  display: flex;
  gap: 0;
  justify-content: center;
  margin-top: 64px;
  flex-wrap: wrap;
  max-width: 760px;
  border: 1px solid rgba(45, 212, 191, 0.22);
  border-radius: 18px;
  background: linear-gradient(180deg, rgba(6, 8, 12, 0.74), rgba(16, 22, 34, 0.58));
  box-shadow: var(--rail-glow), inset 0 1px 0 rgba(255,255,255,0.06);
  overflow: hidden;
  backdrop-filter: blur(14px);
}
.stats::before {
  content: 'PAYMENT RAIL';
  width: 100%;
  padding: 9px 14px 7px;
  border-bottom: 1px solid rgba(45, 212, 191, 0.16);
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  letter-spacing: 0.14em;
  color: var(--accent);
  text-align: left;
}
.stat {
  text-align: center;
  min-width: 150px;
  padding: 18px 22px 20px;
  border-right: 1px solid rgba(56, 78, 112, 0.22);
}
.stat:last-child {
  border-right: 0;
}
.stat .num {
  font-family: 'JetBrains Mono', monospace;
  font-size: 36px;
  font-weight: 700;
  color: var(--text);
  letter-spacing: -0.04em;
}
.stat .label {
  font-size: 13px;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-top: 2px;
}
/* Categories preview */
.categories {
  padding: 60px 0;
}
.section-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  margin-bottom: 36px;
}
.section-head h2 {
  font-size: clamp(24px, 4vw, 36px);
  font-weight: 700;
  letter-spacing: -0.03em;
}
.section-head a {
  color: var(--accent);
  text-decoration: none;
  font-size: 14px;
  font-weight: 500;
}
.cat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 16px;
}
.cat-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 24px;
  text-decoration: none;
  color: inherit;
  transition: transform var(--duration-ui) var(--ease-out), border-color var(--duration-fast) ease, box-shadow var(--duration-ui) var(--ease-out), background-color var(--duration-fast) ease;
  backdrop-filter: blur(12px);
}
.cat-card:hover {
  border-color: var(--border-hover);
  transform: translateY(-2px);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
}
.cat-card h3 {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.cat-card .icon {
  font-family: 'JetBrains Mono', monospace;
  font-size: 18px;
  opacity: 0.6;
}
.cat-card p {
  font-size: 13px;
  color: var(--text-2);
  margin-bottom: 12px;
}
.cat-card .cat-count {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  color: var(--text-3);
}
/* How it works */
.how {
  padding: 80px 0;
}
.how-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 24px;
}
.step {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 32px;
  backdrop-filter: blur(12px);
}
.step .num {
  font-family: 'JetBrains Mono', monospace;
  font-size: 14px;
  color: var(--accent);
  margin-bottom: 12px;
}
.step h3 {
  font-size: 18px;
  font-weight: 600;
  margin-bottom: 8px;
}
.step p {
  font-size: 14px;
  color: var(--text-2);
  line-height: 1.6;
}
/* Footer */
footer {
  position: relative;
  z-index: 5;
  border-top: 1px solid var(--border);
  padding: 32px;
  margin-top: 80px;
}
footer .inner {
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
}
footer .left {
  font-size: 13px;
  color: var(--text-3);
}
footer .links {
  display: flex;
  gap: 20px;
}
footer .links a {
  color: var(--text-2);
  text-decoration: none;
  font-size: 13px;
}
footer .links a:hover { color: var(--text); }
footer code {
  font-family: 'JetBrains Mono', monospace;
  color: var(--text-3);
}
/* Nav toggle (hamburger) */
.nav-toggle {
  display: none;
  background: none;
  border: none;
  color: var(--text);
  font-size: 24px;
  cursor: pointer;
  padding: 4px 8px;
  z-index: 11;
}
/* Hero entrance animation */
.hero .badge,
.hero h1,
.hero .sub,
.hero .actions,
.hero .stats {
  animation: slideUp 0.6s ease-out both;
}
.hero .badge { animation-delay: 0.1s; }
.hero h1 { animation-delay: 0.2s; }
.hero .sub { animation-delay: 0.35s; }
.hero .actions { animation-delay: 0.5s; }
.hero .stats { animation-delay: 0.65s; }
@keyframes slideUp {
  from { opacity: 0; transform: translateY(30px); }
  to { opacity: 1; transform: translateY(0); }
}
/* Responsive */
@media (max-width: 768px) {
  .hero { padding: 40px 0 60px; min-height: auto; }
  .how-grid { grid-template-columns: 1fr; }
  .stats { gap: 24px; }
  .stat .num { font-size: 28px; }
  .cat-grid { grid-template-columns: 1fr !important; }
  .tools-grid { grid-template-columns: 1fr !important; }
  pre { font-size: 12px; }
  .nav-toggle { display: block; }
  nav .links {
    display: none;
    position: fixed;
    top: 0; right: 0;
    width: 240px;
    height: 100vh;
    background: rgba(6, 8, 12, 0.95);
    backdrop-filter: blur(20px);
    flex-direction: column;
    padding: 80px 24px 24px;
    gap: 20px;
    z-index: 10;
    border-left: 1px solid var(--border);
  }
  nav .links.open { display: flex; }
  nav .links a {
    font-size: 16px;
    width: 100%;
    padding: 8px 0;
  }
}
@media (max-width: 480px) {
  nav { padding: 16px 20px; }
  main { padding: 0 20px !important; }
  .hero h1 { font-size: clamp(32px, 10vw, 48px); }
  .section-head { flex-direction: column; align-items: flex-start; gap: 8px; }
  footer .inner { flex-direction: column; text-align: center; }
}
/* ── Tool directory & detail page styles ── */
.tools-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
  padding: 40px 0;
}
.tool-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 24px;
  text-decoration: none;
  color: inherit;
  transition: transform var(--duration-ui) var(--ease-out), border-color var(--duration-fast) ease, box-shadow var(--duration-ui) var(--ease-out), background-color var(--duration-fast) ease;
  backdrop-filter: blur(12px);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tool-card:hover {
  border-color: var(--border-hover);
  transform: translateY(-2px);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
}
.tool-card .tool-name {
  font-size: 15px;
  font-weight: 600;
  font-family: 'JetBrains Mono', monospace;
  color: var(--text);
}
.tool-card .tool-price {
  font-family: 'JetBrains Mono', monospace;
  font-size: 14px;
  font-weight: 700;
  color: var(--price);
}
.tool-card .tool-desc {
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.5;
}
.tool-card .tool-path {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text-3);
}
.detail-page {
  padding: 60px 0;
}
.detail-page .back-link {
  color: var(--accent);
  text-decoration: none;
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 24px;
  display: inline-block;
}
.detail-page .tool-header {
  margin-bottom: 32px;
}
.detail-page .tool-header h1 {
  font-family: 'JetBrains Mono', monospace;
  font-size: clamp(28px, 5vw, 48px);
  font-weight: 700;
  letter-spacing: -0.03em;
  margin-bottom: 8px;
  color: var(--text);
  text-shadow: 0 0 30px rgba(45, 212, 191, 0.10);
}
.detail-page .tool-price-large {
  font-family: 'JetBrains Mono', monospace;
  font-size: 36px;
  font-weight: 800;
  color: var(--price);
}
.detail-page .tool-desc-full {
  font-size: 18px;
  color: var(--text-2);
  line-height: 1.6;
  margin: 24px 0;
  max-width: 720px;
}
.detail-page .tool-section {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 24px;
  margin: 16px 0;
  backdrop-filter: blur(12px);
}
.detail-page .tool-section h3 {
  font-size: 14px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-3);
  margin-bottom: 12px;
}
.detail-page pre {
  background: rgba(6, 8, 12, 0.6);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 13px;
  color: var(--text);
  overflow-x: auto;
  white-space: pre-wrap;
}
.search-bar {
  width: 100%;
  padding: 14px 20px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  color: var(--text);
  font-size: 15px;
  font-family: 'Inter', sans-serif;
  margin-bottom: 32px;
  backdrop-filter: blur(12px);
  outline: none;
  transition: border-color var(--duration-fast) ease, box-shadow var(--duration-fast) ease;
}
.search-bar:focus {
  border-color: var(--accent);
}
.search-bar::placeholder {
  color: var(--text-3);
}

/* ── Category sections (tools directory) ── */
.cat-section {
  margin-bottom: 48px;
  scroll-margin-top: 24px;
}
.cat-section-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.cat-section-head h2 {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
  display: flex;
  align-items: center;
  gap: 10px;
}
.cat-icon {
  font-size: 24px;
}
.cat-section-head .cat-count {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  #shader-bg { display: none; }
  .hero .badge,
  .hero h1,
  .hero .sub,
  .hero .actions,
  .hero .stats,
  .hero .badge::before {
    animation: none;
  }
  .tool-card:hover { transform: none; }
  .cat-card:hover { transform: none; }
  .btn-primary:hover { transform: none; }
  .btn:active { transform: none; }
}

`;

const SHARED_SHADER = `// === LUMEN CHROME SHADER BACKGROUND ===
(function() {
  const canvas = document.getElementById('shader-bg');
  if (!canvas) return;

  const gl = canvas.getContext('webgl2', { antialias: false, powerPreference: 'low-power' });
  if (!gl) { canvas.style.display = 'none'; return; }

  const VERT = "#version 300 es\\nlayout(location=0) in vec2 a_pos;\\nvoid main() { gl_Position = vec4(a_pos, 0.0, 1.0); }";

  const FRAG = "#version 300 es\\nprecision highp float;\\nprecision highp int;\\n\\nuniform vec2  u_res;\\nuniform float u_phase;\\nuniform float u_seed;\\n\\nuniform vec3  u_c1, u_c2, u_c3, u_c4, u_bg;\\nuniform float u_hue, u_sat, u_exposure, u_contrast;\\nuniform float u_scale, u_complex, u_warp, u_flow, u_stretch;\\nuniform float u_light, u_gloss, u_lightAngle, u_irid, u_glow;\\nuniform float u_grain, u_ca, u_vig, u_travel;\\n\\nout vec4 fragColor;\\n\\n#define TAU 6.28318530718\\n#define PI  3.14159265359\\n\\n/* ---------------- noise ---------------- */\\n\\n/* fract-first hashes stay precise for large inputs (big seeds, far cells) */\\n\\nfloat hash11(float n){\\n  n = fract(n * 0.1031);\\n  n *= n + 33.33;\\n  n *= n + n;\\n  return fract(n);\\n}\\n\\nfloat hash21(vec2 p){\\n  vec3 p3 = fract(vec3(p.xyx) * 0.1031);\\n  p3 += dot(p3, p3.yzx + 33.33);\\n  return fract((p3.x + p3.y) * p3.z);\\n}\\n\\nvec2 hash22(vec2 p){\\n  float n = hash21(p);\\n  return vec2(n, hash21(p+n+17.13));\\n}\\n\\n\\nfloat vnoise(vec2 p){\\n  vec2 i = floor(p), f = fract(p);\\n  vec2 u = f*f*(3.0-2.0*f);\\n  float a = hash21(i);\\n  float b = hash21(i+vec2(1,0));\\n  float c = hash21(i+vec2(0,1));\\n  float d = hash21(i+vec2(1,1));\\n  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);\\n}\\n\\n\\nmat2 rot(float a){ float c=cos(a), s=sin(a); return mat2(c,-s,s,c); }\\n\\n\\nfloat fbm(vec2 p){\\n  float v = 0.0, a = 0.5, tot = 0.0;\\n  mat2 R = rot(0.62);\\n  for (int i = 0; i < 8; i++){\\n    float w = clamp(u_complex - float(i), 0.0, 1.0);\\n    if (w <= 0.0) break;\\n    v += a*w*vnoise(p);\\n    tot += a*w;\\n    a *= 0.55;\\n    p = R*p*2.03 + 11.7;\\n  }\\n  return v/max(tot, 1e-4);\\n}\\n\\n\\n/* loop offset: orbit in noise space -> perfect loop */\\nvec2 LT(){ return vec2(cos(TAU*u_phase), sin(TAU*u_phase)) * u_travel; }\\nvec2 SO(){ return vec2(hash11(u_seed*0.137 + 0.731)*61.7, hash11(u_seed*0.213 + 7.0)*47.3); }\\n\\n\\nvec3 palette(float t){\\n  t = clamp(t, 0.0, 1.0);\\n  float x = t*3.0;\\n  vec3 c = mix(u_c1, u_c2, smoothstep(0.0,1.0,x));\\n  c = mix(c, u_c3, smoothstep(1.0,2.0,x));\\n  c = mix(c, u_c4, smoothstep(2.0,3.0,x));\\n  return c;\\n}\\n\\nvec3 paletteCyc(float t){\\n  t = fract(t);\\n  float x = t*4.0;\\n  vec3 c = mix(u_c1, u_c2, smoothstep(0.0,1.0,x));\\n  c = mix(c, u_c3, smoothstep(1.0,2.0,x));\\n  c = mix(c, u_c4, smoothstep(2.0,3.0,x));\\n  c = mix(c, u_c1, smoothstep(3.0,4.0,x));\\n  return c;\\n}\\n\\n\\nvec3 hueRotate(vec3 c, float deg){\\n  float a = deg*PI/180.0;\\n  float cs = cos(a), sn = sin(a);\\n  mat3 m = mat3(\\n    0.299+0.701*cs+0.168*sn, 0.587-0.587*cs+0.330*sn, 0.114-0.114*cs-0.497*sn,\\n    0.299-0.299*cs-0.328*sn, 0.587+0.413*cs+0.035*sn, 0.114-0.114*cs+0.292*sn,\\n    0.299-0.300*cs+1.250*sn, 0.587-0.588*cs-1.050*sn, 0.114+0.886*cs-0.203*sn);\\n  return c*m;\\n}\\n\\n\\nvec2 toP(vec2 uv){\\n  float asp = u_res.x/u_res.y;\\n  vec2 p = (uv - 0.5) * vec2(asp, 1.0) * (3.0/max(u_scale, 0.15));\\n  p.x *= mix(1.0, 0.38, clamp(u_stretch, 0.0, 1.0));\\n  p.y *= mix(1.0, 0.38, clamp(-u_stretch, 0.0, 1.0));\\n  return p;\\n}\\n\\n\\n\\n\\nfloat chromeH(vec2 p, vec2 w){\\n  vec2 so = SO(), lt = LT();\\n  return fbm((p + w)*0.85 + so*0.5 + u_flow*0.6*lt);\\n}\\n\\nvec3 sceneChrome(vec2 uv){\\n  vec2 p = toP(uv);\\n  p.x *= 0.48;\\n  vec2 so = SO(), lt = LT();\\n  \\n  vec2 w = u_warp*0.9*vec2(\\n    fbm(p*0.5 + so + lt) - 0.5,\\n    fbm(p*0.5 + so + 7.31 - lt) - 0.5) * 2.4;\\n  \\n  float e = 0.06;\\n  float h  = chromeH(p, w);\\n  float hx = chromeH(p + vec2(e,0.0), w);\\n  float hy = chromeH(p + vec2(0.0,e), w);\\n  float relief = 3.4 + u_warp*1.6;\\n  vec3 n = normalize(vec3(-(hx-h)/e*relief, -(hy-h)/e*relief, 1.0));\\n  \\n  float la = u_lightAngle*PI/180.0;\\n  vec3 L = normalize(vec3(cos(la), sin(la), 0.55));\\n  float diff = max(dot(n, L), 0.0);\\n  vec3 Hv = normalize(L + vec3(0.0,0.0,1.0));\\n  float spec  = pow(max(dot(n, Hv), 0.0), u_gloss);\\n  float spec2 = pow(max(dot(n, normalize(vec3(-L.xy, 0.9))), 0.0), u_gloss*0.45);\\n  float fres  = pow(1.0 - max(n.z, 0.0), 2.4);\\n  \\n  vec3 alb  = palette(clamp(h*1.1 + u_irid*n.x*0.7, 0.0, 1.0));\\n  vec3 alb2 = palette(clamp(0.55 - n.x*0.7 + h*0.25, 0.0, 1.0));\\n  \\n  vec3 col = u_bg*(0.55 + 0.45*diff);\\n  col += alb * pow(diff, 2.4) * 0.30;\\n  col += alb * spec * u_light * 3.0;\\n  col += alb2 * spec2 * u_light * 1.35;\\n  col += palette(clamp(fres*0.85 + u_irid*n.y*0.4, 0.0, 1.0)) * fres * u_light * 0.55;\\n  col += vec3(1.0) * pow(spec, 3.0) * u_light * 0.5;\\n  return col;\\n}\\n\\nvec3 scene(vec2 uv){ return sceneChrome(uv); }\\n\\nvoid main(){\\n  vec2 uv = gl_FragCoord.xy/u_res;\\n  vec3 col = scene(uv);\\n\\n  /* chromatic fringe */\\n  if (u_ca > 0.004){\\n    float asp0 = u_res.x/u_res.y;\\n    float r2 = length((uv - 0.5)*vec2(asp0, 1.0));\\n    float w = clamp(u_ca, 0.0, 1.0)*smoothstep(0.18, 0.85, r2)*0.45;\\n    vec3 shifted = vec3(\\n      hueRotate(col,  10.0).r,\\n      col.g,\\n      hueRotate(col, -10.0).b);\\n    col = mix(col, shifted, w);\\n  }\\n\\n  /* glow */\\n  float lum = dot(col, vec3(0.299,0.587,0.114));\\n  col += u_glow * col * lum * 0.85;\\n\\n  /* grade */\\n  if (abs(u_hue) > 0.5) col = hueRotate(col, u_hue);\\n  float l2 = dot(col, vec3(0.299,0.587,0.114));\\n  col = mix(vec3(l2), col, u_sat);\\n  col *= u_exposure;\\n  col = (col - 0.5)*u_contrast + 0.5;\\n\\n  /* vignette */\\n  float asp = u_res.x/u_res.y;\\n  vec2 vc = (uv-0.5)*vec2(asp,1.0);\\n  col *= 1.0 - u_vig*smoothstep(0.35, 1.05, length(vc));\\n\\n  /* film grain */\\n  float gstep = floor(u_phase*24.0);\\n  float gr = hash21(gl_FragCoord.xy*0.71 + vec2(gstep*3.1, gstep*7.7));\\n  col += (gr-0.5)*u_grain*0.55;\\n\\n  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);\\n}\\n";

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error('Shader error:', gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) { canvas.style.display = 'none'; return; }

  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('Link error:', gl.getProgramInfoLog(prog));
    canvas.style.display = 'none';
    return;
  }
  gl.useProgram(prog);

  // Fullscreen triangle
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  // Uniforms
  const U = {};
  ['u_res','u_phase','u_seed','u_c1','u_c2','u_c3','u_c4','u_bg',
   'u_hue','u_sat','u_exposure','u_contrast',
   'u_scale','u_complex','u_warp','u_flow','u_stretch',
   'u_light','u_gloss','u_lightAngle','u_irid','u_glow',
   'u_grain','u_ca','u_vig','u_travel'].forEach(n => U[n] = gl.getUniformLocation(prog, n));

  // Premium dark palette
  function hex3(h) {
    const r = parseInt(h.slice(1,3),16)/255;
    const g = parseInt(h.slice(3,5),16)/255;
    const b = parseInt(h.slice(5,7),16)/255;
    return [r,g,b];
  }

  const params = {
    seed: 7.3,
    c1: hex3('#1a3a5c'),   // deep blue
    c2: hex3('#2dd4bf'),   // teal
    c3: hex3('#e0f2fe'),   // silver-white
    c4: hex3('#0ea5e9'),   // sky blue
    bg: hex3('#06080c'),   // near black
    scale: 1.2,
    complex: 4.0,
    warp: 0.55,
    flow: 0.3,
    stretch: 0.0,
    light: 0.8,
    gloss: 14.0,
    lightAngle: 35.0,
    irid: 0.35,
    glow: 0.12,
    grain: 0.04,
    ca: 0.08,
    vig: 0.35,
    travel: 0.28,
    hue: 0.0,
    sat: 1.0,
    exposure: 0.85,
    contrast: 1.08,
  };

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  resize();
  window.addEventListener('resize', resize);

  // 8-second loop
  const LOOP_MS = 8000;
  let startTime = performance.now();
  let running = true;

  function render() {
    if (!running) return;
    const elapsed = (performance.now() - startTime) % LOOP_MS;
    const phase = elapsed / LOOP_MS;

    gl.uniform2f(U.u_res, canvas.width, canvas.height);
    gl.uniform1f(U.u_phase, phase);
    gl.uniform1f(U.u_seed, params.seed);
    gl.uniform3fv(U.u_c1, params.c1);
    gl.uniform3fv(U.u_c2, params.c2);
    gl.uniform3fv(U.u_c3, params.c3);
    gl.uniform3fv(U.u_c4, params.c4);
    gl.uniform3fv(U.u_bg, params.bg);
    gl.uniform1f(U.u_hue, params.hue);
    gl.uniform1f(U.u_sat, params.sat);
    gl.uniform1f(U.u_exposure, params.exposure);
    gl.uniform1f(U.u_contrast, params.contrast);
    gl.uniform1f(U.u_scale, params.scale);
    gl.uniform1f(U.u_complex, params.complex);
    gl.uniform1f(U.u_warp, params.warp);
    gl.uniform1f(U.u_flow, params.flow);
    gl.uniform1f(U.u_stretch, params.stretch);
    gl.uniform1f(U.u_light, params.light);
    gl.uniform1f(U.u_gloss, params.gloss);
    gl.uniform1f(U.u_lightAngle, params.lightAngle);
    gl.uniform1f(U.u_irid, params.irid);
    gl.uniform1f(U.u_glow, params.glow);
    gl.uniform1f(U.u_grain, params.grain);
    gl.uniform1f(U.u_ca, params.ca);
    gl.uniform1f(U.u_vig, params.vig);
    gl.uniform1f(U.u_travel, params.travel);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    requestAnimationFrame(render);
  }

  // Pause on hidden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      running = false;
    } else {
      running = true;
      startTime = performance.now() - (performance.now() % LOOP_MS);
      render();
    }
  });

  // Respect reduced motion
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    render();
  }
})();

`;

function landingPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%2306080c'/%3E%3Ctext x='50' y='72' font-family='monospace' font-size='52' font-weight='bold' text-anchor='middle' fill='%232dd4bf'%3E@%3C/text%3E%3C/svg%3E">
<title>agenttoll.dev — Paid data tools for AI agents</title>
<meta name="description" content="${TOOLS.length}+ paid x402 MCP tools for AI agents. Prediction markets, SEC filings, federal data, OSINT, academic research, health, environmental. Pay per call in USDC on Base.">
<meta property="og:title" content="agenttoll.dev — Paid data tools for AI agents">
<meta property="og:description" content="100+ paid x402 MCP tools for AI agents. Prediction markets, SEC filings, OSINT, legal, academic, health, environmental. Pay per call in USDC on Base.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://agenttoll.dev/">
<meta property="og:site_name" content="agenttoll.dev">
<meta property="og:image" content="https://agenttoll.dev/og-card.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:type" content="image/png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="agenttoll.dev — Paid data tools for AI agents">
<meta name="twitter:description" content="100+ paid x402 MCP tools. Pay per call in USDC on Base.">
<meta name="twitter:image" content="https://agenttoll.dev/og-card.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
${SHARED_CSS}
</style>
<!-- JSON-LD: Organization + Service -->
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "agenttoll.dev",
  "url": "https://agenttoll.dev",
  "description": "Paid x402 MCP tools for AI agents — prediction markets, SEC filings, OSINT, legal, academic, health, environmental, government, finance, security data.",
  "founder": {
    "@type": "Person",
    "name": "Hu White"
  },
  "sameAs": [
    "https://github.com/huwhitememes/tollbooth",
    "https://x.com/memerhuwhite"
  ]
}
</script>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "WebApplication",
  "name": "agenttoll.dev",
  "applicationCategory": "DeveloperApplication",
  "operatingSystem": "Web",
  "offers": {
    "@type": "Offer",
    "price": "0.01",
    "priceCurrency": "USD",
    "description": "Pay per API call in USDC on Base. No accounts, no subscriptions."
  },
  "featureList": [
    "100+ paid MCP tools",
    "x402 payment protocol",
    "USDC on Base mainnet",
    "Prediction market intelligence",
    "SEC EDGAR filings",
    "OSINT feeds",
    "Federal court records",
    "Academic paper search",
    "FDA drug data",
    "Environmental sensors"
  ]
}
</script>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "WebSite",
  "url": "https://agenttoll.dev/",
  "name": "agenttoll.dev",
  "potentialAction": {
    "@type": "SearchAction",
    "target": "https://agenttoll.dev/tools?q={search_term_string}",
    "query-input": "required name=search_term_string"
  }
}
</script>
</head>
<body>
<!-- SHADER BACKGROUND -->
<canvas id="shader-bg"></canvas>
<div class="glass-overlay"></div>

<!-- NAV -->
<nav>
  <a href="/" class="logo" style="text-decoration:none;color:inherit;">agent<span>toll</span>.dev</a>
  <button class="nav-toggle" aria-label="Menu" onclick="document.querySelector('nav .links').classList.toggle('open')">≡</button>
  <div class="links">
    <a href="/tools">Tools</a>
    <a href="/docs">Docs</a>
    <a href="/discovery">Discovery</a>
    <a href="/blog/x402-protocol-explained">Blog</a>
    <a href="/.well-known/agent.json">agent.json</a>
    <a href="/api/system/info">API</a>
    <a href="/mcp" class="cta">MCP Endpoint</a>
  </div>
</nav>

<!-- HERO -->
<main>
  <section class="hero">
    <div class="badge">x402 · USDC on Base · No account needed</div>
    <h1>Paid data tools<br>for AI agents.</h1>
    <p class="sub">Prediction markets, SEC filings, federal contracts, court records, academic research, OSINT, health data, environmental feeds. ${TOOLS.length}+ tools. $0.01–$0.10 per call. Pay in USDC over x402.</p>
    <div class="actions">
      <a href="/tools" class="btn btn-primary">Browse ${TOOLS.length} tools →</a>
      <a href="/discovery" class="btn btn-ghost">Discovery hub</a>
      <a href="/.well-known/agent.json" class="btn btn-ghost">View agent.json</a>
    </div>

    <div class="stats">
      <div class="stat"><div class="num">${TOOLS.length}+</div><div class="label">Tools</div></div>
      <div class="stat"><div class="num">10</div><div class="label">Categories</div></div>
      <div class="stat"><div class="num">$0.01</div><div class="label">Min price</div></div>
      <div class="stat"><div class="num">Base</div><div class="label">Network</div></div>
    </div>
  </section>

  <!-- CATEGORY PREVIEW -->
  <section class="categories">
    <div class="section-head">
      <h2>Categories</h2>
      <a href="/tools">View all →</a>
    </div>
    <div class="cat-grid">
      <a href="/tools#prediction-markets" class="cat-card">
        <h3><span class="icon">📊</span> Prediction Markets</h3>
        <p>Polymarket arbitrage, Kalshi cross-platform, trending markets, odds feed, smart money tracking.</p>
        <span class="cat-count">12 tools</span>
      </a>
      <a href="/tools#osint-intelligence" class="cat-card">
        <h3><span class="icon">🌍</span> OSINT & Intelligence</h3>
        <p>Geo tension signals, flight intel, research packs, SEC 8-K velocity, treasury data, HN, GitHub, Reddit.</p>
        <span class="cat-count">16 tools</span>
      </a>
      <a href="/tools#web-intel" class="cat-card">
        <h3><span class="icon">🔍</span> Web Intel</h3>
        <p>Scrape, tech stack fingerprint, contact extraction, lead scoring, agent policy checks.</p>
        <span class="cat-count">8 tools</span>
      </a>
      <a href="/tools#legal-regulatory" class="cat-card">
        <h3><span class="icon">⚖️</span> Legal & Regulatory</h3>
        <p>Court opinions, dockets, federal register, patents, trademarks, judges, regulations.</p>
        <span class="cat-count">7 tools</span>
      </a>
      <a href="/tools#academic-science" class="cat-card">
        <h3><span class="icon">🔬</span> Academic & Science</h3>
        <p>Papers, arXiv, PubMed, clinical trials, OpenAlex, citation graphs.</p>
        <span class="cat-count">7 tools</span>
      </a>
      <a href="/tools#health-safety" class="cat-card">
        <h3><span class="icon">💊</span> Health & Safety</h3>
        <p>Drug recalls, adverse events, product recalls, vehicle recalls, disease outbreaks, food safety.</p>
        <span class="cat-count">8 tools</span>
      </a>
      <a href="/tools#environmental" class="cat-card">
        <h3><span class="icon">🔥</span> Environmental</h3>
        <p>Wildfires, weather alerts, tides, space weather, earthquakes, marine conditions, air quality.</p>
        <span class="cat-count">13 tools</span>
      </a>
      <a href="/tools#government" class="cat-card">
        <h3><span class="icon">🏛️</span> Government</h3>
        <p>Federal spending, grants, contracts, lobbying, nonprofits, economic data, national debt.</p>
        <span class="cat-count">7 tools</span>
      </a>
      <a href="/tools#finance-crypto" class="cat-card">
        <h3><span class="icon">💰</span> Finance & Crypto</h3>
        <p>SEC EDGAR, insider trades, FRED economic data, currency rates, crypto prices, Bitcoin mempool.</p>
        <span class="cat-count">8 tools</span>
      </a>
      <a href="/tools#security" class="cat-card">
        <h3><span class="icon">🔒</span> Security</h3>
        <p>Threat intel, MCP supply-chain IOCs, trifecta score, agent policies, CVE search, company registry.</p>
        <span class="cat-count">6 tools</span>
      </a>
      <a href="/tools#gen-video-intel" class="cat-card">
        <h3><span class="icon">🎬</span> Gen-Video Intel</h3>
        <p>Generative video model intelligence, recommended settings, community workflow data.</p>
        <span class="cat-count">2 tools</span>
      </a>
      <a href="/tools#utility" class="cat-card">
        <h3><span class="icon">🔧</span> Utility</h3>
        <p>DNS lookup, IP geolocation, timezone, airport status, postal codes, ISBN book search.</p>
        <span class="cat-count">6 tools</span>
      </a>
    </div>
  </section>

  <!-- HOW IT WORKS -->
  <section class="how">
    <div class="section-head">
      <h2>How it works</h2>
    </div>
    <div class="how-grid">
      <div class="step">
        <div class="num">01</div>
        <h3>Discover</h3>
        <p>Your agent fetches <code>/.well-known/agent.json</code> to learn tool names, prices, and the MCP endpoint URL.</p>
      </div>
      <div class="step">
        <div class="num">02</div>
        <h3>Call</h3>
        <p>Agent calls the MCP tool or HTTP endpoint. Server responds with HTTP 402 and an x402 payment challenge.</p>
      </div>
      <div class="step">
        <div class="num">03</div>
        <h3>Pay & receive</h3>
        <p>Agent pays in USDC on Base via x402, retries with the payment header, and receives structured JSON.</p>
      </div>
    </div>
  </section>
</main>

<!-- FOOTER -->
<footer>
  <div class="inner">
    <div class="left">Built by Hu White · <a href="mailto:memerhuwhite@gmail.com" style="color: var(--accent); text-decoration: none;">Contact</a> · Settles on Base USDC to <code>${SERVICE.seller.slice(0,6)}…${SERVICE.seller.slice(-4)}</code></div>
    <div class="links">
      <a href="/tools">Tools</a>
      <a href="/discovery">Discovery</a>
      <a href="/mcp">MCP</a>
      <a href="/.well-known/mcp.json">MCP manifest</a>
      <a href="/openapi.json">OpenAPI</a>
      <a href="/llms-full.txt">llms-full.txt</a>
      <a href="/.well-known/agent.json">agent.json</a>
      <a href="mailto:memerhuwhite@gmail.com">Contact</a>
    </div>
  </div>
</footer>

<script>${SHARED_SHADER}</script>
</body>
</html>`;
}

function shellPage(title: string, content: string, headExtra: string = "") {
  const titleTag = headExtra && headExtra.includes("<title>")
    ? ""  // headExtra provides its own title
    : `<title>${title} — agenttoll.dev</title>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%2306080c'/%3E%3Ctext x='50' y='72' font-family='monospace' font-size='52' font-weight='bold' text-anchor='middle' fill='%232dd4bf'%3E@%3C/text%3E%3C/svg%3E">
${titleTag}
<meta property="og:title" content="${title} — agenttoll.dev">
<meta property="og:description" content="100+ paid x402 MCP tools for AI agents. Pay per call in USDC on Base.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://agenttoll.dev">
<meta property="og:site_name" content="agenttoll.dev">
<meta property="og:image" content="https://agenttoll.dev/og-card.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:type" content="image/png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://agenttoll.dev/og-card.png">
${headExtra}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
${SHARED_CSS}
</style>
</head>
<body>
<canvas id="shader-bg"></canvas>
<div class="glass-overlay"></div>
<nav>
  <a href="/" class="logo" style="text-decoration:none;color:inherit;">agent<span>toll</span>.dev</a>
  <button class="nav-toggle" aria-label="Menu" onclick="document.querySelector('nav .links').classList.toggle('open')">≡</button>
  <div class="links">
    <a href="/tools">Tools</a>
    <a href="/docs">Docs</a>
    <a href="/discovery">Discovery</a>
    <a href="/blog/x402-protocol-explained">Blog</a>
    <a href="/.well-known/agent.json">agent.json</a>
    <a href="/api/system/info">API</a>
    <a href="/mcp" class="cta">MCP Endpoint</a>
  </div>
</nav>
<main>
${content}
</main>
<footer>
  <div class="inner">
    <div class="left">Built by Hu White · <a href="mailto:memerhuwhite@gmail.com" style="color: var(--accent); text-decoration: none;">Contact</a> · Settles on Base USDC to <code>${SERVICE.seller.slice(0,6)}…${SERVICE.seller.slice(-4)}</code></div>
    <div class="links">
      <a href="/tools">Tools</a>
      <a href="/discovery">Discovery</a>
      <a href="/mcp">MCP</a>
      <a href="/.well-known/mcp.json">MCP manifest</a>
      <a href="/openapi.json">OpenAPI</a>
      <a href="/llms-full.txt">llms-full.txt</a>
      <a href="/.well-known/agent.json">agent.json</a>
      <a href="mailto:memerhuwhite@gmail.com">Contact</a>
    </div>
  </div>
</footer>
<script>${SHARED_SHADER}</script>
</body>
</html>`;
}

// ── Category definitions (single source of truth) ──────────────────
const TOOL_CATEGORIES = [
  { name: "Prediction Markets", icon: "\u{1F4CA}", tools: ["polymarket_event_scan","polymarket_market_scan","cross_platform_arb_scan","rebalance_arb_scan","trending_markets","odds_feed","volume_analytics","resolution_history","kalshi_markets","combinatorial_arb","orderbook_imbalance","smart_money"] },
  { name: "OSINT & Intelligence", icon: "\u{1F30D}", tools: ["geo_intervention_pulse","flight_intel","osint_research_pack","scenario_verdict","weather_bias_score","supply_chain_stress","regulatory_pulse","attention_momentum","sec_8k_velocity","fred_surprises","treasury_dts","openrouter_models","github_trending","github_repo_intel","hn_frontpage","reddit_search"] },
  { name: "Web Intel", icon: "\u{1F50D}", tools: ["scrape","detect_stack","extract_contacts","score_lead","enrich_lead","check_agent_policy","find_agent_resource","validate_agent_manifest"] },
  { name: "Legal & Regulatory", icon: "\u{2696}\u{FE0F}", tools: ["court_opinions","court_docket","federal_register","patents_search","regulations_search","judges_search","trademarks_search"] },
  { name: "Academic & Science", icon: "\u{1F52C}", tools: ["search_papers","search_arxiv","search_pubmed","clinical_trials","search_openalex","paper_details","citation_graph"] },
  { name: "Health & Safety", icon: "\u{1F48A}", tools: ["drug_recalls","adverse_events","product_recalls","vehicle_recalls","drug_labels","disease_outbreaks","food_safety","food_recall_check"] },
  { name: "Environmental", icon: "\u{1F525}", tools: ["wildfires","weather_alerts","tide_data","space_weather","water_levels","usgs_quake","openaq_air","space_weather_kp","weather_forecast_grid","weather_current_global","aurora_forecast","marine_conditions","air_quality_index"] },
  { name: "Government", icon: "\u{1F3DB}\u{FE0F}", tools: ["federal_spending","national_debt","federal_grants","nonprofit_filings","economic_indicators","lobbying_records","federal_contracts"] },
  { name: "Finance & Crypto", icon: "\u{1F4B0}", tools: ["edgar_filings","insider_trades","fred_series","currency_rates","business_days","crypto_price_simple","btc_address_balance","btc_mempool_fees"] },
  { name: "Security", icon: "\u{1F512}", tools: ["agent_threat_intel","mcp_supply_chain_iocs","agent_trifecta_score","agent_security_policies","cve_search","company_registry"] },
  { name: "Gen-Video Intel", icon: "\u{1F3AC}", tools: ["gen_video_intel","model_settings_lookup"] },
  { name: "Utility", icon: "\u{1F527}", tools: ["postal_code_lookup","ip_geolocation","timezone_current","airport_status","dns_records_lookup","isbn_book_lookup"] },
];

function categoryForTool(name: string): string {
  for (const cat of TOOL_CATEGORIES) {
    if (cat.tools.includes(name)) return cat.name;
  }
  return "Other";
}

function categorySlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function relatedTools(name: string): string[] {
  for (const cat of TOOL_CATEGORIES) {
    if (cat.tools.includes(name)) {
      return cat.tools.filter((t: string) => t !== name).slice(0, 4);
    }
  }
  return [];
}

function toolsDirectoryPage() {
  const categories = TOOL_CATEGORIES;

  const assigned = new Set<string>();
  categories.forEach(c => c.tools.forEach(t => assigned.add(t)));
  const unassigned = TOOLS.filter((t: any) => !assigned.has(t.name));

  const sections = categories.map(cat => {
    const catTools = cat.tools
      .map(n => TOOLS.find((t: any) => t.name === n))
      .filter(Boolean);
    if (catTools.length === 0) return "";
    catTools.forEach((t: any) => assigned.add(t.name));
    return `<div class="cat-section" id="${categorySlug(cat.name)}">
      <div class="cat-section-head">
        <h2><span class="cat-icon">${cat.icon}</span> ${cat.name}</h2>
        <span class="cat-count">${catTools.length} tools</span>
      </div>
      <div class="tools-grid">
        ${catTools.map((t: any) => `<a href="/tools/${t.name}" class="tool-card">
          <div class="tool-name">${t.name}</div>
          <div class="tool-price">$${t.price_usd}</div>
          <div class="tool-desc">${(t.description as string).slice(0, 120)}${(t.description as string).length > 120 ? "\u2026" : ""}</div>
        </a>`).join("")}
      </div>
    </div>`;
  }).join("");

  const otherSection = unassigned.length > 0 ? `<div class="cat-section" id="other">
    <div class="cat-section-head">
      <h2><span class="cat-icon">\u{1F4E6}</span> Other</h2>
      <span class="cat-count">${unassigned.length} tools</span>
    </div>
    <div class="tools-grid">
      ${unassigned.map((t: any) => `<a href="/tools/${t.name}" class="tool-card">
        <div class="tool-name">${t.name}</div>
        <div class="tool-price">$${t.price_usd}</div>
        <div class="tool-desc">${(t.description as string).slice(0, 120)}${(t.description as string).length > 120 ? "\u2026" : ""}</div>
      </a>`).join("")}
    </div>
  </div>` : "";

  const content = `<section style="padding: 60px 0;">
    <h2 style="font-size: clamp(28px, 5vw, 48px); font-weight: 700; letter-spacing: -0.03em; margin-bottom: 8px;">All ${TOOLS.length} tools</h2>
    <p style="color: var(--text-2); font-size: 16px; margin-bottom: 32px;">Every paid x402 MCP tool, grouped by category. Click any tool for details, pricing, and example input.</p>
    <input class="search-bar" type="text" placeholder="Search tools…" id="tool-search" onkeyup="const q=this.value.toLowerCase();document.querySelectorAll('.tool-card,.cat-section').forEach(c=>{if(c.classList.contains('cat-section')){const cards=c.querySelectorAll('.tool-card');let any=false;cards.forEach(card=>{const m=card.textContent.toLowerCase().includes(q);card.style.display=m?'':'none';if(m)any=true});c.style.display=any?'':'none'}else{const m=c.textContent.toLowerCase().includes(q);c.style.display=m?'':'none'}})">
    ${sections}
    ${otherSection}
  </section>`;

  return shellPage("Tools", content);
}

function toolDetailPage(toolName: string) {
  const tool = TOOLS.find((t) => t.name === toolName) as any;
  if (!tool) {
    return shellPage("Not found", `<section class="detail-page"><div class="back-link">← <a href="/tools" style="color: var(--accent); text-decoration: none;">Back to tools</a></div><h1>Tool not found</h1><p style="color: var(--text-2);">No tool named "${toolName}".</p></section>`);
  }

  // Find related tools (same category)
  const relatedNames = relatedTools(tool.name);
  const related = relatedNames.map(n => TOOLS.find((t: any) => t.name === n)).filter(Boolean);
  const relatedCards = related.map((t: any) => `<a href="/tools/${t.name}" class="tool-card" style="min-height: auto;">
    <div class="tool-name">${t.name}</div>
    <div class="tool-price">$${(t as any).price_usd}</div>
  </a>`).join("");

  // Category label from single source of truth
  const catLabel = categoryForTool(tool.name);

  // JSON-LD structured data for this specific tool
  const jsonLd = `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "${tool.name}",
  "applicationCategory": "DeveloperApplication",
  "operatingSystem": "Web",
  "description": "${(tool.description as string).slice(0, 300)}",
  "category": "${catLabel}",
  "offers": {
    "@type": "Offer",
    "price": "${tool.price_usd}",
    "priceCurrency": "USD",
    "description": "Pay per call in USDC on Base via x402. No accounts."
  },
  "author": {
    "@type": "Person",
    "name": "Hu White",
    "url": "https://agenttoll.dev",
    "sameAs": ["https://github.com/huwhitememes"]
  },
  "publisher": {
    "@type": "Organization",
    "name": "agenttoll.dev",
    "url": "https://agenttoll.dev"
  },
  "datePublished": "2026-07-12",
  "dateModified": "2026-07-12"
}
</script>`;

  const headExtra = `<title>${tool.name} — $${tool.price_usd}/call | agenttoll.dev</title>
<meta name="description" content="${tool.name} is a paid MCP tool on agenttoll.dev. ${(tool.description as string).slice(0, 120)} Pay $${tool.price_usd} per call in USDC on Base.">
<link rel="canonical" href="https://agenttoll.dev/tools/${tool.name}">
${jsonLd}`;

  const content = `<section class="detail-page">
    <div class="back-link">← <a href="/tools" style="color: var(--accent); text-decoration: none;">All tools</a> / <span style="color: var(--text-3);">${catLabel}</span></div>
    <div class="tool-header">
      <h1>${tool.name}</h1>
      <div class="tool-price-large">$${tool.price_usd}<span style="font-size: 14px; color: var(--text-3); font-weight: 400;">/call</span></div>
    </div>
    <p class="tool-desc-full">${tool.description}</p>

    <div class="tool-section">
      <h3>What is ${tool.name}?</h3>
      <p style="color: var(--text-2); font-size: 15px; line-height: 1.7;">${tool.name} is a paid MCP tool in the ${catLabel} category on agenttoll.dev. It costs $${tool.price_usd} per call, settled in USDC on Base via the x402 payment protocol. No API keys, no accounts — your agent discovers it via <code>/.well-known/agent.json</code>, calls it, pays the $${tool.price_usd} fee, and receives structured JSON.</p>
    </div>

    <div class="tool-section">
      <h3>Input parameters</h3>
      <pre>${JSON.stringify(tool.input, null, 2)}</pre>
    </div>

    <div class="tool-section">
      <h3>Example usage</h3>
      <pre>${JSON.stringify(tool.example, null, 2)}</pre>
    </div>

    ${tool.http_path ? `<div class="tool-section"><h3>HTTP endpoint</h3><p style="color: var(--text-2); font-size: 14px; margin-bottom: 8px;">POST to this path with JSON body. Server returns 402 with x402 payment requirements.</p><pre>${tool.http_path}</pre></div>` : ''}

    <div class="tool-section">
      <h3>How to call ${tool.name}</h3>
      <p style="color: var(--text-2); font-size: 14px; margin-bottom: 12px;">Connect any MCP-compatible client (Claude Desktop, Cursor, custom agent) to the agenttoll.dev MCP endpoint:</p>
      <pre>${SERVICE.origin}${SERVICE.mcpPath}</pre>
      <p style="color: var(--text-3); font-size: 13px; margin-top: 12px;">Or call the HTTP endpoint directly with an x402-capable fetch client.</p>
    </div>

    <div class="tool-section">
      <h3>Pricing & payment</h3>
      <div style="display: flex; gap: 24px; flex-wrap: wrap; margin-top: 8px;">
        <div><div style="font-size: 13px; color: var(--text-3);">Price</div><div style="font-family: 'JetBrains Mono', monospace; font-size: 16px; color: var(--price); font-weight: 700;">$${tool.price_usd}/call</div></div>
        <div><div style="font-size: 13px; color: var(--text-3);">Network</div><div style="font-family: 'JetBrains Mono', monospace; font-size: 16px; color: var(--text);">Base USDC</div></div>
        <div><div style="font-size: 13px; color: var(--text-3);">Protocol</div><div style="font-family: 'JetBrains Mono', monospace; font-size: 16px; color: var(--text);">x402</div></div>
        <div><div style="font-size: 13px; color: var(--text-3);">Receipts</div><div style="font-family: 'JetBrains Mono', monospace; font-size: 16px; color: var(--text);">/receipt/:tx</div></div>
      </div>
    </div>

    <div class="tool-section">
      <h3>FAQ</h3>
      <details style="margin-bottom: 12px;"><summary style="cursor: pointer; color: var(--text); font-size: 14px; font-weight: 500;">How much does ${tool.name} cost?</summary><p style="color: var(--text-2); font-size: 14px; margin-top: 8px; padding-left: 16px;">$${tool.price_usd} per call in USDC on Base. No subscriptions or minimums.</p></details>
      <details style="margin-bottom: 12px;"><summary style="cursor: pointer; color: var(--text); font-size: 14px; font-weight: 500;">Do I need an API key?</summary><p style="color: var(--text-2); font-size: 14px; margin-top: 8px; padding-left: 16px;">No. Payment is handled by the x402 protocol. Your agent wallet sends USDC on Base, the server verifies the transfer, and returns the data.</p></details>
      <details style="margin-bottom: 12px;"><summary style="cursor: pointer; color: var(--text); font-size: 14px; font-weight: 500;">Which AI models work with ${tool.name}?</summary><p style="color: var(--text-2); font-size: 14px; margin-top: 8px; padding-left: 16px;">Any model that supports MCP — Claude, GPT-4, Gemini, or local models via an MCP client. The tool returns structured JSON that any model can parse.</p></details>
      <details style="margin-bottom: 12px;"><summary style="cursor: pointer; color: var(--text); font-size: 14px; font-weight: 500;">How do I verify my payment?</summary><p style="color: var(--text-2); font-size: 14px; margin-top: 8px; padding-left: 16px;">After settlement, check <code>/receipt/&lt;tx&gt;</code> for on-chain verification via Basescan. Every payment is a real USDC transfer to ${SERVICE.seller.slice(0,10)}…</p></details>
    </div>

    <div style="margin-top: 32px; display: flex; gap: 12px; flex-wrap: wrap;">
      <a href="${SERVICE.origin}${SERVICE.mcpPath}" class="btn btn-primary">Open MCP endpoint →</a>
      <a href="/.well-known/agent.json" class="btn btn-ghost">View agent.json</a>
      <a href="/tools" class="btn btn-ghost">Browse all ${TOOLS.length} tools</a>
    </div>

    <div style="margin-top: 48px; padding-top: 24px; border-top: 1px solid var(--border);">
      <h3 style="font-size: 14px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-3); margin-bottom: 16px;">Related tools</h3>
      <div class="tools-grid" style="padding: 0;">
        ${relatedCards}
      </div>
    </div>

    <div style="margin-top: 48px; padding: 24px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 16px; backdrop-filter: blur(12px);">
      <div style="display: flex; gap: 16px; align-items: center;">
        <div style="width: 48px; height: 48px; border-radius: 50%; overflow: hidden; flex-shrink: 0;"><img src="/hu-white-pfp.jpg" alt="Hu White" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;"></div>
        <div>
          <div style="font-size: 15px; font-weight: 600; color: var(--text);">Hu White</div>
          <div style="font-size: 13px; color: var(--text-3);">Generative-AI veteran · x402 protocol contributor · <a href="https://github.com/huwhitememes" style="color: var(--accent); text-decoration: none;">GitHub</a> · <a href="https://www.linkedin.com/in/huwhitememes/" style="color: var(--accent); text-decoration: none;">LinkedIn</a> · <a href="https://x.com/huwhitememes" style="color: var(--accent); text-decoration: none;">X</a></div>
        </div>
      </div>
      <p style="font-size: 13px; color: var(--text-2); margin-top: 12px; line-height: 1.6;">Built and operates agenttoll.dev — a marketplace of 100+ paid MCP tools settling on Base USDC. Every tool is tested against live APIs before listing.</p>
    </div>
  </section>`;

  return shellPage(tool.name, content, headExtra);
}

function discoveryPage() {
  const surfaces = [
    { label: "MCP manifest", href: "/.well-known/mcp.json", text: "Machine-readable MCP entrypoint, auth modes, payments, and tool roster." },
    { label: "System info", href: "/api/system/info", text: "Network, seller wallet, asset contract, categories, and discovery URLs." },
    { label: "llms-full.txt", href: "/llms-full.txt", text: "Long-form agent context with every tool, price, quote URL, and endpoint." },
    { label: "Quote API", href: "/api/quote?tool=trending_markets", text: "Free price lookup before an agent attempts a paid call." },
    { label: "OpenAPI", href: "/openapi.json", text: "OpenAPI 3.1 spec for public metadata and paid HTTP routes." },
    { label: "x402 resources", href: "/.well-known/x402", text: "x402 discovery surface used by paid-resource crawlers." },
    { label: "agent.json", href: "/.well-known/agent.json", text: "Agent-facing manifest with MCP URL, payment data, and tool list." },
    { label: "Tools", href: "/tools", text: "Human-readable catalog with pages for each paid tool." },
  ];

  const content = `<section style="padding: 60px 0;">
    <h2 style="font-size: clamp(28px, 5vw, 48px); font-weight: 700; letter-spacing: -0.03em; margin-bottom: 8px;">Discovery hub</h2>
    <p style="color: var(--text-2); font-size: 16px; margin-bottom: 32px; max-width: 760px;">These are the public entrypoints agents and humans can use to inspect agenttoll.dev before paying for a call. The JSON and text routes are crawler-friendly. The tool pages stay readable for people.</p>
    <div class="tools-grid">
      ${surfaces.map((surface) => `<a href="${surface.href}" class="tool-card">
        <div class="tool-name">${surface.label}</div>
        <div class="tool-desc">${surface.text}</div>
        <div class="tool-price" style="font-size: 12px; margin-top: 12px;">${surface.href}</div>
      </a>`).join("")}
    </div>
    <div class="cat-card" style="margin-top: 32px;">
      <h3 style="font-size: 15px; font-weight: 600; margin-bottom: 8px;">Quote a tool</h3>
      <p style="font-size: 14px; color: var(--text-2); margin-bottom: 12px;">Use the free quote endpoint to check price, network, asset, seller wallet, and endpoints before a paid x402 call.</p>
      <pre style="background: rgba(6,8,12,0.6); border: 1px solid var(--border); border-radius: 12px; padding: 16px; font-family: 'JetBrains Mono', monospace; font-size: 13px; overflow-x: auto;">curl ${SERVICE.origin}/api/quote?tool=trending_markets</pre>
    </div>
  </section>`;

  return shellPage("Discovery", content, `<meta name="description" content="Human and machine discovery surfaces for agenttoll.dev: MCP manifest, x402 resources, OpenAPI, llms-full.txt, system info, and quote API.">`);
}

function docsPage() {
  const content = `<section style="padding: 60px 0;">
    <h2 style="font-size: clamp(28px, 5vw, 48px); font-weight: 700; letter-spacing: -0.03em; margin-bottom: 8px;">Documentation</h2>
    <p style="color: var(--text-2); font-size: 16px; margin-bottom: 32px; max-width: 620px;">agenttoll.dev is a paid MCP service. Agents buy data calls one at a time in USDC on Base. No accounts, no subscriptions.</p>

    <div class="cat-card" style="margin-bottom: 16px;">
      <h3 style="font-size: 15px; font-weight: 600; margin-bottom: 8px;">Agent discovery surfaces</h3>
      <p style="font-size: 14px; color: var(--text-2); margin-bottom: 12px;">Use these routes when you want a crawler, MCP client, or human reviewer to understand the service before paying.</p>
      <p style="font-size: 14px; color: var(--text-2); line-height: 1.9;">
        <a href="/discovery" style="color: var(--accent); text-decoration: none;">Discovery hub</a><br>
        <a href="/.well-known/mcp.json" style="color: var(--accent); text-decoration: none;">MCP manifest</a><br>
        <a href="/api/system/info" style="color: var(--accent); text-decoration: none;">System info</a><br>
        <a href="/llms-full.txt" style="color: var(--accent); text-decoration: none;">llms-full.txt</a><br>
        <a href="/api/quote?tool=trending_markets" style="color: var(--accent); text-decoration: none;">Quote API</a>
      </p>
    </div>

    <div class="cat-card" style="margin-bottom: 16px;">
      <h3 style="font-size: 15px; font-weight: 600; margin-bottom: 8px;">MCP endpoint</h3>
      <pre style="background: rgba(6,8,12,0.6); border: 1px solid var(--border); border-radius: 12px; padding: 16px; font-family: 'JetBrains Mono', monospace; font-size: 13px; overflow-x: auto;">${SERVICE.origin}${SERVICE.mcpPath}</pre>
    </div>

    <div class="cat-card" style="margin-bottom: 16px;">
      <h3 style="font-size: 15px; font-weight: 600; margin-bottom: 8px;">Payment rail</h3>
      <p style="font-size: 14px; color: var(--text-2); margin-bottom: 12px;">Paid tools settle in Base USDC through x402. A buyer wallet needs USDC on Base mainnet.</p>
      <pre style="background: rgba(6,8,12,0.6); border: 1px solid var(--border); border-radius: 12px; padding: 16px; font-family: 'JetBrains Mono', monospace; font-size: 13px; overflow-x: auto;">Network: ${SERVICE.networkName}
USDC token contract: ${SERVICE.usdc}
Seller wallet: ${SERVICE.seller}</pre>
    </div>

    <div class="cat-card" style="margin-bottom: 16px;">
      <h3 style="font-size: 15px; font-weight: 600; margin-bottom: 8px;">Paid call flow</h3>
      <p style="font-size: 14px; color: var(--text-2); line-height: 1.8;">
        1. Agent fetches <code>/.well-known/agent.json</code> for tool names and prices.<br>
        2. Agent calls the MCP tool or HTTP endpoint.<br>
        3. Server responds with HTTP 402 and an x402 payment challenge.<br>
        4. Agent pays in USDC on Base, retries with payment header.<br>
        5. Agent receives structured JSON result.
      </p>
    </div>

    <div class="cat-card" style="margin-bottom: 16px;">
      <h3 style="font-size: 15px; font-weight: 600; margin-bottom: 8px;">Receipts</h3>
      <p style="font-size: 14px; color: var(--text-2);">After payment settles, verify on Base with <code>/receipt/&lt;tx&gt;</code>.</p>
    </div>

    <div style="margin-top: 32px; display: flex; gap: 12px; flex-wrap: wrap;">
      <a href="${SERVICE.origin}${SERVICE.mcpPath}" class="btn btn-primary">Open MCP endpoint →</a>
      <a href="/tools" class="btn btn-ghost">Browse ${TOOLS.length} tools</a>
      <a href="/.well-known/agent.json" class="btn btn-ghost">View agent.json</a>
    </div>
  </section>`;

  return shellPage("Docs", content);
}
function openApiSpec() {
  const info = serviceInfo();
  return {
    openapi: "3.1.0",
    info: {
      title: SERVICE.name,
      version: SERVICE.version,
      description: "Public metadata endpoints for agenttoll.dev, an x402-paid MCP service on Base USDC.",
    },
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    servers: [{ url: SERVICE.origin }],
    paths: {
      "/api/info": {
        get: {
          summary: "Get agenttoll.dev service metadata",
          responses: { "200": { description: "Service metadata, payment rail, endpoints, and paid tool catalog.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } } },
        },
      },
      "/api/system/info": {
        get: {
          summary: "Get machine-readable system info",
          responses: { "200": { description: "Network, payment, category, and discovery metadata.", "content": { "application/json": { "schema": { "type": "object" } } } } },
        },
      },
      "/api/quote": {
        get: {
          summary: "Quote one paid tool before payment",
          parameters: [{ name: "tool", in: "query", required: false, schema: { type: "string" }, description: "Tool name, for example trending_markets" }],
          responses: { "200": { description: "Tool price, payment rail, endpoints, and example input.", "content": { "application/json": { "schema": { "type": "object" } } } }, "404": { description: "Tool not found." } },
        },
      },
      "/llms-full.txt": {
        get: {
          summary: "Long-form LLM discovery context",
          responses: { "200": { description: "Plain-text catalog for agents and LLM crawlers.", "content": { "text/plain": { "schema": { "type": "string" } } } } },
        },
      },
      "/.well-known/mcp.json": {
        get: {
          summary: "Get MCP discovery manifest",
          responses: { "200": { description: "MCP URL, tool roster, x402 auth mode, and discovery links.", "content": { "application/json": { "schema": { "type": "object" } } } } },
        },
      },
      "/api/openapi.json": {
        get: {
          summary: "OpenAPI alias",
          responses: { "200": { description: "Same OpenAPI 3.1 document served at /openapi.json.", "content": { "application/json": { "schema": { "type": "object" } } } } },
        },
      },
      "/.well-known/agent.json": {
        get: {
          summary: "Get agent discovery metadata",
          responses: { "200": { description: "Agent discovery document with MCP URL, payment metadata, and tools.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } } },
        },
      },
      "/receipt/{tx}": {
        get: {
          summary: "Verify a Base USDC payment receipt",
          parameters: [{ name: "tx", in: "path", required: true, schema: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" } }],
          responses: {
            "200": { description: "Receipt found. Response says whether a matching USDC transfer to the seller wallet was verified.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } },
            "400": { description: "Invalid transaction hash shape." },
            "404": { description: "Transaction not found or still pending." },
          },
        },
      },
      "/paid/polymarket/event-scan": {
        post: {
          summary: "Paid live Polymarket negRisk event scan",
          description: "Returns HTTP 402 until paid $0.03 in Base USDC through x402.",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["slug"], properties: { slug: { type: "string" }, min_edge: { type: "number" }, min_liquidity: { type: "number" } } } } } },
          responses: { "200": { description: "Live event scan.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "x402 payment requirements." } },
        },
      },
      "/paid/polymarket/market-scan": {
        post: {
          summary: "Paid live Polymarket market scan",
          description: "Returns HTTP 402 until paid $0.05 in Base USDC through x402.",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { limit: { type: "integer", minimum: 10, maximum: 200 }, min_certainty: { type: "number" }, min_edge: { type: "number" } } } } } },
          responses: { "200": { description: "Live market scan.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "x402 payment requirements." } },
        },
      },
      "/paid/markets/cross-platform-scan": {
        post: {
          summary: "Paid live Polymarket-versus-Kalshi spread scan",
          description: "Returns HTTP 402 until paid $0.10 in Base USDC through x402.",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["query"], properties: { query: { type: "string", minLength: 2, maxLength: 100 }, min_similarity: { type: "number" }, min_net_edge: { type: "number" }, kalshi_max_pages: { type: "integer", minimum: 1, maximum: 20 } } } } } },
          responses: { "200": { description: "Live cross-platform candidate and opportunity scan.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "x402 payment requirements." } },
        },
      },
      "/paid/polymarket/rebalance-scan": {
        post: {
          summary: "Paid Polymarket rebalance arbitrage scan",
          description: "Returns HTTP 402 until paid $0.04 in Base USDC through x402. Scans for YES+NO pricing violations.",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { limit: { type: "integer", minimum: 10, maximum: 2000 }, min_edge: { type: "number" }, min_liquidity: { type: "number" } } } } } },
          responses: { "200": { description: "Rebalance arbitrage opportunities.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "x402 payment requirements." } },
        },
      },
      "/paid/polymarket/trending": {
        post: {
          summary: "Paid Polymarket trending markets",
          description: "Returns HTTP 402 until paid $0.02 in Base USDC through x402. Top markets by 24h volume.",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { limit: { type: "integer", minimum: 5, maximum: 100 }, category: { type: "string" } } } } } },
          responses: { "200": { description: "Trending market data.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "x402 payment requirements." } },
        },
      },
      "/paid/odds/feed": {
        post: {
          summary: "Paid normalized odds feed (Polymarket + Kalshi)",
          description: "Returns HTTP 402 until paid $0.02 in Base USDC through x402. Live YES/NO prices, spreads, volume across both platforms.",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { limit: { type: "integer", minimum: 5, maximum: 100 }, platform: { type: "string", enum: ["polymarket", "kalshi", "both"] } } } } } },
          responses: { "200": { description: "Normalized odds data.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "x402 payment requirements." } },
        },
      },
      "/paid/polymarket/volume-analytics": {
        post: {
          summary: "Paid Polymarket volume analytics",
          description: "Returns HTTP 402 until paid $0.03 in Base USDC through x402. Top markets by volume with momentum and price change.",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { limit: { type: "integer", minimum: 5, maximum: 100 }, min_volume: { type: "number" } } } } } },
          responses: { "200": { description: "Volume analytics data.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "x402 payment requirements." } },
        },
      },
      "/paid/polymarket/resolution-history": {
        post: {
          summary: "Paid Polymarket resolution history",
          description: "Returns HTTP 402 until paid $0.03 in Base USDC through x402. Recently resolved markets for backtesting.",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { limit: { type: "integer", minimum: 5, maximum: 100 }, days_back: { type: "integer", minimum: 1, maximum: 90 } } } } } },
          responses: { "200": { description: "Resolution history data.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "x402 payment requirements." } },
        },
      },
      "/paid/kalshi/markets": {
        post: {
          summary: "Paid Kalshi live markets",
          description: "Returns HTTP 402 until paid $0.02 in Base USDC through x402. Live bid/ask spreads, volume, open interest.",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { limit: { type: "integer", minimum: 5, maximum: 100 }, category: { type: "string" } } } } } },
          responses: { "200": { description: "Kalshi market data.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "x402 payment requirements." } },
        },
      },
      "/paid/security/threat-intel": {
        post: {
          summary: "Paid OWASP Agentic Top 10 threat intel",
          description: "Returns HTTP 402 until paid $0.03 in Base USDC.",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { category: { type: "string" }, id: { type: "string" }, severity: { type: "string", enum: ["critical","high","medium","low"] } } } } } },
          responses: { "200": { description: "Threat intel.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } },
        },
      },
      "/paid/security/mcp-iocs": {
        post: {
          summary: "Paid MCP supply-chain IOCs",
          description: "Returns HTTP 402 until paid $0.02.",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { package: { type: "string" }, host: { type: "string" } } } } } },
          responses: { "200": { description: "IOC lookup.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } },
        },
      },
      "/paid/security/trifecta-score": {
        post: {
          summary: "Paid trifecta score",
          description: "Returns HTTP 402 until paid $0.05.",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["has_private_data","has_untrusted_content","has_outbound_actions"], properties: { has_private_data: { type: "boolean" }, has_untrusted_content: { type: "boolean" }, has_outbound_actions: { type: "boolean" }, compensating_controls: { type: "array", items: { type: "string" } } } } } } },
          responses: { "200": { description: "Trifecta score.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } },
        },
      },
      "/paid/security/policies": {
        post: {
          summary: "Paid security policies",
          description: "Returns HTTP 402 until paid $0.05.",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { profile: { type: "string", enum: ["coding-agent","browser-agent","payment-agent","research-agent"] } } } } } },
          responses: { "200": { description: "Policies.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } },
        },
      },
      "/paid/osint/geo-pulse": {
        post: {
          summary: "Paid geo intervention pulse — GDELT + BBC + ADS-B + prediction-market boosters",
          description: "Returns HTTP 402 until paid $0.04 in Base USDC through x402. intervention signal pattern.",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { region: { type: "string", enum: ["global","middle_east","ukraine","taiwan","asia_pacific"] }, min_confidence: { type: "number" }, hours_back: { type: "integer", minimum: 1, maximum: 72 }, include_thermal: { type: "boolean" } } } } } },
          responses: { "200": { description: "Geo pulse.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } },
        },
      },
      "/paid/osint/flight-intel": {
        post: {
          summary: "Paid flight intel — exec + mil jets via adsb.lol",
          description: "Returns HTTP 402 until paid $0.03.",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { airport_code: { type: "string" }, tail_number: { type: "string" }, hours_back: { type: "integer", minimum: 1, maximum: 72 } } } } } },
          responses: { "200": { description: "Flight intel.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } },
        },
      },
      "/paid/osint/research-pack": {
        post: {
          summary: "Paid multi-source OSINT research pack — GDELT + BBC + HN + Reddit",
          description: "Returns HTTP 402 until paid $0.05. research pack 4-layer verification.",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["topic"], properties: { topic: { type: "string", minLength: 3, maxLength: 200 }, domains: { type: "array", items: { type: "string" } }, include_sources: { type: "array", items: { type: "string" } }, hours_back: { type: "integer", minimum: 1, maximum: 720 } } } } } },
          responses: { "200": { description: "Research pack.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } },
        },
      },
      "/paid/osint/scenario-verdict": {
        post: {
          summary: "Paid scenario-engine verdict",
          description: "Returns HTTP 402 until paid $0.05. Seed->entity->bear/base/bull->YES prob + fair price.",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["seed_text","market_question"], properties: { seed_text: { type: "string", minLength: 10, maxLength: 5000 }, market_question: { type: "string", minLength: 5, maxLength: 500 }, context: { type: "string" } } } } } },
          responses: { "200": { description: "Scenario verdict.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } },
        },
      },
      "/paid/osint/weather-bias": {
        post: {
          summary: "Paid weather bias — Open-Meteo fix for kalshi HIGH*",
          description: "Returns HTTP 402 until paid $0.03. Archive vs forecast anomaly, ticker map HIGHNY/HIGHCHI/HIGHMIA.",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { city: { type: "string" }, model: { type: "string" }, days_back: { type: "integer", minimum: 2, maximum: 30 } } } } } },
          responses: { "200": { description: "Weather bias.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } },
        },
      },
      "/paid/osint/supply-stress": {
        post: {
          summary: "Paid supply-chain stress — CBP BWT + GDELT chokepoints",
          description: "Returns HTTP 402 until paid $0.03.",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { ports: { type: "array", items: { type: "string" } }, chokepoints: { type: "array", items: { type: "string" } } } } } } },
          responses: { "200": { description: "Supply stress.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } },
        },
      },
      "/paid/osint/regulatory-pulse": {
        post: {
          summary: "Paid regulatory pulse — SEC + FDA + USPTO + FCC + FAA",
          description: "Returns HTTP 402 until paid $0.03.",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { org: { type: "string", enum: ["all","sec","fda","uspto","fcc","faa","openfda"] }, hours_back: { type: "integer", minimum: 1, maximum: 720 } } } } } },
          responses: { "200": { description: "Regulatory pulse.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } },
        },
      },
      "/paid/osint/attention-momentum": {
        post: {
          summary: "Paid attention momentum — HN + Reddit velocity + npm/py counts",
          description: "Returns HTTP 402 until paid $0.02. Momentum = vel*0.6 + score/100*0.3 + comments/50*0.1.",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { query: { type: "string", maxLength: 200 }, window: { type: "string", enum: ["1h","6h","24h"] } } } } } },
          responses: { "200": { description: "Attention momentum.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } },
        },
      },
      "/paid/osint/sec-8k-velocity": {
        post: {
          summary: "Paid SEC 8-K velocity — EFTS + Atom spike",
          description: "Returns HTTP 402 until paid $0.03. Earnings/merger/legal lead.",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { hours: { type: "integer", minimum: 1, maximum: 72 }, limit: { type: "integer", minimum: 10, maximum: 200 }, min_score: { type: "number", minimum: 0, maximum: 1 } } } } } },
          responses: { "200": { description: "8-K velocity.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } },
        },
      },
      "/paid/osint/fred-surprises": {
        post: {
          summary: "Paid FRED surprises — rates CSV public-domain",
          description: "Returns HTTP 402 until paid $0.02. DGS10/DGS2 spread + inversion.",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { days: { type: "integer", minimum: 5, maximum: 90 }, min_score: { type: "number", minimum: 0, maximum: 1 } } } } } },
          responses: { "200": { description: "FRED surprises.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } },
        },
      },
      "/paid/osint/treasury-dts": {
        post: {
          summary: "Paid Treasury DTS — TGA liquidity",
          description: "Returns HTTP 402 until paid $0.04. TGA $B d/d delta.",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { days: { type: "integer", minimum: 2, maximum: 30 }, min_score: { type: "number", minimum: 0, maximum: 1 } } } } } },
          responses: { "200": { description: "Treasury DTS.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } },
        },
      },
      "/paid/osint/github-trending": {
        post: {
          summary: "Paid GitHub trending repos — stars + recent push",
          description: "Returns HTTP 402 until paid $0.02. Public GitHub search API.",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50 }, language: { type: "string" }, since_days: { type: "integer", minimum: 1, maximum: 30 } } } } } },
          responses: { "200": { description: "GitHub trending.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } },
        },
      },
      "/paid/osint/hn-frontpage": {
        post: {
          summary: "Paid Hacker News front page — dwell-ranked",
          description: "Returns HTTP 402 until paid $0.02. HN Algolia API, dwell = points/(age_h+2).",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50 }, min_points: { type: "integer", minimum: 0 } } } } } },
          responses: { "200": { description: "HN front page.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } },
        },
      },
      "/paid/osint/usgs-quake": {
        post: {
          summary: "Paid USGS earthquakes — all-day feed, magnitude-sorted",
          description: "Returns HTTP 402 until paid $0.02. USGS all_day.geojson.",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { min_mag: { type: "number" }, limit: { type: "integer", minimum: 1, maximum: 100 } } } } } },
          responses: { "200": { description: "Quakes.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } },
        },
      },
      "/paid/osint/openaq-air": {
        post: {
          summary: "Paid OpenAQ air quality pulse — global locations",
          description: "Returns HTTP 402 until paid $0.02. OpenAQ v3 with v2 fallback.",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50 }, country: { type: "string" } } } } } },
          responses: { "200": { description: "Air quality.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } },
        },
      },
      "/paid/osint/openrouter-models": {
        post: {
          summary: "Paid OpenRouter model usage — live model catalog",
          description: "Returns HTTP 402 until paid $0.02. Public openrouter.ai/api/v1/models.",
          requestBody: { content: { "application/json": { schema: { type: "object" } } } },
          responses: { "200": { description: "Model catalog.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } },
        },
      },
      // ── Legal & Regulatory (v0.11.0) ──────────────────────────
      "/paid/legal/court-opinions": { post: { summary: "Search US federal court opinions (CourtListener)", description: "Returns HTTP 402 until paid $0.05.", requestBody: { content: { "application/json": { schema: { type: "object", properties: { query: { type: "string" }, court: { type: "string" }, days_back: { type: "integer" } } } } } }, responses: { "200": { description: "Court opinions.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } } } },
      "/paid/legal/court-docket": { post: { summary: "Look up a federal court docket (CourtListener RECAP)", description: "Returns HTTP 402 until paid $0.05.", requestBody: { content: { "application/json": { schema: { type: "object", properties: { docket_id: { type: "string" } } } } } }, responses: { "200": { description: "Docket data.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } } } },
      "/paid/legal/federal-register": { post: { summary: "Search the Federal Register", description: "Returns HTTP 402 until paid $0.03.", requestBody: { content: { "application/json": { schema: { type: "object", properties: { query: { type: "string" }, agency: { type: "string" }, type: { type: "string" } } } } } }, responses: { "200": { description: "Federal Register results.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } } } },
      "/paid/legal/patents": { post: { summary: "Search patents (Google Patents)", description: "Returns HTTP 402 until paid $0.04.", requestBody: { content: { "application/json": { schema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } } } } } }, responses: { "200": { description: "Patent results.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } } } },
      "/paid/legal/regulations": { post: { summary: "Search regulations and dockets", description: "Returns HTTP 402 until paid $0.03.", requestBody: { content: { "application/json": { schema: { type: "object", properties: { query: { type: "string" }, status: { type: "string" } } } } } }, responses: { "200": { description: "Regulation results.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } } } },
      // ── Academic & Scientific (v0.11.0) ───────────────────────
      "/paid/academic/papers": { post: { summary: "Search 226M+ academic papers (Semantic Scholar)", description: "Returns HTTP 402 until paid $0.04.", requestBody: { content: { "application/json": { schema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } } } } } }, responses: { "200": { description: "Papers.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } } } },
      "/paid/academic/arxiv": { post: { summary: "Search arXiv preprints", description: "Returns HTTP 402 until paid $0.02.", requestBody: { content: { "application/json": { schema: { type: "object", properties: { query: { type: "string" }, category: { type: "string" }, limit: { type: "integer" } } } } } }, responses: { "200": { description: "Preprints.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } } } },
      "/paid/academic/pubmed": { post: { summary: "Search PubMed biomedical papers", description: "Returns HTTP 402 until paid $0.03.", requestBody: { content: { "application/json": { schema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } } } } } }, responses: { "200": { description: "PubMed results.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } } } },
      "/paid/academic/clinical-trials": { post: { summary: "Search ClinicalTrials.gov", description: "Returns HTTP 402 until paid $0.04.", requestBody: { content: { "application/json": { schema: { type: "object", properties: { query: { type: "string" }, status: { type: "string" }, limit: { type: "integer" } } } } } }, responses: { "200": { description: "Clinical trials.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } } } },
      "/paid/academic/openalex": { post: { summary: "Search OpenAlex academic works", description: "Returns HTTP 402 until paid $0.03.", requestBody: { content: { "application/json": { schema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } } } } } }, responses: { "200": { description: "OpenAlex results.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } } } },
      // ── Public Health & Safety (v0.11.0) ──────────────────────
      "/paid/health/drug-recalls": { post: { summary: "Search FDA drug recalls (openFDA)", description: "Returns HTTP 402 until paid $0.03.", requestBody: { content: { "application/json": { schema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } } } } } }, responses: { "200": { description: "Recalls.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } } } },
      "/paid/health/adverse-events": { post: { summary: "Search FDA adverse drug events (openFDA)", description: "Returns HTTP 402 until paid $0.04.", requestBody: { content: { "application/json": { schema: { type: "object", properties: { drug: { type: "string" }, limit: { type: "integer" } } } } } }, responses: { "200": { description: "Adverse events.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } } } },
      "/paid/health/product-recalls": { post: { summary: "Search CPSC product recalls", description: "Returns HTTP 402 until paid $0.03.", requestBody: { content: { "application/json": { schema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } } } } } }, responses: { "200": { description: "Product recalls.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } } } },
      "/paid/health/vehicle-recalls": { post: { summary: "Search NHTSA vehicle recalls", description: "Returns HTTP 402 until paid $0.03.", requestBody: { content: { "application/json": { schema: { type: "object", properties: { make: { type: "string" }, model: { type: "string" }, vin: { type: "string" } } } } } }, responses: { "200": { description: "Vehicle recalls.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } } } },
      "/paid/health/drug-labels": { post: { summary: "Search FDA drug labels (openFDA)", description: "Returns HTTP 402 until paid $0.03.", requestBody: { content: { "application/json": { schema: { type: "object", properties: { drug_name: { type: "string" }, limit: { type: "integer" } } } } } }, responses: { "200": { description: "Drug labels.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } } } },
      // ── Environmental & Climate (v0.11.0) ─────────────────────
      "/paid/env/wildfires": { post: { summary: "Active wildfire detections (NASA FIRMS)", description: "Returns HTTP 402 until paid $0.03.", requestBody: { content: { "application/json": { schema: { type: "object", properties: { limit: { type: "integer" }, region: { type: "string" } } } } } }, responses: { "200": { description: "Wildfire data.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } } } },
      "/paid/env/weather-alerts": { post: { summary: "NOAA NWS severe weather alerts", description: "Returns HTTP 402 until paid $0.02.", requestBody: { content: { "application/json": { schema: { type: "object", properties: { state: { type: "string" }, zone: { type: "string" } } } } } }, responses: { "200": { description: "Weather alerts.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } } } },
      "/paid/env/tides": { post: { summary: "NOAA tide predictions", description: "Returns HTTP 402 until paid $0.03.", requestBody: { content: { "application/json": { schema: { type: "object", properties: { station: { type: "string" }, date: { type: "string" } } } } } }, responses: { "200": { description: "Tide data.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } } } },
      "/paid/env/space-weather": { post: { summary: "NOAA space weather data", description: "Returns HTTP 402 until paid $0.02.", requestBody: { content: { "application/json": { schema: { type: "object", properties: { type: { type: "string" }, days: { type: "integer" } } } } } }, responses: { "200": { description: "Space weather.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } } } },
      "/paid/env/water-levels": { post: { summary: "USGS real-time water levels", description: "Returns HTTP 402 until paid $0.03.", requestBody: { content: { "application/json": { schema: { type: "object", properties: { state: { type: "string" }, parameter_code: { type: "string" } } } } } }, responses: { "200": { description: "Water level data.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } } } },
      // ── Government Spending & Contracts (v0.11.0) ─────────────
      "/paid/gov/federal-spending": { post: { summary: "Search federal spending (USAspending.gov)", description: "Returns HTTP 402 until paid $0.04.", requestBody: { content: { "application/json": { schema: { type: "object", properties: { agency: { type: "string" }, recipient: { type: "string" }, limit: { type: "integer" } } } } } }, responses: { "200": { description: "Spending data.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } } } },
      "/paid/gov/national-debt": { post: { summary: "US national debt to the penny (Treasury)", description: "Returns HTTP 402 until paid $0.02.", requestBody: { content: { "application/json": { schema: { type: "object" } } } }, responses: { "200": { description: "Debt data.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } } } },
      "/paid/gov/federal-grants": { post: { summary: "Search Grants.gov funding opportunities", description: "Returns HTTP 402 until paid $0.03.", requestBody: { content: { "application/json": { schema: { type: "object", properties: { query: { type: "string" }, status: { type: "string" }, limit: { type: "integer" } } } } } }, responses: { "200": { description: "Grants data.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } } } },
      "/paid/gov/nonprofits": { post: { summary: "Search nonprofit IRS 990 filings (ProPublica)", description: "Returns HTTP 402 until paid $0.03.", requestBody: { content: { "application/json": { schema: { type: "object", properties: { query: { type: "string" }, state: { type: "string" } } } } } }, responses: { "200": { description: "Nonprofit filings.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } } } },
      "/paid/gov/economic-indicators": { post: { summary: "GDP, CPI, unemployment data (World Bank)", description: "Returns HTTP 402 until paid $0.03.", requestBody: { content: { "application/json": { schema: { type: "object", properties: { country: { type: "string" }, indicator: { type: "string" } } } } } }, responses: { "200": { description: "Economic indicators.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } } } },
      "/paid/gov/lobbying": { post: { summary: "Search FEC lobbying disclosure records", description: "Returns HTTP 402 until paid $0.04.", requestBody: { content: { "application/json": { schema: { type: "object", properties: { lobbyist: { type: "string" }, client: { type: "string" }, year: { type: "integer" } } } } } }, responses: { "200": { description: "Lobbying records.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "402": { description: "payment required" } } } },
      "/mcp": {
        post: {
          summary: "MCP entrypoint",
          description: "JSON-RPC MCP endpoint. Paid tools return x402 payment requirements when called without payment.",
          responses: { "200": { description: "MCP JSON-RPC response.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } } },
        },
      },
      "/admin/warm": {
        get: {
          summary: "Manually trigger KV cache pre-warm (requires WARM_KEY or dev mode)",
          description: "Runs runAllFeedWarms to pre-populate all OSINT feeds into KV. Protected by ?key= or x-warm-key header matching WARM_KEY env var.",
          parameters: [
            { name: "key", in: "query", required: false, schema: { type: "string" }, description: "WARM_KEY value" },
          ],
          responses: { "200": { description: "Warm result with counts.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "403": { description: "Forbidden — key mismatch." } },
        },
      },
      "/admin/cache-status": {
        get: {
          summary: "List cached KV keys (requires WARM_KEY or dev mode)",
          description: "Returns KV namespace key listing for cache inspection. Protected by ?key= or x-warm-key header matching WARM_KEY.",
          parameters: [
            { name: "key", in: "query", required: false, schema: { type: "string" }, description: "WARM_KEY value" },
          ],
          responses: { "200": { description: "Cache key list.", "content": { "application/json": { "schema": { "type": "object", "properties": { "success": { "type": "boolean" }, "data": { "oneOf": [ { "type": "array" }, { "type": "object" } ] }, "cached": { "type": "boolean" }, "meta": { "type": "object", "properties": { "count": { "type": "integer" }, "source": { "type": "string" }, "generated_at": { "type": "string", "format": "date-time" } } } } } } } }, "403": { description: "Forbidden — key mismatch." } },
        },
      },
    },
    "x-tollbooth-payments": info.payments,
    "x-tollbooth-tools": TOOLS.map((tool) => ({
      name: tool.name,
      price_usd: tool.price_usd,
      description: tool.description,
      input: tool.input,
      example: tool.example,
    })),
  };
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    console.log(`[cron] scheduled trigger at ${new Date().toISOString()} cron=${event.cron}`);
    ctx.waitUntil(runAllFeedWarms(env as any).then(r => console.log("[cron] result", JSON.stringify(r))).catch((e: any) => console.error("[cron] failed", e)));
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/paid/")) {
      return paidHttp.fetch(request, env, ctx);
    }

    if (url.pathname === "/" || url.pathname === "") {
      return htmlResponse(landingPage());
    }

    if (url.pathname === "/api/info") {
      return jsonResponse(serviceInfo());
    }

    if (url.pathname === "/api/system/info") {
      return jsonResponse(systemInfo());
    }

    if (url.pathname === "/api/quote") {
      return quoteTool(url);
    }

    if (url.pathname === "/api/x402/bazaar/search") {
      return proxyBazaarSearch(request);
    }

    if (url.pathname === "/blog" || url.pathname === "/blog/") {
      return Response.redirect("https://agenttoll.dev/blog/x402-protocol-explained", 302);
    }

    if (url.pathname === "/docs") {
      return htmlResponse(docsPage());
    }

    if (url.pathname === "/discovery") {
      return htmlResponse(discoveryPage());
    }

    if (url.pathname === "/openapi.json" || url.pathname === "/api/openapi.json") {
      return jsonResponse(openApiSpec());
    }

    if (url.pathname === "/llms-full.txt") {
      return textResponse(llmsFullText());
    }

    if (url.pathname === "/tools" || url.pathname === "/tools/") {
      return htmlResponse(toolsDirectoryPage());
    }

    if (url.pathname.startsWith("/tools/")) {
      const toolName = url.pathname.split("/").filter(Boolean)[1];
      return htmlResponse(toolDetailPage(toolName ?? ""));
    }

    if (url.pathname === "/agent-manifest") {
      return Response.redirect(new URL("/.well-known/agent.json", url.origin).toString(), 301);
    }

    if (url.pathname === "/.well-known/ai" || url.pathname === "/ai") {
      return Response.redirect(new URL("/llms.txt", url.origin).toString(), 302);
    }


    if (url.pathname === "/.well-known/x402" || url.pathname === "/.well-known/x402/") {
      return jsonResponse(x402WellKnownPlain());
    }

    if (url.pathname === "/.well-known/x402.json") {
      return jsonResponse(x402WellKnownJson());
    }

    if (url.pathname === "/.well-known/mcp.json") {
      return jsonResponse(mcpManifest());
    }

    if (url.pathname === "/.well-known/agent.json" || url.pathname === "/agent.json") {
      return jsonResponse(agentJson());
    }

    if (url.pathname.startsWith("/receipt/")) {
      const tx = url.pathname.split("/").filter(Boolean)[1];
      try {
        return await receiptResponse(tx ?? "");
      } catch (error) {
        return jsonResponse({ error: "receipt_lookup_failed", message: error instanceof Error ? error.message : String(error) }, 502);
      }
    }

    if (url.pathname === "/mcp") {
      return TollboothMCP.serve("/mcp", {
        binding: "TOLLBOOTH_MCP",
      }).fetch(request, env, ctx);
    }

    // ── Admin endpoints ────────────────────────────────────────────────
    if (url.pathname === "/admin/warm") {
      const warmKey = (env as any)?.WARM_KEY as string | undefined;
      const providedKey = url.searchParams.get("key") ?? request.headers.get("x-warm-key");
      const isDev = (env as any)?.NODE_ENV === "development" || !(env as any)?.WARM_KEY && process.env.NODE_ENV !== "production";
      if (warmKey) {
        if (providedKey !== warmKey) return jsonResponse({ error: "forbidden" }, 403);
      } else if (!isDev) {
        return jsonResponse({ error: "forbidden", message: "WARM_KEY not set and not in dev" }, 403);
      }
      try {
        const result = await runAllFeedWarms(env as any);
        return jsonResponse({ ok: true, ...result, timestamp: new Date().toISOString() });
      } catch (error) {
        return jsonResponse({ error: "warm_failed", message: error instanceof Error ? error.message : String(error) }, 500);
      }
    }

    if (url.pathname === "/admin/cache-status") {
      const warmKey = (env as any)?.WARM_KEY as string | undefined;
      const providedKey = url.searchParams.get("key") ?? request.headers.get("x-warm-key");
      const isDev = (env as any)?.NODE_ENV === "development" || !(env as any)?.WARM_KEY && process.env.NODE_ENV !== "production";
      if (warmKey) {
        if (providedKey !== warmKey) return jsonResponse({ error: "forbidden" }, 403);
      } else if (!isDev) {
        return jsonResponse({ error: "forbidden", message: "WARM_KEY not set and not in dev" }, 403);
      }
      try {
        const keys = await kvListKeys(env as any);
        return jsonResponse({ ok: true, key_count: keys.length, keys: keys.map(k => ({ name: k.name.replace(_PREFIX, ""), expiration: k.expiration })), timestamp: new Date().toISOString() });
      } catch (error) {
        return jsonResponse({ error: "cache_status_failed", message: error instanceof Error ? error.message : String(error) }, 500);
      }
    }



    return new Response("Not found", { status: 404 });
  },
};
