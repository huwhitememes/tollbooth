const KALSHI_ORIGIN = "https://external-api.kalshi.com/trade-api/v2";
const GAMMA_ORIGIN = "https://gamma-api.polymarket.com";
const POLY_FEE_RATE = 0.02;
const KALSHI_TAKER_COEFFICIENT = 0.07;
const COLLECTION_TICKER_THRESHOLD = 0.99;

export type CrossPlatformScanOptions = {
  query: string;
  minSimilarity?: number;
  minNetEdge?: number;
  polymarketLimit?: number;
  kalshiMaxPages?: number;
  maxMatches?: number;
};

type RawMarket = Record<string, unknown>;

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "at", "be", "before", "by", "for", "from", "how", "in", "is", "it",
  "market", "of", "on", "or", "the", "this", "to", "will", "win", "with", "yes",
]);

const finite = (value: unknown, fallback = 0) => {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
};

const rounded = (value: number, digits = 4) => Number(value.toFixed(digits));

function parseArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function normalizeMarketText(value: string) {
  return value
    .toLowerCase()
    .replace(/u\.s\./g, "us")
    .replace(/donald\s+trump/g, "trump")
    .replace(/democratic/g, "democrat")
    .replace(/republican party/g, "republican")
    .replace(/(?<=\d),(?=\d)/g, "")
    .replace(/[^a-z0-9.%+\-]+/g, " ")
    .trim();
}

function tokens(value: string) {
  return new Set(normalizeMarketText(value).split(/\s+/).filter((token) => token.length > 1 && !STOP_WORDS.has(token)));
}

function numbers(value: string) {
  return new Set(normalizeMarketText(value).match(/\b\d+(?:\.\d+)?%?\b/g) ?? []);
}

function decisiveNumbers(value: string) {
  return new Set([...numbers(value)].filter((token) => {
    const number = Number.parseFloat(token);
    if (token.includes(".") || token.endsWith("%")) return true;
    return number > 31 && !(number >= 1900 && number <= 2100);
  }));
}

function years(value: string) {
  return new Set([...numbers(value)].filter((token) => {
    const number = Number.parseInt(token, 10);
    return number >= 1900 && number <= 2100;
  }));
}

function calendarDates(value: string) {
  const monthNumbers: Record<string, string> = {
    jan: "01", january: "01", feb: "02", february: "02", mar: "03", march: "03",
    apr: "04", april: "04", may: "05", jun: "06", june: "06", jul: "07", july: "07",
    aug: "08", august: "08", sep: "09", sept: "09", september: "09", oct: "10", october: "10",
    nov: "11", november: "11", dec: "12", december: "12",
  };
  const dates = new Set<string>();
  const pattern = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})\b/g;
  for (const match of normalizeMarketText(value).matchAll(pattern)) {
    const month = monthNumbers[match[1]];
    if (month) dates.add(`${month}-${match[2].padStart(2, "0")}`);
  }
  return dates;
}

function directionalTerms(value: string) {
  const terms = ["above", "below", "over", "under", "at least", "more than", "less than", "before", "after"];
  const normalized = normalizeMarketText(value);
  return new Set(terms.filter((term) => normalized.includes(term)));
}

function intersectionSize<T>(a: Set<T>, b: Set<T>) {
  let count = 0;
  for (const value of a) if (b.has(value)) count += 1;
  return count;
}

export function marketSimilarity(left: string, right: string) {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;

  const shared = intersectionSize(a, b);
  if (!shared) return 0;

  const aNumbers = numbers(left);
  const bNumbers = numbers(right);
  const aDecisive = decisiveNumbers(left);
  const bDecisive = decisiveNumbers(right);
  if (aDecisive.size && bDecisive.size && intersectionSize(aDecisive, bDecisive) === 0) return 0;
  const aYears = years(left);
  const bYears = years(right);
  if (aYears.size && bYears.size && intersectionSize(aYears, bYears) === 0) return 0;
  const aDates = calendarDates(left);
  const bDates = calendarDates(right);
  if (aDates.size && bDates.size && intersectionSize(aDates, bDates) === 0) return 0;

  const aDirections = directionalTerms(left);
  const bDirections = directionalTerms(right);
  if (aDirections.size && bDirections.size && intersectionSize(aDirections, bDirections) === 0) return 0;

  const union = new Set([...a, ...b]).size;
  const jaccard = shared / union;
  const containment = shared / Math.min(a.size, b.size);
  const numberBonus = aNumbers.size && bNumbers.size ? 0.08 : 0;
  return Math.min(1, 0.55 * jaccard + 0.45 * containment + numberBonus);
}

function matchesQuery(text: string, query: string) {
  const queryTokens = [...tokens(query)];
  if (!queryTokens.length) return false;
  const haystack = tokens(text);
  return queryTokens.every((token) => haystack.has(token));
}

function polymarketText(market: RawMarket) {
  return `${String(market.question ?? "")} ${String(market.groupItemTitle ?? "")}`.trim();
}

function kalshiText(market: RawMarket) {
  return `${String(market.title ?? "")} ${String(market.yes_sub_title ?? "")}`.trim();
}

