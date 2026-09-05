/**
 * Financial & Corporate Intelligence Products — Tollbooth x402 MCP
 *
 * Free / keyless financial data sources:
 * - SEC EDGAR (full-text search, filings, insider Form 4) — keyless
 * - FRED (Federal Reserve Economic Data) — 800k+ series, keyless with backoff
 *
 * All functions return { success, data, cached, meta: { count, source, generated_at } }
 * and handle errors gracefully (return { success: false, error } on failure).
 */

// ─── Constants ───────────────────────────────────────────────────────────

const EDGAR_BASE = "https://efts.sec.gov/LATEST/search-index";
const EDGAR_FILINGS = "https://data.sec.gov/submissions";
const FRED_BASE = "https://api.stlouisfed.org/fred";

const USER_AGENT = "agenttoll.dev/1.0 FinanceIntel/0.9 research@memerhuwhite";

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

// ─── 1. searchEdgarFilings — SEC EDGAR Full-Text Search ──────────────────

export async function searchEdgarFilings(
  query: string,
  form_type?: string,
  ticker?: string,
  limit?: number
) {
  const source = "SEC EDGAR Full-Text Search (efts.sec.gov)";
  try {
    const q = (query ?? "").trim();
    if (!q) return fail("query is required", source);

    const lim = clamp(Math.trunc(limit ?? 20), 1, 100);

    // EDGAR full-text search endpoint
    const params = new URLSearchParams({
      q,
      dateRange: "custom",
      startdt: new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10),
      enddt: new Date().toISOString().slice(0, 10),
    });
    if (form_type) params.set("forms", form_type);
    if (ticker) params.set("ciks", ticker);

    const data = await fetchJson(
      `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(q)}&forms=${form_type ?? ""}`,
      { timeoutMs: 12000 }
    ).catch(() =>
      fetchJson(
        `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(q)}`,
        { timeoutMs: 12000 }
      ).catch(() =>
        // Fallback to the actual working endpoint
        fetchJson(
          `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(q)}&dateRange=custom&startdt=${new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10)}&enddt=${new Date().toISOString().slice(0, 10)}${form_type ? `&forms=${form_type}` : ""}`,
          { timeoutMs: 12000 }
        )
      )
    );

    const hits: any[] = data?.hits?.hits ?? [];
    const results: any[] = hits.slice(0, lim).map((h: any) => {
      const s = h?._source ?? {};
      return {
        accession_no: s?._id?.split(":")[0] ?? h?._id ?? null,
        form_type: s?.form_type ?? null,
        filed_date: s?.file_date ?? s?.period_ending ?? null,
        company_name: s?.display_names?.[0] ?? s?.entity_name ?? "",
        cik: s?.entity_id ?? s?._source?.cik ?? null,
        ticker: s?.tickers?.[0] ?? null,
        description: (s?.display_names?.[0] ?? "") + " — " + (s?.form_type ?? ""),
        snippet: (h?._source?.display_names?.[0] ?? "").slice(0, 200),
        url: s?._id
          ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${s?._source?.entity_id ?? ""}&type=${s?.form_type ?? ""}&dateb=&owner=include&count=10`
          : "",
        filing_url: s?._id
          ? `https://www.sec.gov/Archives/edgar/data/${s?._source?.entity_id?.replace(/^0+/, "") ?? ""}/${(s?._id ?? "").replace(/-/g, "")}/`
          : "",
      };
    });

    return ok(
      {
        query: q,
        form_type_filter: form_type ?? null,
        ticker_filter: ticker ?? null,
        total: data?.hits?.total?.value ?? results.length,
        results,
      },
      source,
      results.length
    );
  } catch (e: any) {
    return fail(e?.message ?? String(e), source);
  }
}

// ─── 2. getInsiderTrades — SEC EDGAR Form 4 (Insider Transactions) ───────

