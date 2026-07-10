/**
 * Advanced Polymarket Intelligence — Tollbooth x402 MCP
 *
 * Derived analytics from vendor-extraction research:
 * - Combinatorial arbitrage (negRisk dependency graph pricing violations)
 * - Orderbook imbalance (OBI) from CLOB top-of-book
 * - Smart money tracking (leaderboard API → top trader activity)
 *
 * All functions return { success, data, cached, meta: { count, source, generated_at } }
 * and handle errors gracefully.
 */

// ─── Constants ───────────────────────────────────────────────────────────

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";

const USER_AGENT = "TollboothBot/1.0 PolyAdvanced/0.9";

// ─── Helpers ─────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function nowISO(): string {
  return new Date().toISOString();
}

async function fetchJson(
  url: string,
  opts: RequestInit & { timeoutMs?: number } = {}
): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10000);
  try {
    const r = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        ...(opts.headers || {}),
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function ok(data: any, source: string, count?: number) {
  return {
    success: true as const,
    data,
    cached: false,
    meta: {
      count: count ?? (Array.isArray(data?.results) ? data.results.length : 0),
      source,
      generated_at: nowISO(),
    },
  };
}

function fail(error: string, source: string) {
  return {
    success: false as const,
    data: null,
    cached: false,
    meta: {
      count: 0,
      source,
      generated_at: nowISO(),
    },
    error,
  };
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function finite(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ─── 1. scanCombinatorialArb — negRisk Dependency Graph Arbitrage ────────

export async function scanCombinatorialArb(limit?: number) {
  const source = "Polymarket Gamma API (negRisk combinatorial arb)";
  try {
    const lim = clamp(Math.trunc(limit ?? 20), 1, 100);

    // Fetch events with negRisk (multi-outcome combinatorial markets)
    const params = new URLSearchParams({
      limit: String(lim * 2),
      active: "true",
      closed: "false",
      order: "volume24hr",
      ascending: "false",
    });

    const events: any[] = await fetchJson(
      `${GAMMA_API}/events?${params.toString()}`,
      { timeoutMs: 12000 }
    );

    const violations: any[] = [];

    for (const event of events) {
      const markets: any[] = event?.markets ?? [];
      if (markets.length < 2) continue;

      const isNegRisk = event?.negRisk === true || event?.negRisk === "true";

      // Calculate total outcome prices for arbitrage detection
      // In negRisk: sum of YES prices should ≈ 1.0 for fair pricing
      // In standard: sum of YES prices should ≈ 1.0
      let totalYesPrice = 0;
      let totalNoPrice = 0;
      const marketPrices: any[] = [];

      for (const m of markets) {
        const prices = parseJsonArray(m.outcomePrices).map((v) => finite(v, NaN));
        if (prices.length < 2 || prices.some((p) => !Number.isFinite(prices))) continue;
        const yes = prices[0] as number;
        const no = prices[1] as number;
        totalYesPrice += yes;
        totalNoPrice += no;
        marketPrices.push({
          condition_id: m?.conditionId ?? m?.id ?? null,
          question: (m?.question ?? "").slice(0, 150),
          yes_price: Math.round(yes * 10000) / 10000,
          no_price: Math.round(no * 10000) / 10000,
          volume: finite(m.volume24hr ?? m.volume24hrClob),
          liquidity: finite(m.liquidityNum ?? m.liquidity),
        });
      }

      if (marketPrices.length < 2) continue;

      // Arbitrage: if total YES prices sum to less than 1.0, buying all YES outcomes
      // guarantees a profit (one must resolve YES). After 2% taker fee.
      const takerFee = 0.02;
      const yesArbEdge = 1.0 - totalYesPrice - (totalYesPrice * takerFee);
      const noArbEdge = totalNoPrice - 1.0 - (totalNoPrice * takerFee);

      if (yesArbEdge > 0.005 || noArbEdge > 0.005) {
        violations.push({
          event_slug: event?.slug ?? null,
          event_title: (event?.title ?? "").slice(0, 200),
          is_neg_risk: isNegRisk,
          market_count: marketPrices.length,
          total_yes_price: Math.round(totalYesPrice * 10000) / 10000,
          total_no_price: Math.round(totalNoPrice * 10000) / 10000,
          yes_arb_edge_pct: yesArbEdge > 0 ? Math.round(yesArbEdge * 10000) / 100 : 0,
          no_arb_edge_pct: noArbEdge > 0 ? Math.round(noArbEdge * 10000) / 100 : 0,
          strategy: yesArbEdge > 0.005
            ? "BUY_ALL_YES (sum of YES < 1.0 after fees)"
            : "SELL_ALL_NO (sum of NO > 1.0 after fees)",
          markets: marketPrices,
        });
      }

      if (violations.length >= lim) break;
    }

    return ok(
      {
        scanned_events: events.length,
        violations_found: violations.length,
        violations,
      },
      source,
      violations.length
    );
  } catch (e: any) {
    return fail(e?.message ?? String(e), source);
  }
}

// ─── 2. getOrderbookImbalance — CLOB Top-of-Book OBI ─────────────────────

export async function getOrderbookImbalance(
  token_id?: string,
  condition_id?: string,
  limit?: number
) {
  const source = "Polymarket CLOB API (orderbook imbalance)";
  try {
    const lim = clamp(Math.trunc(limit ?? 10), 1, 50);

    // If specific token_id provided, fetch that orderbook
    if (token_id?.trim()) {
      const book = await fetchJson(
        `${CLOB_API}/book?token_id=${encodeURIComponent(token_id.trim())}`,
        { timeoutMs: 10000 }
      );

      const bids: any[] = book?.bids ?? [];
      const asks: any[] = book?.asks ?? [];

      const bidVolume = bids.reduce((sum, b) => sum + finite(b?.size), 0);
      const askVolume = asks.reduce((sum, a) => sum + finite(a?.size), 0);
      const totalVolume = bidVolume + askVolume;
      const obi = totalVolume > 0 ? (bidVolume - askVolume) / totalVolume : 0;

      const topBids = bids.slice(0, 5).map((b) => ({
        price: finite(b?.price),
        size: finite(b?.size),
      }));
      const topAsks = asks.slice(0, 5).map((a) => ({
        price: finite(a?.price),
        size: finite(a?.size),
      }));

      const spread = topBids.length > 0 && topAsks.length > 0
        ? topAsks[0].price - topBids[0].price
        : null;

      return ok(
        {
          token_id: token_id.trim(),
          bid_volume: Math.round(bidVolume * 100) / 100,
          ask_volume: Math.round(askVolume * 100) / 100,
          obi: Math.round(obi * 10000) / 10000,
          obi_signal: obi > 0.2 ? "BULLISH (bid-heavy)" : obi < -0.2 ? "BEARISH (ask-heavy)" : "BALANCED",
          spread: spread !== null ? Math.round(spread * 10000) / 10000 : null,
          mid_price: topBids.length > 0 && topAsks.length > 0
            ? Math.round(((topBids[0].price + topAsks[0].price) / 2) * 10000) / 10000
            : null,
          top_bids: topBids,
          top_asks: topAsks,
          depth_levels: { bids: bids.length, asks: asks.length },
        },
        source,
        1
      );
    }

    // Otherwise scan top markets by volume for OBI
    if (!condition_id) {
      // Get top active markets from Gamma
      const marketsData = await fetchJson(
        `${GAMMA_API}/markets?limit=${lim}&active=true&closed=false&order=volume24hr&ascending=false`,
        { timeoutMs: 12000 }
      );

      const markets: any[] = Array.isArray(marketsData) ? marketsData : marketsData?.data ?? [];

      const results: any[] = [];
      for (const m of markets.slice(0, lim)) {
        const clobTokenIds = parseJsonArray(m?.clobTokenIds);
        if (clobTokenIds.length < 1) continue;

        const tokenId = String(clobTokenIds[0]);
        try {
          const book = await fetchJson(
            `${CLOB_API}/book?token_id=${encodeURIComponent(tokenId)}`,
            { timeoutMs: 8000 }
          );

          const bids: any[] = book?.bids ?? [];
          const asks: any[] = book?.asks ?? [];
          const bidVol = bids.reduce((sum, b) => sum + finite(b?.size), 0);
          const askVol = asks.reduce((sum, a) => sum + finite(a?.size), 0);
          const total = bidVol + askVol;
          const obi = total > 0 ? (bidVol - askVol) / total : 0;

          results.push({
            condition_id: m?.conditionId ?? null,
            question: (m?.question ?? "").slice(0, 150),
            token_id: tokenId,
            bid_volume: Math.round(bidVol * 100) / 100,
            ask_volume: Math.round(askVol * 100) / 100,
            obi: Math.round(obi * 10000) / 10000,
            obi_signal: obi > 0.2 ? "BULLISH" : obi < -0.2 ? "BEARISH" : "BALANCED",
            spread: bids.length > 0 && asks.length > 0
              ? Math.round((finite(asks[0]?.price) - finite(bids[0]?.price)) * 10000) / 10000
              : null,
          });
        } catch {
          // Skip individual market failures
        }
      }

      return ok(
        {
          markets_scanned: results.length,
          results: results.sort((a, b) => Math.abs(b.obi) - Math.abs(a.obi)),
        },
        source,
        results.length
      );
    }

    return fail("Either token_id or limit is required", source);
  } catch (e: any) {
    return fail(e?.message ?? String(e), source);
  }
}

// ─── 3. getSmartMoney — Polymarket Leaderboard & Top Trader Activity ─────

export async function getSmartMoney(limit?: number, timeframe?: string) {
  const source = "Polymarket Data API (leaderboard + positions)";
  try {
    const lim = clamp(Math.trunc(limit ?? 20), 1, 100);
    const tf = timeframe === "1d" || timeframe === "7d" || timeframe === "30d" || timeframe === "all"
      ? timeframe
      : "30d";

    // Fetch leaderboard
    const lbData = await fetchJson(
      `${DATA_API}/leaderboard?period=${tf}&limit=${lim}`,
      { timeoutMs: 12000 }
    );

    const leaders: any[] = lbData?.leaderboard ?? lbData?.data ?? lbData ?? [];
    const leaderArray = Array.isArray(leaders) ? leaders : [];

    const results = leaderArray.slice(0, lim).map((trader: any) => ({
      rank: trader?.rank ?? trader?.position ?? null,
      trader_address: trader?.user ?? trader?.address ?? trader?.proxyWallet ?? null,
      profit: finite(trader?.profit ?? trader?.pnl),
      roi_pct: finite(trader?.roi ?? trader?.returnOnInvestment) * 100,
      volume: finite(trader?.volume ?? trader?.totalVolume),
      positions: finite(trader?.positions ?? trader?.marketsTraded),
      markets_traded: finite(trader?.marketsTraded ?? trader?.positions),
      pnl_rank: trader?.rank ?? null,
    }));

    // Try to fetch recent positions for top 3 traders
    const topTraders = results.slice(0, 3).filter((t) => t.trader_address);
    const positionsByTrader: any[] = [];

    for (const trader of topTraders) {
      try {
        const posData = await fetchJson(
          `${DATA_API}/positions?user=${encodeURIComponent(trader.trader_address)}&limit=5&sizeThreshold=100`,
          { timeoutMs: 8000 }
        );

        const positions: any[] = posData?.positions ?? posData ?? [];
        const posArray = Array.isArray(positions) ? positions : [];

        for (const pos of posArray.slice(0, 5)) {
          positionsByTrader.push({
            trader: trader.trader_address,
            trader_rank: trader.rank,
            market: (pos?.title ?? pos?.market?.question ?? "").slice(0, 150),
            outcome: pos?.outcome ?? pos?.side ?? null,
            size: finite(pos?.size ?? pos?.shares),
            avg_price: finite(pos?.avgPrice ?? pos?.initialValue) / Math.max(1, finite(pos?.size ?? pos?.shares)),
            current_value: finite(pos?.currentValue ?? pos?.value),
            pnl: finite(pos?.pnl ?? pos?.cashPnl),
            market_slug: pos?.market?.slug ?? pos?.slug ?? null,
          });
        }
      } catch {
        // Skip individual trader lookups
      }
    }

    return ok(
      {
        timeframe: tf,
        leaderboard: results,
        top_trader_positions: positionsByTrader,
        total_leaders: results.length,
      },
      source,
      results.length
    );
  } catch (e: any) {
    return fail(e?.message ?? String(e), source);
  }
}