function kalshiFee(price: number) {
  return KALSHI_TAKER_COEFFICIENT * price * (1 - price);
}

export function analyzeCrossPlatformPairs(
  polymarketMarkets: RawMarket[],
  kalshiMarkets: RawMarket[],
  options: Omit<CrossPlatformScanOptions, "query"> & { query?: string } = {},
) {
  const minSimilarity = options.minSimilarity ?? 0.62;
  const minNetEdge = options.minNetEdge ?? 0.015;
  const maxMatches = Math.min(50, Math.max(1, Math.trunc(options.maxMatches ?? 25)));
  const matches: Array<Record<string, unknown>> = [];
  const opportunities: Array<Record<string, unknown>> = [];

  for (const poly of polymarketMarkets) {
    const polyText = polymarketText(poly);
    const outcomePrices = parseArray(poly.outcomePrices).map((value) => finite(value, Number.NaN));
    const polyYesAsk = finite(poly.bestAsk, outcomePrices[0]);
    const polyYesBid = finite(poly.bestBid, Number.NaN);
    if (!(polyYesAsk > 0 && polyYesAsk <= 1)) continue;
    const polyNoAskProxy = polyYesBid > 0 && polyYesBid < 1 ? 1 - polyYesBid : null;

    for (const kalshi of kalshiMarkets) {
      const kText = kalshiText(kalshi);
      const similarity = marketSimilarity(polyText, kText);
      if (similarity < minSimilarity) continue;

      const kYesAsk = finite(kalshi.yes_ask_dollars, (kalshi.yes_ask ?? null) !== null ? finite(kalshi.yes_ask, 0) / 100 : Number.NaN);
      const kNoAsk = finite(kalshi.no_ask_dollars, (kalshi.no_ask ?? null) !== null ? finite(kalshi.no_ask, 0) / 100 : Number.NaN);
      if (!(kYesAsk > 0 && kYesAsk <= 1) && !(kNoAsk > 0 && kNoAsk <= 1)) continue;
      if (kYesAsk >= COLLECTION_TICKER_THRESHOLD && kNoAsk >= COLLECTION_TICKER_THRESHOLD) continue;

      const base = {
        similarity: rounded(similarity, 3),
        polymarket: {
          question: String(poly.question ?? "").slice(0, 220),
          slug: String(poly.slug ?? ""),
          url: `https://polymarket.com/market/${String(poly.slug ?? "")}`,
          yes_bid: Number.isFinite(polyYesBid) ? rounded(polyYesBid) : null,
          yes_ask: rounded(polyYesAsk),
          no_ask_proxy: polyNoAskProxy === null ? null : rounded(polyNoAskProxy),
          liquidity_usd: rounded(finite(poly.liquidityNum ?? poly.liquidity), 2),
        },
        kalshi: {
          ticker: String(kalshi.ticker ?? ""),
          event_ticker: String(kalshi.event_ticker ?? ""),
          title: String(kalshi.title ?? "").slice(0, 220),
          yes_sub_title: String(kalshi.yes_sub_title ?? "").slice(0, 160),
          url: `https://kalshi.com/markets/${String(kalshi.event_ticker ?? "").toLowerCase()}`,
          yes_ask: rounded(kYesAsk),
          no_ask: rounded(kNoAsk),
          volume_contracts: rounded(finite(kalshi.volume_fp), 2),
        },
      };

      const directions: Array<{ type: string; poly_price: number; kalshi_price: number; poly_side: string; kalshi_side: string }> = [];
      if (kNoAsk > 0 && kNoAsk <= 1) {
        directions.push({
          type: "BUY_POLYMARKET_YES_BUY_KALSHI_NO",
          poly_price: polyYesAsk,
          kalshi_price: kNoAsk,
          poly_side: "YES",
          kalshi_side: "NO",
        });
      }
      if (polyNoAskProxy !== null && kYesAsk > 0 && kYesAsk <= 1) {
        directions.push({
          type: "BUY_POLYMARKET_NO_BUY_KALSHI_YES",
          poly_price: polyNoAskProxy,
          kalshi_price: kYesAsk,
          poly_side: "NO",
          kalshi_side: "YES",
        });
      }
      if (!directions.length) continue;
      const scoredDirections = directions.map((direction) => {
        const grossCost = direction.poly_price + direction.kalshi_price;
        const estimatedFees = direction.poly_price * POLY_FEE_RATE + kalshiFee(direction.kalshi_price);
        const netEdge = 1 - grossCost - estimatedFees;
        return {
          ...direction,
          gross_cost: rounded(grossCost),
          estimated_fees: rounded(estimatedFees),
          net_edge: rounded(netEdge),
          net_edge_pct: rounded(netEdge * 100, 2),
        };
      }).sort((a, b) => b.net_edge - a.net_edge);

      matches.push({ ...base, best_direction: scoredDirections[0] });
      for (const direction of scoredDirections) {
        if (direction.net_edge >= minNetEdge) opportunities.push({ ...base, ...direction });
      }
    }
  }

  matches.sort((a, b) => {
    const edgeDiff = finite((b.best_direction as Record<string, unknown>)?.net_edge) - finite((a.best_direction as Record<string, unknown>)?.net_edge);
    return edgeDiff || finite(b.similarity) - finite(a.similarity);
  });
  opportunities.sort((a, b) => finite(b.net_edge) - finite(a.net_edge));
  return {
    candidate_matches: matches.slice(0, maxMatches),
    opportunities: opportunities.slice(0, maxMatches),
  };
}

