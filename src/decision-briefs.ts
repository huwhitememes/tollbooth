import { buildX402MarketRadar } from "./x402-market-radar";
import { getInsiderTrades } from "./finance-products";
import { searchFederalContracts } from "./gov-products";
import { searchFederalRegister, searchRegulations } from "./legal-products";

const CDP_DISCOVERY = "https://api.cdp.coinbase.com/platform/v2/x402/discovery";
const USER_AGENT = "agenttoll.dev/decision-briefs";

type BazaarRow = {
  resource?: string;
  description?: string;
  serviceName?: string;
  tags?: string[];
  accepts?: Array<{ amount?: string; maxAmountRequired?: string; network?: string; payTo?: string }>;
};

type RankAuditOptions = {
  resource?: string;
  keywords?: string[];
  network?: string;
  limit?: number;
};

type InsiderClusterOptions = {
  ticker?: string;
  limit?: number;
};

type ContractFitOptions = {
  keyword?: string;
  agency?: string;
  company_domain?: string;
  limit?: number;
};

type RegulatoryImpactOptions = {
  sector?: string;
  agency?: string;
  jurisdiction?: string;
  hours?: number;
  limit?: number;
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function cleanText(value: unknown, fallback = ""): string {
  return String(value ?? fallback).trim();
}

function amountUsdc(row: BazaarRow): number | null {
  const raw = row.accepts?.[0]?.amount ?? row.accepts?.[0]?.maxAmountRequired;
  if (raw == null) return null;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n / 1_000_000 : null;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ""; }
}

function compactBazaar(row: BazaarRow, position: number) {
  return {
    position,
    resource: row.resource ?? "",
    domain: hostOf(String(row.resource ?? "")),
    serviceName: row.serviceName ?? null,
    price_usdc: amountUsdc(row),
    tags: Array.isArray(row.tags) ? row.tags.slice(0, 8) : [],
    description: String(row.description ?? "").slice(0, 260),
  };
}

async function cdpSearch(query: string, network: string, limit: number): Promise<BazaarRow[]> {
  const params = new URLSearchParams({ query, network, limit: String(limit) });
  const response = await fetch(`${CDP_DISCOVERY}/search?${params.toString()}`, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
  });
  if (!response.ok) throw new Error(`CDP discovery search returned ${response.status}`);
  const body = await response.json() as any;
  return (body.resources ?? body.items ?? []).filter((row: unknown): row is BazaarRow => Boolean(row && typeof row === "object"));
}

async function fetchJsonAny(url: string, opts: RequestInit & { timeoutMs?: number } = {}): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 12000);
  try {
    const response = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...(opts.headers || {}) },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
    return response.json();
  } finally {
    clearTimeout(t);
  }
}

function scoreMetadata(resource: string, rows: BazaarRow[]) {
  const target = rows.find((row) => String(row.resource ?? "") === resource || String(row.resource ?? "").includes(resource));
  if (!target) return { found: false, score: 0, defects: ["Resource did not appear in the sampled Bazaar search rows."] };
  const defects: string[] = [];
  const tags = Array.isArray(target.tags) ? target.tags : [];
  if (!target.serviceName) defects.push("Missing serviceName weakens trust in agent search results.");
  if (String(target.description ?? "").length < 120) defects.push("Description is short. Add buyer pain, exact output, and use case terms.");
  if (tags.length < 4) defects.push("Tags are thin. Add buyer-intent and category tags.");
  const price = amountUsdc(target);
  if (price == null) defects.push("Price was not readable from the first accept requirement.");
  const score = Math.max(0, 100 - defects.length * 18);
  return { found: true, score, defects, target: compactBazaar(target, 0) };
}