export async function getInsiderTrades(
  ticker?: string,
  limit?: number
) {
  const source = "SEC EDGAR Form 4 Insider Trades";
  try {
    const lim = clamp(Math.trunc(limit ?? 20), 1, 100);

    // Search for recent Form 4 filings
    const params = new URLSearchParams({
      q: ticker ? `ticker:${ticker}` : "*",
      forms: "4",
      dateRange: "custom",
      startdt: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
      enddt: new Date().toISOString().slice(0, 10),
    });

    const data = await fetchJson(
      `https://efts.sec.gov/LATEST/search-index?${params.toString()}`,
      { timeoutMs: 12000 }
    );

    const hits: any[] = data?.hits?.hits ?? [];
    const results: any[] = hits.slice(0, lim).map((h: any) => {
      const s = h?._source ?? {};
      return {
        form_type: "4",
        filed_date: s?.file_date ?? null,
        company_name: s?.display_names?.[0] ?? "",
        ticker: s?.tickers?.[0] ?? null,
        cik: s?.entity_id ?? null,
        accession_no: s?._id?.split(":")[0] ?? null,
        url: s?._id
          ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${s?.entity_id ?? ""}&type=4&dateb=&owner=include&count=10`
          : "",
      };
    });

    return ok(
      {
        ticker_filter: ticker ?? null,
        total: data?.hits?.total?.value ?? results.length,
        results,
      },
      source,
      results.length
    );
  } catch (e: any) {
    return fail(e?.message ?? String(e), source);
  }
}

// ─── 3. getFredSeries — FRED Economic Data ───────────────────────────────

const COMMON_FRED_SERIES: Record<string, string> = {
  gdp: "GDP",
  gdp_growth: "A191RL1Q225SBEA",
  inflation_cpi: "CPIAUCSL",
  inflation_core: "CPILFESL",
  unemployment: "UNRATE",
  fed_funds_rate: "FEDFUNDS",
  ten_year_treasury: "DGS10",
  two_year_treasury: "DGS2",
  mortgage_rate: "MORTGAGE30US",
  consumer_sentiment: "UMCSENT",
  retail_sales: "RSAFS",
  industrial_production: "INDPRO",
  housing_starts: "HOUST",
  jobless_claims: "ICSA",
  money_supply_m2: "WM2NS",
  vix: "VIXCLS",
};

export async function getFredSeries(
  series_id?: string,
  limit?: number
) {
  const source = "FRED (St. Louis Fed)";
  try {
    const id = (series_id ?? "GDP").trim();
    // Resolve friendly name → FRED series code
    const resolved = COMMON_FRED_SERIES[id.toLowerCase()] ?? id;

    // FRED API is keyless for basic queries via the public JSON endpoint
    // Try without API key first (works for recent observations)
    const params = new URLSearchParams({
      observation_start: new Date(Date.now() - 730 * 86400000).toISOString().slice(0, 10),
      observation_end: new Date().toISOString().slice(0, 10),
      file_type: "json",
    });

    const apiKey =
      (typeof process !== "undefined" &&
        (process as any).env?.FRED_API_KEY) ||
      null;

    if (apiKey) {
      params.set("api_key", apiKey);
    }

    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${resolved}&${params.toString()}`;

    const data = await fetchJson(url, { timeoutMs: 10000 });

    const rawObs: any[] = data?.observations ?? [];
    const observations = rawObs
      .filter((o: any) => o?.value && o.value !== ".")
      .slice(-clamp(Math.trunc(limit ?? 20), 1, 1000))
      .map((o: any) => ({
        date: o?.date ?? null,
        value: parseFloat(o?.value) ?? null,
      }));

    const latest = observations[observations.length - 1] ?? null;
    const prev = observations[observations.length - 2] ?? null;
    const change = latest && prev ? latest.value - prev.value : null;

    return ok(
      {
        series_id: resolved,
        series_name: id,
        latest_date: latest?.date ?? null,
        latest_value: latest?.value ?? null,
        previous_value: prev?.value ?? null,
        change,
        observation_count: observations.length,
        observations,
        source_with_key: !!apiKey,
      },
      source,
      observations.length
    );
  } catch (e: any) {
    return fail(e?.message ?? String(e), source);
  }
}

// ─── 4. getTokenStockQuote — Tokenized Equity Quotes (GeckoTerminal) ─────

const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
const DEXSCREENER_BASE = "https://api.dexscreener.com/latest/dex";

// GeckoTerminal public API rate-limits (~30 req/min); short in-isolate cache
// absorbs bursts so a cluster of paid calls does not trip upstream 429s.
const TOKEN_STOCK_CACHE_TTL_MS = 60_000;
const tokenStockCache = new Map<string, { t: number; v: any }>();

function cacheGet(key: string): any | null {
  const hit = tokenStockCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > TOKEN_STOCK_CACHE_TTL_MS) {
    tokenStockCache.delete(key);
    return null;
  }
  return hit.v;
}

function cachePut(key: string, v: any): void {
  if (tokenStockCache.size > 500) tokenStockCache.clear();
  tokenStockCache.set(key, { t: Date.now(), v });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// fetchJson with bounded retry + backoff for transient upstream 429/5xx/network
async function fetchJsonRetry(
  url: string,
  opts: RequestInit & { timeoutMs?: number } = {},
  attempts = 3
): Promise<any> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchJson(url, opts);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(600 * (i + 1));
    }
  }
  throw lastErr;
}