async function getJson<T>(url: string, fetcher: typeof fetch): Promise<T> {
  const response = await fetcher(url, { headers: { Accept: "application/json", "User-Agent": "TollboothCrossMarket/0.1" } });
  if (!response.ok) throw new Error(`Upstream market API returned HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function fetchPolymarketCandidates(query: string, limit: number, fetcher: typeof fetch) {
  const params = new URLSearchParams({
    active: "true",
    closed: "false",
    limit: String(limit),
    order: "volume24hr",
    ascending: "false",
  });
  const markets = await getJson<RawMarket[]>(`${GAMMA_ORIGIN}/markets?${params}`, fetcher);
  return markets.filter((market) => matchesQuery(polymarketText(market), query));
}

async function fetchKalshiCandidates(query: string, maxPages: number, fetcher: typeof fetch) {
  const candidates: RawMarket[] = [];
  let cursor = "";
  let scanned = 0;
  let pages = 0;
  do {
    const params = new URLSearchParams({ status: "open", mve_filter: "exclude", limit: "1000" });
    if (cursor) params.set("cursor", cursor);
    const data = await getJson<{ markets?: RawMarket[]; cursor?: string }>(`${KALSHI_ORIGIN}/markets?${params}`, fetcher);
    const markets = data.markets ?? [];
    scanned += markets.length;
    for (const market of markets) {
      if (matchesQuery(kalshiText(market), query)) candidates.push(market);
    }
    cursor = String(data.cursor ?? "");
    pages += 1;
  } while (cursor && pages < maxPages);
  return { candidates, scanned, pages, truncated: Boolean(cursor) };
}

export async function scanCrossPlatformMarkets(options: CrossPlatformScanOptions, fetcher: typeof fetch = fetch) {
  const query = options.query.trim();
  if (query.length < 2 || query.length > 100) throw new Error("Query must be 2-100 characters");
  const polymarketLimit = Math.min(1000, Math.max(100, Math.trunc(options.polymarketLimit ?? 1000)));
  const kalshiMaxPages = Math.min(20, Math.max(1, Math.trunc(options.kalshiMaxPages ?? 12)));
  const [polymarketResult, kalshiResult] = await Promise.allSettled([
    fetchPolymarketCandidates(query, polymarketLimit, fetcher),
    fetchKalshiCandidates(query, kalshiMaxPages, fetcher),
  ]);
  const polymarket = polymarketResult.status === "fulfilled" ? polymarketResult.value : [];
  const kalshi = kalshiResult.status === "fulfilled" ? kalshiResult.value : { candidates: [], scanned: 0, pages: 0, truncated: false };
  const upstreamErrors = [
    polymarketResult.status === "rejected" ? { source: "Polymarket Gamma API", message: polymarketResult.reason instanceof Error ? polymarketResult.reason.message : String(polymarketResult.reason) } : null,
    kalshiResult.status === "rejected" ? { source: "Kalshi public Trade API", message: kalshiResult.reason instanceof Error ? kalshiResult.reason.message : String(kalshiResult.reason) } : null,
  ].filter(Boolean);
  const degraded = upstreamErrors.length > 0;
  const matched = analyzeCrossPlatformPairs(polymarket, kalshi.candidates, options);
  return {
    source: ["Polymarket Gamma API", "Kalshi public Trade API"],
    generated_at: new Date().toISOString(),
    query,
    degraded,
    upstream_errors: upstreamErrors,
    methodology: "Query-filtered title matching with number and directional guards. Prices use current top-of-book asks; Polymarket NO ask is proxied as 1 minus the YES bid. Net edge deducts a 2% Polymarket estimate and Kalshi's 7% × price × (1-price) taker formula.",
    warning: degraded
      ? "One or more upstream market APIs failed or rate-limited, so this response may contain partial coverage and no arbitrage conclusion. Retry later for full cross-platform coverage. This endpoint does not trade."
      : "Candidate matches are not proof that settlement rules are identical. Read both rulebooks before treating any spread as guaranteed. This endpoint does not trade.",
    config: {
      min_similarity: options.minSimilarity ?? 0.62,
      min_net_edge: options.minNetEdge ?? 0.015,
      polymarket_limit: polymarketLimit,
      kalshi_max_pages: kalshiMaxPages,
    },
    scanned: {
      polymarket_markets: polymarketLimit,
      polymarket_candidates: polymarket.length,
      kalshi_markets: kalshi.scanned,
      kalshi_candidates: kalshi.candidates.length,
      kalshi_pages: kalshi.pages,
      kalshi_truncated: kalshi.truncated,
    },
    ...matched,
  };
}
