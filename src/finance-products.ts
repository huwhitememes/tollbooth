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
