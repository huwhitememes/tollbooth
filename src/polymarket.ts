const GAMMA_ORIGIN = "https://gamma-api.polymarket.com";
const TAKER_FEE_RATE = 0.02;
const ESTIMATED_ORDER_COST_USD = 0.02;

export type MarketScanOptions = {
  limit?: number;
  minCertainty?: number;
  minLiquidity?: number;
  minVolume24h?: number;
  minEdge?: number;
};

export type EventScanOptions = {
  slug: string;
  minEdge?: number;
  minLiquidity?: number;
};

type GammaMarket = Record<string, unknown>;
type GammaEvent = Record<string, unknown> & { markets?: GammaMarket[] };

const finite = (value: unknown, fallback = 0) => {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
};

const rounded = (value: number, digits = 4) => Number(value.toFixed(digits));

export function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function marketPrices(market: GammaMarket) {
  const prices = parseJsonArray(market.outcomePrices).map((value) => finite(value, Number.NaN));
  if (prices.length < 2 || prices.some((value) => !Number.isFinite(value))) return null;
  return { yes: prices[0] as number, no: prices[1] as number };
}

export function analyzeMarkets(markets: GammaMarket[], options: MarketScanOptions = {}) {
  const minCertainty = options.minCertainty ?? 0.95;
  const minLiquidity = options.minLiquidity ?? 1000;
  const minVolume24h = options.minVolume24h ?? 5000;
  const minEdge = options.minEdge ?? 0.02;
  const resolutionCandidates: Array<Record<string, unknown>> = [];
  const bundleViolations: Array<Record<string, unknown>> = [];

  for (const market of markets) {
    const prices = marketPrices(market);
    if (!prices) continue;
    const liquidity = finite(market.liquidityNum ?? market.liquidity);
    const volume24h = finite(market.volume24hr ?? market.volume24hrClob);
    if (liquidity < minLiquidity || volume24h < minVolume24h) continue;

    const slug = String(market.slug ?? "");
    const base = {
      question: String(market.question ?? "").slice(0, 180),
      slug,
      url: `https://polymarket.com/market/${slug}`,
      yes_price: rounded(prices.yes),
      no_price: rounded(prices.no),
      liquidity_usd: rounded(liquidity, 2),
      volume_24h_usd: rounded(volume24h, 2),
    };

    const certainty = Math.max(prices.yes, prices.no);
    if (certainty >= minCertainty) {
      const side = prices.yes >= prices.no ? "YES" : "NO";
      resolutionCandidates.push({
        ...base,
        type: "RESOLUTION_CANDIDATE",
        side,
        entry_price: rounded(certainty),
        gross_spread_to_payout: rounded(1 - certainty),
      });
    }

    const totalCost = prices.yes + prices.no;
    const estimatedCosts = totalCost * TAKER_FEE_RATE + ESTIMATED_ORDER_COST_USD * 2;
    const netEdge = 1 - totalCost - estimatedCosts;
    if (netEdge > minEdge) {
      bundleViolations.push({
        ...base,
        type: "BUNDLE_LONG",
        total_cost: rounded(totalCost),
        estimated_costs: rounded(estimatedCosts),
        net_edge: rounded(netEdge),
        net_edge_pct: rounded(netEdge * 100, 2),
      });
    }
  }

  resolutionCandidates.sort((a, b) => finite(b.gross_spread_to_payout) - finite(a.gross_spread_to_payout));
  bundleViolations.sort((a, b) => finite(b.net_edge) - finite(a.net_edge));
  return {
    markets_scanned: markets.length,
    resolution_candidates: resolutionCandidates.slice(0, 25),
    bundle_violations: bundleViolations.slice(0, 25),
  };
}

