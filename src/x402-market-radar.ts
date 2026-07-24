const BASE_DISCOVERY_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery";
const DEFAULT_NETWORK = "eip155:8453";
const DEFAULT_AGENTTOLL_DOMAIN = "agenttoll.dev";
const DEFAULT_AGENTTOLL_PAYTO = "0x62a0D3d9DF0dE8804983009949c714EaeAFd87F1";
const USER_AGENT = "agenttoll.dev/x402-market-radar";
const USDC_DECIMALS = 1_000_000;

const DEFAULT_QUERIES = [
  "agenttoll.dev",
  "Polymarket market data",
  "cross-platform Kalshi Polymarket agenttoll",
  "SEC EDGAR filings",
  "SEC 8-K velocity",
  "CVE search",
  "AI video intelligence",
  "x402 market radar",
  "MCP registry",
  "agent payable data",
  "prediction market arbitrage",
  "MCP security risk scan",
];

const DEFAULT_VERTICALS: Record<string, string> = {
  "prediction/polymarket/kalshi": "prediction market Polymarket Kalshi arbitrage",
  "SEC/finance/news": "SEC EDGAR finance filings news",
  "security/MCP risk": "MCP security risk scan audit",
  "browser/web extraction": "browser web scrape search extraction",
  "AI inference/video": "AI inference video generation model pricing",
  "developer/OpenAPI/GitHub": "OpenAPI GitHub developer API",
  "x402 market intelligence": "x402 Bazaar market radar agent payable data",
};

type FetchLike = typeof fetch;

type BazaarRow = {
  resource?: string;
  description?: string;
  serviceName?: string;
  tags?: string[];
  curated?: boolean;
  skillUrl?: string;
  lastUpdated?: string;
  quality?: Record<string, unknown>;
  accepts?: Array<{ amount?: string; maxAmountRequired?: string; network?: string; payTo?: string; scheme?: string; asset?: string }>;
};

type RadarOptions = {
  fetcher?: FetchLike;
  network?: string;
  agenttollDomain?: string;
  agenttollPayTo?: string;
  queryLimit?: number;
  queries?: string[];
  baselineTotal?: number;
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function resourceUrl(row: BazaarRow): string {
  return String(row.resource ?? "");
}

function domainFor(row: BazaarRow): string {
  try {
    return new URL(resourceUrl(row)).hostname;
  } catch {
    return "";
  }
}

function amountAtomic(row: BazaarRow): number | null {
  const accept = Array.isArray(row.accepts) ? row.accepts[0] : undefined;
  const raw = accept?.amount ?? accept?.maxAmountRequired;
  if (raw == null) return null;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : null;
}

function amountUsdc(row: BazaarRow): number | null {
  const atomic = amountAtomic(row);
  return atomic == null ? null : atomic / USDC_DECIMALS;
}

function compactRow(row: BazaarRow) {
  return {
    amount_usdc: amountUsdc(row),
    domain: domainFor(row),
    resource: resourceUrl(row),
    serviceName: row.serviceName ?? null,
    description: String(row.description ?? "").slice(0, 260),
    tags: Array.isArray(row.tags) ? row.tags : [],
    curated: Boolean(row.curated),
    skillUrl: row.skillUrl ?? null,
    lastUpdated: row.lastUpdated ?? null,
  };
}

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - idx) + sorted[hi] * (idx - lo);
}

function median(sorted: number[]): number | null {
  return quantile(sorted, 0.5);
}

function priceStats(rows: BazaarRow[]) {
  const prices = rows
    .map(amountUsdc)
    .filter((p): p is number => p != null && p > 0 && p < 10)
    .sort((a, b) => a - b);
  return {
    count: prices.length,
    min: prices[0] ?? null,
    median: median(prices),
    p75: quantile(prices, 0.75),
    p90: quantile(prices, 0.9),
    max: prices[prices.length - 1] ?? null,
  };
}

async function fetchJson(fetcher: FetchLike, path: string): Promise<any> {
  const response = await fetcher(`${BASE_DISCOVERY_URL}${path}`, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
  });
  if (!response.ok) throw new Error(`CDP Bazaar ${response.status} for ${path}`);
  return response.json();
}

async function fetchResourcePulse(fetcher: FetchLike, network: string) {
  const params = new URLSearchParams({ type: "http", limit: "20", offset: "0", network });
  const body = await fetchJson(fetcher, `/resources?${params.toString()}`);
  const rows = (body.items ?? body.resources ?? []).filter((row: unknown): row is BazaarRow => Boolean(row && typeof row === "object"));
  return {
    reported_total: body.pagination?.total ?? rows.length,
    page_size_returned: rows.length,
    x402Version: body.x402Version ?? null,
    sample_resources: rows.map(compactRow),
    sample_price_stats: priceStats(rows),
  };
}