export async function buildX402RankAudit(options: RankAuditOptions = {}) {
  const network = options.network ?? "eip155:8453";
  const resource = cleanText(options.resource, "https://agenttoll.dev/paid/x402/market-radar");
  const keywords = (Array.isArray(options.keywords) && options.keywords.length ? options.keywords : [
    "x402 market radar",
    "CDP Bazaar ranking",
    "agent payable data",
  ]).map((x) => cleanText(x)).filter(Boolean).slice(0, 8);
  const limit = clampInt(options.limit, 15, 5, 25);

  const searches = await Promise.all(keywords.map(async (keyword) => {
    const rows = await cdpSearch(keyword, network, limit);
    const matches = rows
      .map((row, idx) => ({ row, position: idx + 1 }))
      .filter(({ row }) => String(row.resource ?? "").includes(resource) || String(row.resource ?? "").includes(hostOf(resource)));
    const top = rows.slice(0, Math.min(10, rows.length)).map((row, idx) => compactBazaar(row, idx + 1));
    return {
      keyword,
      returned: rows.length,
      best_position: matches[0]?.position ?? null,
      matched_resources: matches.map(({ row, position }) => compactBazaar(row, position)),
      top_competitors: top.filter((row) => !row.resource.includes(hostOf(resource))).slice(0, 5),
      metadata: scoreMetadata(resource, rows),
    };
  }));

  const missing = searches.filter((row) => row.best_position == null).map((row) => row.keyword);
  const ranked = searches.filter((row) => row.best_position != null) as Array<typeof searches[number] & { best_position: number }>;
  const avgRank = ranked.length ? ranked.reduce((sum, row) => sum + row.best_position, 0) / ranked.length : null;
  const defects = [...new Set(searches.flatMap((row) => row.metadata.defects ?? []))];

  return {
    product: "x402 Rank Audit",
    generated_at: new Date().toISOString(),
    resource,
    network,
    summary: {
      keywords_checked: keywords.length,
      ranked_keywords: ranked.length,
      missing_keywords: missing,
      average_rank_when_visible: avgRank,
      verdict: missing.length === 0 && avgRank != null && avgRank <= 5 ? "visible" : missing.length < keywords.length ? "partially_visible" : "not_visible",
    },
    searches,
    recommendations: [
      ...(missing.length ? [`Add exact buyer-intent phrases to Bazaar description and tags: ${missing.slice(0, 3).join(", ")}.`] : []),
      ...(defects.length ? defects : ["Metadata passed the basic discovery scan. Improve ranking through paid traffic and narrower keyword coverage."]),
      "Run one CDP-routed paid call after metadata changes so Bazaar has settlement-backed evidence for the updated resource.",
    ],
    provenance: { cdp_discovery: CDP_DISCOVERY, method: "Live CDP Bazaar search over supplied keywords." },
  };
}

function describeInsiderCluster(rows: any[]) {
  const byCompany = new Map<string, any[]>();
  for (const row of rows) {
    const key = row.company_name || row.ticker || "unknown";
    byCompany.set(key, [...(byCompany.get(key) ?? []), row]);
  }
  return [...byCompany.entries()].map(([company, filings]) => ({
    company,
    ticker: filings.find((r) => r.ticker)?.ticker ?? null,
    filing_count: filings.length,
    latest_filed_date: filings.map((r) => r.filed_date).filter(Boolean).sort().at(-1) ?? null,
    accessions: filings.map((r) => r.accession_no).filter(Boolean).slice(0, 10),
    sec_urls: filings.map((r) => r.url).filter(Boolean).slice(0, 5),
    signal: filings.length >= 4 ? "cluster" : filings.length >= 2 ? "watch" : "single_filing",
  })).sort((a, b) => b.filing_count - a.filing_count).slice(0, 10);
}

