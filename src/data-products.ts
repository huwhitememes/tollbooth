/**
 * Advanced Prediction-Market Data Products
 *
 * Four new x402 endpoints built on existing Polymarket/Kalshi API access:
 * 1. Odds feed — normalized live odds across both platforms
 * 2. Volume analytics — top markets by volume, liquidity, price movement
 * 3. Resolution history — recently resolved markets with outcomes
 * 4. Kalshi live markets — active Kalshi market list
 */

const GAMMA = "https://gamma-api.polymarket.com";
const KALSHI = "https://external-api.kalshi.com/trade-api/v2";

function finite(val: unknown, fallback = 0): number {
  const n = typeof val === "string" ? parseFloat(val) : typeof val === "number" ? val : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function parseArr(val: unknown): unknown[] {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try { const p = JSON.parse(val); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

// ─── 1. Odds Feed ─────────────────────────────────────────────────────────────

export async function oddsFeed(opts: {
  limit?: number;
  platform?: "polymarket" | "kalshi" | "both";
} = {}): Promise<{
  source: string[];
  timestamp: string;
  markets: Array<{
    platform: string;
    question: string;
    yes_price: number;
    no_price: number;
    spread: number;
    volume_24h: number;
    liquidity: number;
    url: string;
  }>;
}> {
  const limit = Math.min(opts.limit ?? 30, 100);
  const platform = opts.platform ?? "both";
  const markets: Array<Record<string, unknown>> = [];

  if (platform === "polymarket" || platform === "both") {
    const url = `${GAMMA}/markets?closed=false&archived=false&limit=${limit}&order=volume24hr&ascending=false`;
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    if (resp.ok) {
      const data = (await resp.json()) as Record<string, unknown>[];
      for (const m of data) {
        const prices = parseArr(m.outcomePrices);
        if (prices.length < 2) continue;
        const yes = finite(prices[0]);
        const no = finite(prices[1]);
        if (!(yes > 0 && yes <= 1)) continue;
        markets.push({
          platform: "polymarket",
          question: String(m.question ?? "").slice(0, 150),
          yes_price: yes,
          no_price: no,
          spread: Math.abs(1 - (yes + no)),
          volume_24h: finite(m.volume24hr ?? m.volume24h),
          liquidity: finite(m.liquidity),
          url: `https://polymarket.com/market/${m.slug ?? ""}`,
        });
      }
    }
  }

  if (platform === "kalshi" || platform === "both") {
    const url = `${KALSHI}/markets?status=open&limit=${limit}`;
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    if (resp.ok) {
      const body = await resp.json() as Record<string, unknown>;
      const kalshiMarkets = (body.markets ?? []) as Record<string, unknown>[];
      for (const m of kalshiMarkets) {
        const yes = finite(m.yes_ask, -1);
        const no = finite(m.no_ask, -1);
        if (yes < 0 || no < 0) continue;
        markets.push({
          platform: "kalshi",
          question: String(m.title ?? "").slice(0, 150),
          yes_price: yes,
          no_price: no,
          spread: Math.abs(1 - (yes + no)),
          volume_24h: finite(m.volume ?? m.volume_24h),
          liquidity: finite(m.liquidity),
          url: `https://kalshi.com/markets/${m.ticker ?? ""}`,
        });
      }
    }
  }

  markets.sort((a, b) => finite(b.volume_24h) - finite(a.volume_24h));

  return {
    source: platform === "both" ? ["Polymarket Gamma API", "Kalshi Trade API"] : [platform === "polymarket" ? "Polymarket Gamma API" : "Kalshi Trade API"],
    timestamp: new Date().toISOString(),
    markets: markets.slice(0, limit).map((m) => ({
      platform: String(m.platform),
      question: String(m.question),
      yes_price: finite(m.yes_price),
      no_price: finite(m.no_price),
      spread: finite(m.spread),
      volume_24h: finite(m.volume_24h),
      liquidity: finite(m.liquidity),
      url: String(m.url),
    })),
  };
}

// ─── 2. Volume Analytics ─────────────────────────────────────────────────────

export async function volumeAnalytics(opts: {
  limit?: number;
  min_volume?: number;
} = {}): Promise<{
  source: string;
  timestamp: string;
  markets: Array<{
    question: string;
    slug: string;
    volume_24h: number;
    volume_total: number;
    liquidity: number;
    yes_price: number;
    price_change_24h: number;
    url: string;
  }>;
}> {
  const limit = Math.min(opts.limit ?? 30, 100);
  const minVol = opts.min_volume ?? 1000;
  const url = `${GAMMA}/markets?closed=false&archived=false&limit=${limit}&order=volume24hr&ascending=false`;

  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error(`Gamma API returned ${resp.status}`);

  const data = (await resp.json()) as Record<string, unknown>[];
  const markets = data
    .filter((m) => finite(m.volume24hr ?? m.volume24h) >= minVol)
    .map((m) => {
      const prices = parseArr(m.outcomePrices);
      const yes = finite(prices[0]);
      const oneDayAgo = finite(m.oneDayPriceChange);
      return {
        question: String(m.question ?? "").slice(0, 150),
        slug: String(m.slug ?? ""),
        volume_24h: finite(m.volume24hr ?? m.volume24h),
        volume_total: finite(m.volumeNum ?? m.volume),
        liquidity: finite(m.liquidity),
        yes_price: yes,
        price_change_24h: oneDayAgo,
        url: `https://polymarket.com/market/${m.slug ?? ""}`,
      };
    })
    .sort((a, b) => b.volume_24h - a.volume_24h);

  return { source: "Polymarket Gamma API", timestamp: new Date().toISOString(), markets: markets.slice(0, limit) };
}

// ─── 3. Resolution History ───────────────────────────────────────────────────

export async function resolutionHistory(opts: {
  limit?: number;
  days_back?: number;
} = {}): Promise<{
  source: string;
  timestamp: string;
  markets: Array<{
    question: string;
    slug: string;
    resolution: string;
    resolved_at: string;
    volume: number;
    yes_price: number;
    url: string;
  }>;
}> {
  const limit = Math.min(opts.limit ?? 30, 100);
  const daysBack = opts.days_back ?? 7;
  const url = `${GAMMA}/markets?closed=true&archived=false&limit=${limit}&order=endDate&ascending=false`;

  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error(`Gamma API returned ${resp.status}`);

  const data = (await resp.json()) as Record<string, unknown>[];
  const cutoff = Date.now() - daysBack * 86400000;
  const markets = data
    .filter((m) => {
      const endDate = m.endDate ? new Date(String(m.endDate)).getTime() : 0;
      return endDate >= cutoff;
    })
    .map((m) => {
      const prices = parseArr(m.outcomePrices);
      return {
        question: String(m.question ?? "").slice(0, 150),
        slug: String(m.slug ?? ""),
        resolution: String(m.resolutionSource ?? "polymarket"),
        resolved_at: String(m.endDate ?? ""),
        volume: finite(m.volumeNum ?? m.volume),
        yes_price: finite(prices[0]),
        url: `https://polymarket.com/market/${m.slug ?? ""}`,
      };
    });

  return { source: "Polymarket Gamma API", timestamp: new Date().toISOString(), markets: markets.slice(0, limit) };
}

// ─── 4. Kalshi Live Markets ──────────────────────────────────────────────────

export async function kalshiMarkets(opts: {
  limit?: number;
  category?: string;
} = {}): Promise<{
  source: string;
  timestamp: string;
  markets: Array<{
    ticker: string;
    title: string;
    yes_ask: number;
    no_ask: number;
    yes_bid: number;
    no_bid: number;
    volume: number;
    open_interest: number;
    close_date: string;
    url: string;
  }>;
}> {
  const limit = Math.min(opts.limit ?? 30, 100);
  let url = `${KALSHI}/markets?status=open&mve_filter=exclude&limit=${limit}`;
  if (opts.category) url += `&event_ticker=${encodeURIComponent(opts.category)}`;

  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) throw new Error(`Kalshi API returned ${resp.status}`);

  const body = await resp.json() as Record<string, unknown>;
  const raw = (body.markets ?? []) as Record<string, unknown>[];
  const markets = raw.map((m) => ({
    ticker: String(m.ticker ?? ""),
    title: String(m.title ?? "").slice(0, 150),
    yes_ask: finite(m.yes_ask),
    no_ask: finite(m.no_ask),
    yes_bid: finite(m.yes_bid),
    no_bid: finite(m.no_bid),
    volume: finite(m.volume ?? m.volume_24h),
    open_interest: finite(m.open_interest),
    close_date: String(m.close_time ?? m.expiration_time ?? ""),
    url: `https://kalshi.com/markets/${m.ticker ?? ""}`,
  }));

  return { source: "Kalshi Trade API", timestamp: new Date().toISOString(), markets: markets.slice(0, limit) };
}
