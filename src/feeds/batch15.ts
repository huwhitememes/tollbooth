// batch15.ts — keyless B2B feeds: EU VIES VAT, UN Comtrade, ECB FX, World Bank, Wikipedia pageviews
// All sources verified live 2026-10-24. No API keys required.

const UA = "TollboothBot/1.0 (agenttoll.dev)";

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json", ...(init?.headers ?? {}) },
      signal: ctrl.signal,
      ...(init ?? {}),
    } as any);
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// ── 1. EU VAT validation (official VIES REST) ──────────────────────────
export async function vatValidate(countryCode: string, vatNumber: string) {
  const cc = countryCode.trim().toUpperCase();
  const vn = vatNumber.trim().replace(new RegExp(`^${cc}`), "");
  if (cc.length !== 2 || !vn) throw new Error("country_code (2 letters) and vat_number required");
  const data = await fetchJson("https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ countryCode: cc, vatNumber: vn }),
  });
  return {
    valid: data.valid === true,
    country_code: cc,
    vat_number: vn,
    name: data.name || null,
    address: data.address || null,
    request_identifier: data.requestIdentifier || null,
    consulted_at: data.requestDate || new Date().toISOString(),
    source: "EU VIES (ec.europa.eu)",
  };
}

// ── 2. UN Comtrade trade flows ─────────────────────────────────────────
export async function tradeFlows(opts: {
  reporter_code: string; partner_code?: string; flow_code?: string; cmd_code: string; period?: number;
}) {
  const reporter = opts.reporter_code.trim();
  const cmd = opts.cmd_code.trim();
  const period = opts.period ?? new Date().getUTCFullYear() - 1;
  const flow = (opts.flow_code ?? "M").toUpperCase();
  const partner = opts.partner_code ?? "0";
  const url = `https://comtradeapi.un.org/public/v1/preview/C/A/HS?reporterCode=${encodeURIComponent(reporter)}&period=${period}&cmdCode=${encodeURIComponent(cmd)}&flowCode=${encodeURIComponent(flow)}&partnerCode=${encodeURIComponent(partner)}`;
  const data = await fetchJson(url);
  const rows = (data?.data ?? []).slice(0, 100).map((r: any) => ({
    reporter: r.reporterDesc ?? r.reporterISO ?? r.reporterCode,
    partner: r.partnerDesc ?? r.partnerISO ?? r.partnerCode ?? "World",
    flow: r.flowDesc ?? r.flowCode,
    commodity_code: r.cmdCode,
    year: r.primaryValue ?? r.period,
    period: r.period,
    trade_value_usd: r.primaryValue,
    net_weight_kg: r.netWgt ?? null,
    gross_weight_kg: r.grossWgt ?? null,
  }));
  return {
    count: data?.count ?? rows.length,
    note: "UN Comtrade public preview tier — up to 500 records per call, no key required.",
    rows,
    source: "UN Comtrade (comtradeapi.un.org)",
  };
}

// ── 3. ECB reference FX via Frankfurter ────────────────────────────────
export async function fxEcbLatest(opts: { base?: string; symbols?: string; date?: string }) {
  const base = (opts.base ?? "USD").trim().toUpperCase();
  const symbols = opts.symbols?.trim();
  const date = opts.date?.trim();
  let url: string;
  if (date) url = `https://api.frankfurter.dev/v1/${date}?base=${encodeURIComponent(base)}${symbols ? `&symbols=${encodeURIComponent(symbols)}` : ""}`;
  else url = `https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(base)}${symbols ? `&symbols=${encodeURIComponent(symbols)}` : ""}`;
  const data = await fetchJson(url);
  return {
    base: data.base,
    date: data.date,
    rates: data.rates,
    source: "European Central Bank reference rates via Frankfurter (api.frankfurter.dev)",
  };
}

// ── 4. World Bank indicators ───────────────────────────────────────────
export async function worldBankIndicator(opts: { country: string; indicator: string; date?: string; per_page?: number }) {
  const country = encodeURIComponent(opts.country.trim());
  const indicator = encodeURIComponent(opts.indicator.trim());
  const perPage = Math.min(Math.max(opts.per_page ?? 10, 1), 50);
  let url = `https://api.worldbank.org/v2/country/${country}/indicator/${indicator}?format=json&per_page=${perPage}`;
  if (opts.date) url += `&date=${encodeURIComponent(opts.date)}`;
  const data = await fetchJson(url);
  const meta: any = Array.isArray(data?.[0]) ? data[0] : {};
  const raw: any[] = Array.isArray(data?.[1]) ? data[1] : [];
  const rows = raw.map((r: any) => ({
    country: r.country?.value,
    country_code: r.countryiso3code,
    indicator: r.indicator?.value,
    date: r.date,
    value: r.value,
  }));
  return {
    total: meta.total ?? rows.length,
    rows,
    source: "World Bank API (api.worldbank.org)",
  };
}

// ── 5. Wikipedia pageviews ─────────────────────────────────────────────
export async function wikiTopPageviews(opts: { project?: string; article?: string; granularity?: string; start: string; end: string }) {
  const project = opts.project?.trim() || "en.wikipedia";
  const granularity = opts.granularity === "monthly" ? "monthly" : "daily";
  const start = opts.start.trim();
  const end = opts.end.trim();
  if (!/^\d{8}$/.test(start) || !/^\d{8}$/.test(end)) throw new Error("start and end must be YYYYMMDD");
  if (opts.article) {
    const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${encodeURIComponent(project)}/all-access/user/${encodeURIComponent(opts.article.replace(/ /g, "_"))}/${granularity}/${start}/${end}`;
    const data = await fetchJson(url);
    const items = (data?.items ?? []).map((i: any) => ({ date: i.timestamp, views: i.views }));
    const totalViews = items.reduce((s: number, i: any) => s + (i.views ?? 0), 0);
    return { project, article: opts.article, granularity, period: { start, end }, total_views: totalViews, items, source: "Wikimedia REST API" };
  }
  // no article → top 100 for the end date (per-article requires article; top requires daily + single day)
  const day = end;
  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/${encodeURIComponent(project)}/all-access/${day}`;
  const data = await fetchJson(url);
  const items = (data?.items?.[0]?.articles ?? []).slice(0, 100).map((a: any) => ({ article: a.article, views: a.views, rank: a.rank }));
  return { project, date: day, top_count: items.length, items, source: "Wikimedia REST API" };
}