async function form4FilingsForTicker(ticker: string, limit: number) {
  const mapBody = await fetchJsonAny("https://www.sec.gov/files/company_tickers.json", { timeoutMs: 12000 }) as Record<string, any>;
  const match = Object.values(mapBody).find((row: any) => String(row.ticker ?? "").toUpperCase() === ticker.toUpperCase()) as any;
  if (!match) return [];
  const cik = String(match.cik_str).padStart(10, "0");
  const sub = await fetchJsonAny(`https://data.sec.gov/submissions/CIK${cik}.json`, { timeoutMs: 12000 }) as any;
  const recent = sub?.filings?.recent ?? {};
  const forms: string[] = recent.form ?? [];
  const rows: any[] = [];
  for (let i = 0; i < forms.length && rows.length < limit; i++) {
    if (forms[i] !== "4") continue;
    const accession = recent.accessionNumber?.[i] ?? null;
    rows.push({
      form_type: "4",
      filed_date: recent.filingDate?.[i] ?? null,
      report_date: recent.reportDate?.[i] ?? null,
      company_name: sub.name ?? match.title ?? "",
      ticker,
      cik,
      accession_no: accession,
      description: recent.primaryDocDescription?.[i] ?? recent.items?.[i] ?? "Form 4 insider transaction statement",
      url: accession ? `https://www.sec.gov/Archives/edgar/data/${String(match.cik_str)}/${String(accession).replace(/-/g, "")}/${recent.primaryDocument?.[i] ?? ""}` : "",
    });
  }
  return rows;
}

export async function buildInsiderClusterBrief(options: InsiderClusterOptions = {}) {
  const limit = clampInt(options.limit, 30, 5, 80);
  const ticker = cleanText(options.ticker).toUpperCase() || undefined;
  let rows: any[] = [];
  let source = "SEC company submissions API";
  let success = true;
  if (ticker) {
    try {
      rows = await form4FilingsForTicker(ticker, limit);
    } catch {
      const raw = await getInsiderTrades(ticker, limit) as any;
      rows = Array.isArray(raw?.data?.results) ? raw.data.results : [];
      source = raw?.meta?.source ?? "SEC EDGAR Form 4";
      success = raw?.success ?? false;
    }
  } else {
    const raw = await getInsiderTrades(undefined, limit) as any;
    rows = Array.isArray(raw?.data?.results) ? raw.data.results : [];
    source = raw?.meta?.source ?? "SEC EDGAR Form 4";
    success = raw?.success ?? false;
  }
  const clusters = describeInsiderCluster(rows);
  const clusterCount = clusters.filter((row) => row.signal === "cluster").length;
  return {
    product: "Insider Cluster Brief",
    generated_at: new Date().toISOString(),
    ticker: ticker ?? null,
    summary: {
      filings_checked: rows.length,
      clustered_companies: clusterCount,
      watch_companies: clusters.filter((row) => row.signal === "watch").length,
      verdict: clusterCount ? "cluster_detected" : clusters.length ? "watch" : "no_recent_filings_found",
      note: "Signal intel only, not investment advice.",
    },
    clusters,
    raw_source_status: { success, source },
    next_actions: clusterCount || clusters.length
      ? ["Open the Form 4 filing and verify officer role plus transaction code before acting.", "Compare filing dates against price and news movement."]
      : ["Use a specific liquid ticker for stronger Form 4 coverage.", "Use this as a watchlist filter, not as a trade trigger."],
  };
}

async function searchContractAwards(keyword: string, agency: string | undefined, limit: number) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1)).toISOString().slice(0, 10);
  const end = now.toISOString().slice(0, 10);
  const filters: any = { award_type_codes: ["A", "B", "C", "D"], time_period: [{ start_date: start, end_date: end }] };
  if (keyword.trim()) filters.keywords = [keyword.trim()];
  if (agency?.trim()) filters.agencies = [{ type: "awarding", tier: "toptier", name: agency.trim() }];
  const body = {
    filters,
    fields: ["Award ID", "Recipient Name", "Awarding Agency", "Awarding Sub Agency", "Award Amount", "Start Date", "End Date", "Award Type", "Description", "Contract Award Type"],
    page: 1,
    limit,
    sort: "Award Amount",
    order: "desc",
  };
  const json = await fetchJsonAny("https://api.usaspending.gov/api/v2/search/spending_by_award/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 15000,
  });
  return (json?.results ?? []).map((r: any) => ({
    contract_id: r["Award ID"] ?? "",
    recipient: r["Recipient Name"] ?? "",
    agency: r["Awarding Agency"] ?? "",
    sub_agency: r["Awarding Sub Agency"] ?? "",
    amount: parseFloat(r["Award Amount"]) || 0,
    description: (r["Description"] ?? "").slice(0, 500),
    start_date: r["Start Date"] ?? "",
    end_date: r["End Date"] ?? "",
    award_type: r["Award Type"] ?? "",
    contract_award_type: r["Contract Award Type"] ?? null,
  }));
}

