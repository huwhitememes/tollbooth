/**
 * Rebalance Arbitrage Module — Detects YES+NO pricing violations on Polymarket
 *
 * Extracted from CloddsBot/src/opportunity/combinatorial.ts patterns:
 * - Market rebalancing arbitrage (YES + NO != $1)
 * - Confidence scoring based on deviation, liquidity, and volume
 * - Fee-adjusted net profit calculation
 *
 * Data source: Polymarket Gamma API (public, no auth required)
 */

const GAMMA_ORIGIN = "https://gamma-api.polymarket.com";

interface RebalanceOpportunity {
  type: "BUNDLE_LONG" | "BUNDLE_SHORT";
  question: string;
  slug: string;
  yesPrice: number;
  noPrice: number;
  totalCost: number;
  deviation: number;
  guaranteedPayout: number;
  netProfit: number;
  edgePct: number;
  confidence: number;
  liquidity: number;
  volume24h: number;
  url: string;
}

function finite(val: unknown, fallback = Number.NaN): number {
  const n = typeof val === "string" ? parseFloat(val) : typeof val === "number" ? val : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

function parseJsonArray(val: unknown): unknown[] {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try {
      const p = JSON.parse(val);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Scan Polymarket for single-market rebalance arbitrage opportunities.
 * When YES + NO != $1.00 on the same market, guaranteed profit exists.
 */
export async function scanRebalanceOpportunities(opts: {
  limit?: number;
  minEdge?: number;
  minLiquidity?: number;
} = {}): Promise<{
  source: string;
  scanned: number;
  opportunities: RebalanceOpportunity[];
  timestamp: string;
}> {
  const limit = Math.min(opts.limit ?? 500, 2000);
  const minEdge = opts.minEdge ?? 0.005; // 0.5% minimum net edge
  const minLiquidity = opts.minLiquidity ?? 1000;
  const feeRate = 0.02; // Polymarket 2% taker fee
  const gasCost = 0.02; // ~$0.02 per order on Polygon

  const url = `${GAMMA_ORIGIN}/markets?closed=false&archived=false&limit=${limit}&order=volume24hr&ascending=false&offset=0`;

  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) {
    throw new Error(`Gamma API returned ${resp.status}`);
  }
  const markets = (await resp.json()) as Record<string, unknown>[];

  const opportunities: RebalanceOpportunity[] = [];
  let scanned = 0;

  for (const m of markets) {
    const prices = parseJsonArray(m.outcomePrices);
    if (prices.length < 2) continue;

    const yesPrice = finite(prices[0]);
    const noPrice = finite(prices[1]);
    const liquidity = finite(m.liquidity, 0);
    const volume24h = finite(m.volume24hr ?? m.volume24h, 0);

    if (liquidity < minLiquidity) continue;
    if (!(yesPrice > 0 && yesPrice <= 1 && noPrice > 0 && noPrice <= 1)) continue;

    scanned++;

    const total = yesPrice + noPrice;
    const deviation = Math.abs(1 - total);
    if (deviation < 0.001) continue;

    const feeCost = feeRate * total;
    const gasTotal = gasCost * 2;

    // Confidence scoring (CloddsBot pattern)
    let confidence = 0.5;
    if (deviation > 0.05) confidence += 0.2;
    else if (deviation > 0.02) confidence += 0.1;
    if (liquidity > 10000) confidence += 0.15;
    else if (liquidity > 5000) confidence += 0.1;
    if (volume24h > 10000) confidence += 0.15;
    confidence = Math.min(confidence, 1);

    const slug = String(m.slug ?? "");
    const question = String(m.question ?? "").slice(0, 120);

    // Bundle long: buy both sides for < $1
    if (total < 1) {
      const netProfit = 1 - total - feeCost - gasTotal;
      if (netProfit > minEdge) {
        opportunities.push({
          type: "BUNDLE_LONG",
          question,
          slug,
          yesPrice,
          noPrice,
          totalCost: total,
          deviation,
          guaranteedPayout: 1,
          netProfit,
          edgePct: (netProfit / total) * 100,
          confidence,
          liquidity,
          volume24h,
          url: `https://polymarket.com/market/${slug}`,
        });
      }
    }
    // Bundle short: sell both when sum > $1
    else if (total > 1) {
      const netProfit = total - 1 - feeCost - gasTotal;
      if (netProfit > minEdge) {
        opportunities.push({
          type: "BUNDLE_SHORT",
          question,
          slug,
          yesPrice,
          noPrice,
          totalCost: total,
          deviation,
          guaranteedPayout: 1,
          netProfit,
          edgePct: (netProfit / total) * 100,
          confidence,
          liquidity,
          volume24h,
          url: `https://polymarket.com/market/${slug}`,
        });
      }
    }
  }

  opportunities.sort((a, b) => b.netProfit - a.netProfit);

  return {
    source: "Polymarket Gamma API",
    scanned,
    opportunities: opportunities.slice(0, 50),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Scan Polymarket for the top trending markets by 24h volume.
 * Useful as a standalone data product — agents want to know what's hot.
 */
export async function scanTrendingMarkets(opts: {
  limit?: number;
  category?: string;
} = {}): Promise<{
  source: string;
  markets: Array<{
    question: string;
    slug: string;
    yesPrice: number;
    liquidity: number;
    volume24h: number;
    volumeNum: number;
    url: string;
  }>;
  timestamp: string;
}> {
  const limit = Math.min(opts.limit ?? 20, 100);
  let url = `${GAMMA_ORIGIN}/markets?closed=false&archived=false&limit=${limit}&order=volume24hr&ascending=false`;

  if (opts.category) {
    url += `&tag=${encodeURIComponent(opts.category)}`;
  }

  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) {
    throw new Error(`Gamma API returned ${resp.status}`);
  }
  const markets = (await resp.json()) as Record<string, unknown>[];

  const result = markets.map((m) => {
    const prices = parseJsonArray(m.outcomePrices);
    return {
      question: String(m.question ?? "").slice(0, 150),
      slug: String(m.slug ?? ""),
      yesPrice: finite(prices[0], 0),
      liquidity: finite(m.liquidity, 0),
      volume24h: finite(m.volume24hr ?? m.volume24h, 0),
      volumeNum: finite(m.volumeNum ?? m.volume, 0),
      url: `https://polymarket.com/market/${m.slug ?? ""}`,
    };
  });

  return {
    source: "Polymarket Gamma API",
    markets: result,
    timestamp: new Date().toISOString(),
  };
}