export function analyzeEvent(event: GammaEvent, options: Omit<EventScanOptions, "slug"> = {}) {
  const minEdge = options.minEdge ?? 0.02;
  const minLiquidity = options.minLiquidity ?? 1000;
  const eventSlug = String(event.slug ?? "");
  const legs: Array<Record<string, unknown>> = [];

  for (const market of event.markets ?? []) {
    const prices = marketPrices(market);
    const liquidity = finite(market.liquidityNum ?? market.liquidity);
    if (!prices || liquidity < minLiquidity) continue;
    const tokenIds = parseJsonArray(market.clobTokenIds);
    const yesAsk = finite(market.bestAsk, prices.yes);
    legs.push({
      question: String(market.question ?? "").slice(0, 160),
      yes_ask: rounded(yesAsk),
      liquidity_usd: rounded(liquidity, 2),
      yes_token_id: String(tokenIds[0] ?? ""),
    });
  }

  const totalCost = legs.reduce((sum, leg) => sum + finite(leg.yes_ask), 0);
  const estimatedCosts = totalCost * TAKER_FEE_RATE + ESTIMATED_ORDER_COST_USD * legs.length;
  const underpricedEdge = 1 - totalCost - estimatedCosts;
  const overpricedEdge = totalCost - 1 - estimatedCosts;
  let violation: Record<string, unknown> | null = null;

  if (legs.length >= 2 && underpricedEdge > minEdge) {
    violation = {
      type: "NEGRISK_UNDERPRICED",
      total_cost: rounded(totalCost),
      estimated_costs: rounded(estimatedCosts),
      net_edge: rounded(underpricedEdge),
      net_edge_pct: rounded(underpricedEdge * 100, 2),
      num_legs: legs.length,
      legs,
    };
  } else if (legs.length >= 2 && overpricedEdge > minEdge) {
    violation = {
      type: "NEGRISK_OVERPRICED",
      total_cost: rounded(totalCost),
      estimated_costs: rounded(estimatedCosts),
      net_edge: rounded(overpricedEdge),
      net_edge_pct: rounded(overpricedEdge * 100, 2),
      num_legs: legs.length,
      legs,
    };
  }

  return {
    event_title: String(event.title ?? ""),
    event_slug: eventSlug,
    event_url: `https://polymarket.com/event/${eventSlug}`,
    neg_risk: Boolean(event.negRisk),
    event_volume_usd: rounded(finite(event.volume), 2),
    eligible_legs: legs.length,
    violation,
  };
}

async function gammaJson<T>(path: string, fetcher: typeof fetch): Promise<T> {
  const response = await fetcher(`${GAMMA_ORIGIN}${path}`, {
    headers: { Accept: "application/json", "User-Agent": "TollboothMarketIntel/1.0" },
  });
  if (!response.ok) throw new Error(`Polymarket Gamma API returned HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export async function scanPolymarketMarkets(options: MarketScanOptions = {}, fetcher: typeof fetch = fetch) {
  const limit = Math.min(200, Math.max(10, Math.trunc(options.limit ?? 100)));
  const params = new URLSearchParams({
    active: "true",
    closed: "false",
    limit: String(limit),
    order: "volume24hr",
    ascending: "false",
  });
  const markets = await gammaJson<GammaMarket[]>(`/markets?${params}`, fetcher);
  return {
    source: "Polymarket Gamma API",
    generated_at: new Date().toISOString(),
    methodology: "Top active markets by 24h volume; fee- and estimated-order-cost-adjusted screens. Not financial advice; verify order books and resolution rules before acting.",
    config: {
      limit,
      min_certainty: options.minCertainty ?? 0.95,
      min_liquidity_usd: options.minLiquidity ?? 1000,
      min_volume_24h_usd: options.minVolume24h ?? 5000,
      min_edge: options.minEdge ?? 0.02,
    },
    ...analyzeMarkets(markets, options),
  };
}

export async function scanPolymarketEvent(options: EventScanOptions, fetcher: typeof fetch = fetch) {
  const slug = options.slug.trim();
  if (!/^[a-z0-9][a-z0-9-]{1,199}$/i.test(slug)) throw new Error("Invalid Polymarket event slug");
  const params = new URLSearchParams({ slug, limit: "1" });
  const events = await gammaJson<GammaEvent[]>(`/events?${params}`, fetcher);
  if (!events[0]) throw new Error("Polymarket event not found");
  return {
    source: "Polymarket Gamma API",
    generated_at: new Date().toISOString(),
    methodology: "negRisk outcome-sum screen using current Gamma best asks when available, with fee and estimated order-cost deductions. Verify live CLOB depth and event rules before acting.",
    config: {
      min_edge: options.minEdge ?? 0.02,
      min_liquidity_usd: options.minLiquidity ?? 1000,
    },
    event: analyzeEvent(events[0], options),
  };
}
