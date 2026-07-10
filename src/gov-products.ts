/**
 * Government Spending & Contract Intelligence — data products for x402 paid tools.
 *
 * Sources (all free / public government APIs):
 * - USAspending.gov (federal award/contract search, POST, keyless)
 * - Treasury FiscalData (national debt, keyless)
 * - Grants.gov (federal grant search, keyless)
 * - FEC lobbying (Senate LD-2 fallback, DEMO_KEY)
 * - ProPublica Nonprofit Explorer (IRS 990 filings, keyless)
 * - World Bank (economic indicators, keyless)
 *
 * Each function returns { success, data, cached, meta: { count, source, generated_at } }.
 */

// ─── helpers ─────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

async function fetchJson(
  url: string,
  opts: RequestInit & { timeoutMs?: number } = {},
): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10000);
  try {
    const r = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "TollboothBot/1.0 GovIntel/0.9",
        ...(opts.headers || {}),
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchText(url: string, timeoutMs = 10000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "TollboothBot/1.0 GovIntel/0.9",
        Accept: "*/*",
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

function meta(count: number, source: string) {
  return { count, source, generated_at: new Date().toISOString() };
}

// ─── 1. searchFederalSpending — USAspending.gov ──────────────────────────

export async function searchFederalSpending(
  agency?: string,
  recipient?: string,
  limit?: number,
): Promise<{ success: boolean; data: any; cached: boolean; meta: { count: number; source: string; generated_at: string } }> {
  const lim = clamp(limit ?? 10, 1, 100);
  const url = "https://api.usaspending.gov/api/v2/search/spending_by_award/";

  const filters: any = {
    award_type_codes: ["A", "B", "C", "D"], // contracts
    time_period: [{ start_month: 1, start_year: new Date().getFullYear() - 1, end_month: 12, end_year: new Date().getFullYear() }],
  };
  if (agency?.trim()) {
    filters.agencies = [{
      type: "awarding",
      tier: "toptier",
      name: agency.trim(),
    }];
  }
  if (recipient?.trim()) {
    filters.recipient_search_text = [recipient.trim()];
  }

  const body = {
    filters,
    fields: ["Award ID", "Recipient Name", "Awarding Agency", "Awarding Sub Agency", "Award Amount", "Start Date", "End Date", "Award Type", "Description"],
    page: 1,
    limit: lim,
    sort: "Award Amount",
    order: "desc",
  };

  try {
    const json = await fetchJson(url, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      timeoutMs: 12000,
    });

    const results = (json?.results ?? []).map((r: any) => ({
      award_id: r["Award ID"] ?? "",
      recipient: r["Recipient Name"] ?? "",
      agency: r["Awarding Agency"] ?? "",
      sub_agency: r["Awarding Sub Agency"] ?? "",
      award_amount: parseFloat(r["Award Amount"]) || 0,
      start_date: r["Start Date"] ?? "",
      end_date: r["End Date"] ?? "",
      award_type: r["Award Type"] ?? "",
      description: (r["Description"] ?? "").slice(0, 400),
    }));

    return {
      success: true,
      data: results,
      cached: false,
      meta: meta(results.length, "USAspending.gov"),
    };
  } catch (e: any) {
    return {
      success: false,
      data: { error: e?.message ?? String(e), url },
      cached: false,
      meta: meta(0, "USAspending.gov"),
    };
  }
}

// ─── 2. getNationalDebt — Treasury FiscalData ────────────────────────────

export async function getNationalDebt(): Promise<{ success: boolean; data: any; cached: boolean; meta: { count: number; source: string; generated_at: string } }> {
  const url = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/debt_to_the_penny/debt_to_the_penny?sort=-record_date&format=json&page[number]=1&page[size]=5";

  try {
    // Try JSON first (newer FiscalData API)
    const json = await fetchJson(url, { timeoutMs: 10000 });
    const results = (json?.data ?? []).map((r: any) => ({
      record_date: r.record_date ?? "",
      debt_held_public: parseFloat(r.debt_held_public_amt) || 0,
      intragov_holdings: parseFloat(r.intragov_hold_amt) || 0,
      total_public_debt: parseFloat(r.tot_pub_debt_out_amt) || 0,
    }));

    return {
      success: true,
      data: results,
      cached: false,
      meta: meta(results.length, "Treasury FiscalData"),
    };
  } catch {
    // Fallback: CSV endpoint
    const csvUrl = "https://api.fiscaldata.treasury.gov/datasets/debt_to_the_penny/debt_to_the_penny.csv";
    try {
      const csv = await fetchText(csvUrl, 10000);
      const lines = csv.trim().split("\n");
      if (lines.length < 2) {
        return { success: false, data: { error: "No data returned" }, cached: false, meta: meta(0, "Treasury FiscalData CSV") };
      }
      const headers = lines[0].split(",");
      const results = lines.slice(1, 6).map((line) => {
        const cols = line.split(",");
        const row: Record<string, string> = {};
        headers.forEach((h, i) => { row[h.trim()] = cols[i]?.trim()?.replace(/"/g, "") ?? ""; });
        return {
          record_date: row["Record Date"] ?? row["record_date"] ?? "",
          debt_held_public: parseFloat(row["Debt Held by the Public Amount"] ?? row["debt_held_public_amt"] ?? "0") || 0,
          intragov_holdings: parseFloat(row["Intragovernmental Holdings Amount"] ?? row["intragov_hold_amt"] ?? "0") || 0,
          total_public_debt: parseFloat(row["Total Public Debt Outstanding Amount"] ?? row["tot_pub_debt_out_amt"] ?? "0") || 0,
        };
      });

      return {
        success: true,
        data: results,
        cached: false,
        meta: meta(results.length, "Treasury FiscalData CSV"),
      };
    } catch (e2: any) {
      return {
        success: false,
        data: { error: e2?.message ?? String(e2), url: csvUrl },
        cached: false,
        meta: meta(0, "Treasury FiscalData CSV"),
      };
    }
  }
}

// ─── 3. searchFederalGrants — Grants.gov ────────────────────────────────

export async function searchFederalGrants(
  query?: string,
  status?: string,
  limit?: number,
): Promise<{ success: boolean; data: any; cached: boolean; meta: { count: number; source: string; generated_at: string } }> {
  const lim = clamp(limit ?? 10, 1, 100);
  const keyword = query?.trim() ?? "";
  const stat = status?.trim()?.toLowerCase() ?? "forecasted,posted";

  let url = `https://api.grants.gov/v1/api/search2?rows=${lim}&sort=lastUpdateDate:desc`;
  if (keyword) url += `&keyword=${encodeURIComponent(keyword)}`;
  if (stat) url += `&status=${encodeURIComponent(stat)}`;

  try {
    const json = await fetchJson(url, { timeoutMs: 10000 });
    const opps = (json?.oppdetails ?? json?.data ?? []);
    const rawResults = Array.isArray(opps) ? opps : (opps?.oppdetails ?? []);
    const results = rawResults.map((o: any) => ({
      opportunity_id: o.opp_id ?? o.opportunityId ?? "",
      number: o.opp_number ?? o.opportunityNumber ?? "",
      title: o.opp_title ?? o.opportunityTitle ?? "",
      agency: o.agency_name ?? o.agencyCode ?? "",
      category: o.opp_category ?? o.fundingInstrumentCategory ?? "",
      posting_date: o.posting_date ?? o.postedDate ?? "",
      close_date: o.close_date ?? o.closeDate ?? "",
      award_ceiling: parseFloat(o.award_ceiling ?? o.awardCeiling ?? "0") || 0,
      award_floor: parseFloat(o.award_floor ?? o.awardFloor ?? "0") || 0,
      estimated_funding: parseFloat(o.estimated_total_program_funding ?? o.estimatedFunding ?? "0") || 0,
      status: o.opportunity_status ?? o.status ?? "",
      description: (o.opp_desc ?? o.description ?? "").slice(0, 400),
    }));

    return {
      success: true,
      data: results,
      cached: false,
      meta: meta(results.length, "Grants.gov"),
    };
  } catch (e: any) {
    return {
      success: false,
      data: { error: e?.message ?? String(e), url },
      cached: false,
      meta: meta(0, "Grants.gov"),
    };
  }
}

// ─── 4. searchLobbyingRecords — FEC lobbying (OpenSecrets fallback) ──────

export async function searchLobbyingRecords(
  lobbyist?: string,
  client?: string,
  year?: number,
): Promise<{ success: boolean; data: any; cached: boolean; meta: { count: number; source: string; generated_at: string } }> {
  const fecKey = process.env.FEC_API_KEY ?? "DEMO_KEY";
  const yr = year && year >= 1998 && year <= new Date().getFullYear() ? year : new Date().getFullYear();

  // Build FEC lobbying query
  const params = new URLSearchParams();
  params.set("api_key", fecKey);
  params.set("per_page", "20");
  params.set("sort", "-lobbying_registrant_name");
  if (client?.trim()) params.set("lobbyist_name", client.trim());
  if (lobbyist?.trim()) params.set("registrant_name", lobbyist.trim());
  params.set("two_year_transaction_period", String(Math.floor(yr / 2) * 2 + (yr % 2 === 0 ? 0 : 1)));

  const url = `https://api.open.fec.gov/v1/lobbying/?${params.toString()}`;

  try {
    const json = await fetchJson(url, { timeoutMs: 10000 });
    const results = (json?.results ?? []).map((r: any) => ({
      filing_id: r.filing_id ?? "",
      registrant_name: r.registrant_name ?? "",
      client_name: r.client_name ?? "",
      lobbyist_name: r.lobbyist_name ?? r.lobbyist?.firstname ?? "",
      year: r.year ?? yr,
      amount: parseFloat(r.income ?? r.amount ?? "0") || 0,
      issue: r.lobbying_activity?.[0]?.general_issue_code ?? "",
      description: (r.lobbying_activity?.[0]?.description ?? "").slice(0, 400),
      report_year: r.report_year ?? yr,
      document_type: r.document_type ?? "",
      senate_id: r.senate_id ?? "",
    }));

    return {
      success: true,
      data: results,
      cached: false,
      meta: meta(results.length, "FEC lobbying (OpenSecrets fallback)"),
    };
  } catch (e: any) {
    return {
      success: false,
      data: { error: e?.message ?? String(e), url, note: "FEC DEMO_KEY has low rate limits; set FEC_API_KEY for production use" },
      cached: false,
      meta: meta(0, "FEC lobbying (OpenSecrets fallback)"),
    };
  }
}

// ─── 5. searchNonprofitFilings — ProPublica Nonprofit Explorer ───────────

export async function searchNonprofitFilings(
  query?: string,
  state?: string,
): Promise<{ success: boolean; data: any; cached: boolean; meta: { count: number; source: string; generated_at: string } }> {
  const q = query?.trim() ?? "";
  if (!q) {
    return {
      success: false,
      data: { error: "query required" },
      cached: false,
      meta: meta(0, "ProPublica Nonprofit Explorer"),
    };
  }

  let url = `https://projects.propublica.org/nonprofits/api/v2/search.json?q=${encodeURIComponent(q)}`;
  // state filter works as part of search: ProPublica supports state[id] param
  if (state?.trim()) {
    url += `&state[id]=${encodeURIComponent(state.trim().toUpperCase())}`;
  }

  try {
    const json = await fetchJson(url, { timeoutMs: 10000 });
    const orgs = (json?.organizations ?? []).map((o: any) => ({
      ein: o.ein ?? "",
      name: o.name ?? "",
      sub_name: o.sub_name ?? "",
      city: o.city ?? "",
      state: o.state ?? "",
      ntee_code: o.ntee_code ?? "",
      classification: o.classification ?? "",
      ruling_year: o.ruling_date ? String(o.ruling_date).slice(0, 4) : "",
      latest_revenue: o.income_amount ?? null,
      latest_assets: o.asset_amount ?? null,
      filing_count: o?.filings_with_data ?? o?.number_filings ?? 0,
    }));

    return {
      success: true,
      data: orgs,
      cached: false,
      meta: meta(orgs.length, "ProPublica Nonprofit Explorer"),
    };
  } catch (e: any) {
    return {
      success: false,
      data: { error: e?.message ?? String(e), url },
      cached: false,
      meta: meta(0, "ProPublica Nonprofit Explorer"),
    };
  }
}

// ─── 6. getEconomicIndicators — World Bank API ───────────────────────────

const COMMON_INDICATORS: Record<string, string> = {
  "gdp": "NY.GDP.MKTP.CD",
  "gdp_growth": "NY.GDP.MKTP.KD.ZG",
  "gdp_per_capita": "NY.GDP.PCAP.CD",
  "inflation": "FP.CPI.TOTL.ZG",
  "unemployment": "SL.UEM.TOTL.ZS",
  "population": "SP.POP.TOTL",
  "debt_to_gdp": "GC.DOD.TOTL.GD.ZS",
  "interest_rate": "FR.INR.RINR",
  "exports": "NE.EXP.GNFS.CD",
  "imports": "NE.IMP.GNFS.CD",
};

export async function getEconomicIndicators(
  country?: string,
  indicator?: string,
): Promise<{ success: boolean; data: any; cached: boolean; meta: { count: number; source: string; generated_at: string } }> {
  const ctry = country?.trim()?.toLowerCase() ?? "us"; // default: USA
  const indRaw = indicator?.trim() ?? "gdp";
  const indCode = COMMON_INDICATORS[indRaw.toLowerCase()] ?? indRaw;

  const url =
    `https://api.worldbank.org/v2/country/${encodeURIComponent(ctry)}/indicator/${encodeURIComponent(indCode)}` +
    `?format=json&per_page=20&date=2015:${new Date().getFullYear()}`;

  try {
    const json = await fetchJson(url, { timeoutMs: 10000 });

    // World Bank returns [metadata, results]
    const arr = Array.isArray(json) && json.length >= 2 ? json[1] : json?.data ?? [];
    const results = (arr ?? []).filter(Boolean).map((r: any) => ({
      year: r.date ?? "",
      value: r.value !== null ? parseFloat(r.value) : null,
      indicator: r.indicator?.value ?? indRaw,
      country: r.country?.value ?? ctry,
      unit: r.indicator?.id ?? "",
    }));

    // Summary
    const latest = results.find((r: any) => r.value !== null) ?? results[0];
    const summary = latest
      ? { latest_year: latest.year, latest_value: latest.value, indicator: latest.indicator, country: latest.country }
      : null;

    return {
      success: true,
      data: { country: ctry, indicator: indRaw, indicator_code: indCode, summary, series: results },
      cached: false,
      meta: meta(results.length, "World Bank API"),
    };
  } catch (e: any) {
    return {
      success: false,
      data: { error: e?.message ?? String(e), url },
      cached: false,
      meta: meta(0, "World Bank API"),
    };
  }
}

// ─── 7. searchFederalContracts — USAspending.gov (contracts only) ───────

export async function searchFederalContracts(
  query?: string,
  agency?: string,
  limit?: number,
): Promise<{ success: boolean; data: any; cached: boolean; meta: { count: number; source: string; generated_at: string } }> {
  const lim = clamp(limit ?? 10, 1, 100);
  const url = "https://api.usaspending.gov/api/v2/search/spending_by_award/";

  // Contract-only award type codes (procurement contracts, not grants/loans)
  const filters: any = {
    award_type_codes: ["A", "B", "C", "D"], // contracts only
    time_period: [
      {
        start_month: 1,
        start_year: new Date().getFullYear() - 1,
        end_month: 12,
        end_year: new Date().getFullYear(),
      },
    ],
  };

  if (agency?.trim()) {
    filters.agencies = [
      { type: "awarding", tier: "toptier", name: agency.trim() },
    ];
  }

  // Keyword search on recipient or description
  if (query?.trim()) {
    filters.keywords = [query.trim()];
  }

  const body = {
    filters,
    fields: [
      "Award ID",
      "Recipient Name",
      "Awarding Agency",
      "Awarding Sub Agency",
      "Award Amount",
      "Start Date",
      "End Date",
      "Award Type",
      "Description",
      "Contract Award Type",
      "recipient_id",
      "prime_award_recipient_id",
    ],
    page: 1,
    limit: lim,
    sort: "Award Amount",
    order: "desc",
  };

  try {
    const json = await fetchJson(url, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      timeoutMs: 12000,
    });

    const results = (json?.results ?? []).map((r: any) => ({
      contract_id: r["Award ID"] ?? "",
      recipient: r["Recipient Name"] ?? "",
      agency: r["Awarding Agency"] ?? "",
      sub_agency: r["Awarding Sub Agency"] ?? "",
      amount: parseFloat(r["Award Amount"]) || 0,
      description: (r["Description"] ?? "").slice(0, 400),
      start_date: r["Start Date"] ?? "",
      end_date: r["End Date"] ?? "",
      award_type: r["Award Type"] ?? "",
      contract_award_type: r["Contract Award Type"] ?? null,
      recipient_id: r["recipient_id"] ?? null,
    }));

    return {
      success: true,
      data: results,
      cached: false,
      meta: meta(results.length, "USAspending.gov (contracts only)"),
    };
  } catch (e: any) {
    return {
      success: false,
      data: { error: e?.message ?? String(e), url },
      cached: false,
      meta: meta(0, "USAspending.gov (contracts only)"),
    };
  }
}