async function searchResources(fetcher: FetchLike, query: string, network: string, limit: number) {
  const params = new URLSearchParams({ query, network, limit: String(limit) });
  const body = await fetchJson(fetcher, `/search?${params.toString()}`);
  const rows = (body.resources ?? body.items ?? []).filter((row: unknown): row is BazaarRow => Boolean(row && typeof row === "object"));
  return {
    query,
    returned: rows.length,
    partialResults: body.partialResults ?? null,
    searchMethod: body.searchMethod ?? null,
    resources: rows,
  };
}

async function merchantResources(fetcher: FetchLike, payTo: string) {
  const params = new URLSearchParams({ payTo, limit: "100" });
  const body = await fetchJson(fetcher, `/merchant?${params.toString()}`);
  const rows = (body.resources ?? body.items ?? []).filter((row: unknown): row is BazaarRow => Boolean(row && typeof row === "object"));
  return rows;
}

function topDomains(rows: BazaarRow[], limit = 8) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const domain = domainFor(row);
    if (!domain) continue;
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([domain, count]) => ({ domain, count }));
}

export async function buildX402MarketRadar(options: RadarOptions = {}) {
  const fetcher = options.fetcher ?? fetch;
  const network = options.network ?? DEFAULT_NETWORK;
  const agenttollDomain = options.agenttollDomain ?? DEFAULT_AGENTTOLL_DOMAIN;
  const agenttollPayTo = options.agenttollPayTo ?? DEFAULT_AGENTTOLL_PAYTO;
  const queryLimit = clampInt(options.queryLimit, 15, 3, 20);
  const queries = (options.queries?.length ? options.queries : DEFAULT_QUERIES).slice(0, 16);
  const baselineTotal = options.baselineTotal ?? 24_934;

  const [catalog, merchantRows, querySearches, verticalSearches] = await Promise.all([
    fetchResourcePulse(fetcher, network),
    merchantResources(fetcher, agenttollPayTo),
    Promise.all(queries.map((query) => searchResources(fetcher, query, network, queryLimit))),
    Promise.all(Object.entries(DEFAULT_VERTICALS).map(async ([vertical, query]) => ({ vertical, ...(await searchResources(fetcher, query, network, queryLimit)) }))),
  ]);

  const keywordRanks = querySearches.map((result) => ({
    query: result.query,
    returned: result.returned,
    partialResults: result.partialResults,
    searchMethod: result.searchMethod,
    agenttoll_positions: result.resources
      .map((row: BazaarRow, index: number) => resourceUrl(row).includes(agenttollDomain) ? index + 1 : null)
      .filter((position: number | null): position is number => position != null),
    top_results: result.resources.slice(0, 10).map(compactRow),
  }));

  const verticals = Object.fromEntries(verticalSearches.map((result) => [result.vertical, {
    query: result.query,
    returned: result.returned,
    median_price: priceStats(result.resources).median,
    p75_price: priceStats(result.resources).p75,
    top_domains: topDomains(result.resources, 5),
    sample_resources: result.resources.slice(0, 10).map(compactRow),
  }]));

  const missingRanks = keywordRanks.filter((row) => row.agenttoll_positions.length === 0).map((row) => row.query);
  const currentTotal = Number(catalog.reported_total ?? 0);

  return {
    product: "x402 Market Radar",
    service: "agenttoll.dev",
    generated_at: new Date().toISOString(),
    cost_note: "Buyer paid this x402 endpoint. Upstream CDP Bazaar reads are public read-only calls.",
    network,
    catalog: {
      current_total: currentTotal,
      baseline_total: baselineTotal,
      net_change_from_baseline: currentTotal - baselineTotal,
      x402Version: catalog.x402Version,
      first_page_returned: catalog.page_size_returned,
      sample_price_stats: catalog.sample_price_stats,
      sample_resources: catalog.sample_resources,
    },
    agenttoll: {
      payTo: agenttollPayTo,
      merchant_count: merchantRows.length,
      merchant_resources: merchantRows.map(compactRow),
      keyword_ranks: keywordRanks,
      missing_rank_queries: missingRanks,
    },
    verticals,
    read: {
      summary: `Bazaar reports ${currentTotal.toLocaleString("en-US")} HTTP resources on ${network}. AgentToll has ${merchantRows.length} merchant resources for the configured seller wallet.`,
      sharp_moves: [
        "Tighten metadata on queries where AgentToll does not rank.",
        "Push useful paid traffic through flagship routes before spending on broad settlement runs.",
        "Watch domain concentration and cheap wrapper spam before choosing the next endpoint niche.",
      ],
    },
    provenance: {
      cdp_discovery: BASE_DISCOVERY_URL,
      resource_total_method: "GET /resources first page plus pagination.total",
      rank_method: "GET /search for each tracked query",
      merchant_method: "GET /merchant by seller payTo",
    },
  };
}