function scoreContractFit(item: any, keyword: string, companyDomain?: string) {
  const hay = `${item.description ?? ""} ${item.agency ?? ""} ${item.recipient ?? ""}`.toLowerCase();
  const terms = keyword.toLowerCase().split(/\s+/).filter((term) => term.length > 2);
  const termHits = terms.filter((term) => hay.includes(term)).length;
  const amount = Number(item.amount ?? item.award_amount ?? 0);
  const domainHint = companyDomain ? hay.includes(companyDomain.split(".")[0].toLowerCase()) : false;
  return Math.min(100, termHits * 18 + (amount > 1_000_000 ? 18 : amount > 100_000 ? 10 : 0) + (domainHint ? 20 : 0));
}

export async function buildGovContractFitBrief(options: ContractFitOptions = {}) {
  const keyword = cleanText(options.keyword, "cybersecurity");
  const agency = cleanText(options.agency) || undefined;
  const companyDomain = cleanText(options.company_domain) || undefined;
  const limit = clampInt(options.limit, 12, 5, 50);
  let rows: any[] = [];
  let success = true;
  let source = "USAspending.gov search/spending_by_award";
  try {
    rows = await searchContractAwards(keyword, agency, limit);
  } catch {
    const raw = await searchFederalContracts(keyword, agency, limit) as any;
    rows = Array.isArray(raw?.data) ? raw.data : [];
    success = raw?.success ?? false;
    source = raw?.meta?.source ?? "USAspending.gov";
  }
  const matches = rows.map((row: any) => ({ ...row, fit_score: scoreContractFit(row, keyword, companyDomain) }))
    .sort((a: any, b: any) => b.fit_score - a.fit_score)
    .slice(0, 10);
  const best = matches[0]?.fit_score ?? 0;
  return {
    product: "Government Contract Fit Brief",
    generated_at: new Date().toISOString(),
    query: { keyword, agency: agency ?? null, company_domain: companyDomain ?? null },
    summary: {
      awards_checked: rows.length,
      best_fit_score: best,
      verdict: best >= 70 ? "strong_fit" : best >= 40 ? "possible_fit" : rows.length ? "weak_fit" : "no_awards_found",
    },
    top_matches: matches,
    buyer_read: matches.slice(0, 3).map((row: any) => `${row.agency || "Agency"} paid ${row.recipient || "a vendor"} $${Number(row.amount ?? 0).toLocaleString("en-US")} for ${String(row.description ?? "contract work").slice(0, 140)}.`),
    next_actions: [
      "Use the winning recipients as incumbent targets or partner research.",
      "Search the same agency plus narrower service terms before outreach.",
      "Treat this as opportunity research, not a guarantee of open solicitation status.",
    ],
    raw_source_status: { success, source },
  };
}

async function fetchFederalRegisterRows(query: string, agency: string | undefined, limit: number) {
  const params = new URLSearchParams({ per_page: String(limit), order: "newest" });
  params.set("conditions[term]", query);
  if (agency?.trim()) params.append("conditions[agencies][]", agency.trim().toLowerCase());
  const data = await fetchJsonAny(`https://www.federalregister.gov/api/v1/documents.json?${params.toString()}`, { timeoutMs: 12000 });
  return (data?.results ?? []).map((d: any) => ({
    title: d.title ?? "",
    document_number: d.document_number ?? null,
    type: d.type ?? null,
    publication_date: d.publication_date ?? null,
    agencies: (d.agencies ?? []).map((a: any) => a?.name ?? a?.raw_name ?? "").filter(Boolean),
    abstract: (d.abstract ?? "").slice(0, 1000),
    html_url: d.html_url ?? "",
    pdf_url: d.pdf_url ?? "",
    comment_url: d.comments_url ?? null,
  }));
}