// Coinbase Tokenized Stocks (B20) tickers live on Base; suffix "c" per Coinbase
const TOKEN_STOCK_SYMBOLS: Record<string, string> = {
  NVDAc: "NVDA", METAc: "META", AAPLc: "AAPL", GOOGLc: "GOOGL", AMZN: "AMZN",
  COIN: "COIN", CRCL: "CRCL", INTC: "INTC", MSFT: "MSFT", MSTR: "MSTR",
  SNDK: "SNDK", SPCX: "SPCX", TSLA: "TSLA",
};

function normalizeTokenStockQuery(q: string): { symbol: string; ticker: string } {
  const raw = q.trim().toUpperCase();
  // Case-insensitive match against canonical token symbols (NVDAc, METAc, ...)
  const canon = Object.keys(TOKEN_STOCK_SYMBOLS).find(
    (k) => k.toUpperCase() === raw
  );
  if (canon) return { symbol: canon, ticker: TOKEN_STOCK_SYMBOLS[canon] };
  // Bare ticker (e.g. "nvda") -> canonical token symbol
  const bare = Object.entries(TOKEN_STOCK_SYMBOLS).find(([, t]) => t === raw);
  if (bare) return { symbol: bare[0], ticker: bare[1] };
  return { symbol: raw, ticker: raw };
}

export async function getTokenStockQuote(query: string, limit?: number) {
  const source = "GeckoTerminal public DEX data (tokenized equities on Base)";
  try {
    const q = (query ?? "").trim();
    if (!q) return fail("query is required (token symbol like NVDAc, or ticker like NVDA)", source);
    const lim = clamp(Math.trunc(limit ?? 3), 1, 10);
    const { symbol, ticker } = normalizeTokenStockQuery(q);
    const cacheKey = `${symbol}|${lim}`;
    const cached = cacheGet(cacheKey);
    if (cached) return { ...cached, cached: true };

    const search = await fetchJsonRetry(`${GECKO_BASE}/search/pools?query=${encodeURIComponent(symbol)}&page=1`, { timeoutMs: 12000 });
    const symUpper = symbol.toUpperCase();
    // Search results may omit the network relationship; accept unattributed pools and
    // confirm each on Base via the detail endpoint (mismatched ones return no detail).
    const pools: any[] = (search?.data ?? []).filter((p: any) => {
      const net = p?.relationships?.network?.data?.id ?? null;
      const name = (p?.attributes?.name ?? "").toUpperCase();
      return (net === null || net === "base") && name.includes(symUpper);
    }).slice(0, lim * 2);

    const results = pools.length
      ? await Promise.all(pools.map(async (p: any) => {
          const a = p?.attributes ?? {};
          const addr = a?.address ?? "";
          const net = p?.relationships?.network?.data?.id ?? "base";
          let detail: any = null;
          try {
            const d = await fetchJsonRetry(`${GECKO_BASE}/networks/${net}/pools/${addr}`, { timeoutMs: 10000 }, 2);
            detail = d?.data?.attributes ?? null;
          } catch { /* not on this network */ }
          if (!detail) return null;
          detail = detail ?? a;
          const vol = detail?.volume_usd ?? {};
          const chg = detail?.price_change_percentage ?? {};
          return {
            token_symbol: symbol,
            underlying_ticker: ticker,
            pool_name: detail?.name ?? a?.name ?? "",
            network: net,
            pool_address: addr,
            price_usd: detail?.base_token_price_usd ? parseFloat(detail.base_token_price_usd) : null,
            price_change_24h_pct: chg?.h24 != null ? parseFloat(chg.h24) : null,
            volume_24h_usd: vol?.h24 != null ? parseFloat(vol.h24) : null,
            volume_7d_usd: vol?.h7d != null ? parseFloat(vol.h7d) : null,
            liquidity_usd: detail?.reserve_in_usd ? parseFloat(detail.reserve_in_usd) : null,
            fdv_usd: detail?.fdv_usd ? parseFloat(detail.fdv_usd) : null,
            dex: detail?.dex_id ?? null,
            pool_created_at: detail?.pool_created_at ?? null,
          };
        }))
      : [];

    // Drop cross-network pools (null results), rank by 24h volume so the deepest pool surfaces first
    const confirmed = results.filter((r: any) => r !== null);
    confirmed.sort((x: any, y: any) => (y.volume_24h_usd ?? 0) - (x.volume_24h_usd ?? 0));

    if (!confirmed.length) {
      // GeckoTerminal exhausted (rate limit, outage, or no pools) — fall back to
      // DexScreener's free public search API with the same output schema.
      const fb = await getTokenStockQuoteFromDexScreener(symbol, ticker, lim);
      if (fb.success) { cachePut(cacheKey, fb); return fb; }
      return fail(`no Base pools found for ${symbol} via GeckoTerminal or DexScreener (${fb.error}); known Coinbase token stocks: ${Object.keys(TOKEN_STOCK_SYMBOLS).join(", ")}`, source);
    }

    const out = ok(
      {
        query: q,
        asset_class: "tokenized_equity",
        note: "Quotes are DEX pool prices for tokenized stock tokens (e.g. Coinbase B20 tokens on Base), not NASDAQ/NYSE prints. Deviations from the TradFi print are possible.",
        pools: confirmed.slice(0, lim),
      },
      source,
      confirmed.length
    );
    cachePut(cacheKey, out);
    return out;
  } catch (e: any) {
    // GeckoTerminal hard-failed (429 exhausted retries, 5xx, timeout) — try DexScreener
    try {
      const { symbol, ticker } = normalizeTokenStockQuery((query ?? "").trim());
      const lim = clamp(Math.trunc(limit ?? 3), 1, 10);
      const fb = await getTokenStockQuoteFromDexScreener(symbol, ticker, lim);
      if (fb.success) { cachePut(`${symbol}|${lim}`, fb); return fb; }
      return fail(`GeckoTerminal error (${e?.message ?? String(e)}); DexScreener fallback also failed: ${fb.error}`, source);
    } catch (fbErr: any) {
      return fail(`GeckoTerminal error (${e?.message ?? String(e)}); DexScreener fallback error (${fbErr?.message ?? String(fbErr)})`, source);
    }
  }
}

// DexScreener fallback — free keyless public API, same output schema.
// Search results include unrelated/scam tokens, so require an exact
// baseToken.symbol match on Base before ranking by 24h volume.
export async function getTokenStockQuoteFromDexScreener(symbol: string, ticker: string, lim: number) {
  const source = "DexScreener public DEX data (tokenized equities on Base)";
  try {
    const d = await fetchJsonRetry(`${DEXSCREENER_BASE}/search?q=${encodeURIComponent(symbol)}`, { timeoutMs: 12000 });
    const pairs = ((d?.pairs ?? []) as any[])
      .filter((p) => p?.chainId === "base")
      .filter((p) => (p?.baseToken?.symbol ?? "").toUpperCase() === symbol.toUpperCase())
      .map((p) => ({
        token_symbol: symbol,
        underlying_ticker: ticker,
        pool_name: `${p?.baseToken?.symbol ?? symbol} / ${p?.quoteToken?.symbol ?? "?"}`,
        network: "base",
        pool_address: p?.pairAddress ?? "",
        price_usd: p?.priceUsd != null ? parseFloat(p.priceUsd) : null,
        price_change_24h_pct: p?.priceChange?.h24 != null ? parseFloat(p.priceChange.h24) : null,
        volume_24h_usd: p?.volume?.h24 != null ? parseFloat(p.volume.h24) : null,
        volume_7d_usd: null, // DexScreener does not expose 7d volume
        liquidity_usd: p?.liquidity?.usd != null ? parseFloat(p.liquidity.usd) : null,
        fdv_usd: p?.fdv != null ? parseFloat(p.fdv) : null,
        dex: p?.dexId ?? null,
        pool_created_at: p?.pairCreatedAt != null ? new Date(p.pairCreatedAt).toISOString() : null,
      }));
    if (!pairs.length) return fail(`no Base pools found for ${symbol}`, source);
    pairs.sort((x: any, y: any) => (y.volume_24h_usd ?? 0) - (x.volume_24h_usd ?? 0));
    return ok(
      {
        query: symbol,
        asset_class: "tokenized_equity",
        note: "Quotes are DEX pool prices for tokenized stock tokens (e.g. Coinbase B20 tokens on Base), not NASDAQ/NYSE prints. Deviations from the TradFi print are possible.",
        pools: pairs.slice(0, lim),
      },
      source,
      pairs.length
    );
  } catch (e: any) {
    return fail(e?.message ?? String(e), source);
  }
}