const SECTOR_TERMS: Record<string, string> = {
  crypto: "crypto digital assets stablecoin blockchain token exchange",
  ai: "artificial intelligence model automated decision algorithm",
  banking: "bank capital liquidity consumer finance payments",
  healthcare: "healthcare drug device Medicare FDA patient",
  energy: "energy oil gas electric grid emissions",
  privacy: "privacy data broker cybersecurity breach personal data",
};

export async function buildRegulatoryImpactBrief(options: RegulatoryImpactOptions = {}) {
  const sector = cleanText(options.sector, "crypto").toLowerCase();
  const agency = cleanText(options.agency) || undefined;
  const jurisdiction = cleanText(options.jurisdiction, "US");
  const hours = clampInt(options.hours, 72, 6, 720);
  const limit = clampInt(options.limit, 10, 5, 25);
  const query = sector;
  let registerRows: any[] = [];
  let regsRows: any[] = [];
  let registerOk = true;
  let regsOk = true;
  try {
    registerRows = await fetchFederalRegisterRows(query, agency, limit);
  } catch {
    const registerRaw = await searchFederalRegister(query, agency, undefined) as any;
    registerRows = Array.isArray(registerRaw?.data?.results) ? registerRaw.data.results : [];
    registerOk = registerRaw?.success ?? false;
  }
  try {
    const regsRaw = await searchRegulations(query, "open") as any;
    regsRows = Array.isArray(regsRaw?.data?.results) ? regsRaw.data.results : [];
    regsOk = regsRaw?.success ?? false;
  } catch {
    regsOk = false;
  }
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const recentRegister = registerRows.filter((row: any) => {
    const t = Date.parse(row.publication_date ?? row.posted_date ?? "");
    return Number.isFinite(t) ? t >= cutoff : true;
  }).slice(0, limit);
  const combined = [...recentRegister, ...regsRows.slice(0, Math.max(0, limit - recentRegister.length))].slice(0, limit);
  const severeTerms = ["enforcement", "penalty", "prohibit", "risk", "fraud", "sanction", "final rule", "approval", "denial"];
  const scored = combined.map((row: any) => {
    const text = `${row.title ?? ""} ${row.abstract ?? ""} ${row.description ?? ""}`.toLowerCase();
    const severity = severeTerms.reduce((sum, term) => sum + (text.includes(term) ? 15 : 0), 10);
    return {
      title: row.title ?? row.document_id ?? "Untitled regulatory item",
      agency: row.agencies?.[0] ?? row.agency ?? null,
      type: row.type ?? row.document_type ?? null,
      date: row.publication_date ?? row.posted_date ?? null,
      url: row.html_url ?? row.comment_url ?? row.url ?? row.pdf_url ?? null,
      summary: String(row.abstract ?? row.description ?? "").slice(0, 360),
      severity_score: Math.min(100, severity),
    };
  }).sort((a, b) => b.severity_score - a.severity_score);
  const top = scored[0]?.severity_score ?? 0;
  return {
    product: "Regulatory Impact Brief",
    generated_at: new Date().toISOString(),
    query: { sector, jurisdiction, agency: agency ?? null, hours },
    summary: {
      items_checked: combined.length,
      top_severity_score: top,
      verdict: top >= 70 ? "high_attention" : top >= 40 ? "monitor" : combined.length ? "low_signal" : "no_recent_items_found",
    },
    items: scored,
    buyer_read: scored.slice(0, 3).map((row) => `${row.agency || "Agency"}: ${row.title}`),
    next_actions: [
      "Open the source item before legal or trading decisions.",
      "Rerun with a narrower sector term if results are too broad.",
      "Pair this with SEC and prediction-market routes when the sector has public-market exposure.",
    ],
    raw_source_status: {
      federal_register: registerOk,
      regulations: regsOk,
    },
  };
}
