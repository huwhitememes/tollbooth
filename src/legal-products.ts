/**
 * Legal & Regulatory Intelligence Products — Tollbooth x402 MCP
 *
 * Public-domain / free-key government and legal data sources:
 * - CourtListener (Free Law Project) — keyless V4 REST API
 * - Federal Register (federalregister.gov) — keyless public API
 * - regulations.gov — requires free API key; graceful fallback to Federal Register
 * - Google Patents — keyless xhr endpoint
 *
 * All functions return { success, data, cached, meta: { count, source, generated_at } }
 * and handle errors gracefully (return { success: false, error } on failure).
 */

// ——— Constants ———

const COURT_LISTENER = "https://www.courtlistener.com/api/rest/v4";
const FEDERAL_REGISTER = "https://www.federalregister.gov/api/v1";
const REGULATIONS_GOV = "https://api.regulations.gov/v4";
const GOOGLE_PATENTS = "https://patents.google.com/xhr/query";

const USER_AGENT = "TollboothBot/1.0 LegalIntel/0.9";

// ——— Helpers ———

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
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
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

async function fetchText(
  url: string,
  timeoutMs = 8000
): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return await r.text();
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
      count: count ?? (Array.isArray(data) ? data.length : data?.results?.length ?? 0),
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

// ——— 1. searchCourtOpinions — CourtListener V4 Search ———

export async function searchCourtOpinions(
  query: string,
  court?: string,
  days_back?: number
) {
  const source = "CourtListener V4 API (Free Law Project)";
  try {
    const q = (query ?? "").trim();
    if (!q) return fail("query is required", source);

    const params = new URLSearchParams({ q });
    if (court) params.set("court", court);
    if (days_back && days_back > 0) {
      const cutoff = new Date(Date.now() - days_back * 86400000)
        .toISOString()
        .slice(0, 10);
      params.set("filed_after", cutoff);
    }
    params.set("order_by", "score desc");
    params.set("type", "o"); // opinions

    const data = await fetchJson(
      `${COURT_LISTENER}/search/?${params.toString()}`
    );

    const results: any[] = (data?.results ?? []).map((r: any) => ({
      id: r.id ?? null,
      case_name: r.caseName ?? r.case_name ?? "",
      date_filed: r.dateFiled ?? r.date_filed ?? null,
      court: r.court ?? null,
      citation: r.citation?.[0] ?? null,
      judge: r.judge ?? null,
      disposition: (r.disposition ?? "").slice(0, 500),
      snippet: (r.snippet ?? "").slice(0, 800),
      url:
        r.absolute_url ??
        (r.cluster_id
          ? `https://www.courtlistener.com/opinion/${r.cluster_id}/`
          : ""),
      score: r.score ?? null,
    }));

    return ok(
      {
        query: q,
        court_filter: court ?? null,
        days_back: days_back ?? null,
        total: data?.count ?? results.length,
        results,
      },
      source,
      results.length
    );
  } catch (e: any) {
    return fail(e?.message ?? String(e), source);
  }
}

// ——— 2. lookupCourtDocket — CourtListener RECAP ———

export async function lookupCourtDocket(docket_id: string) {
  const source = "CourtListener RECAP API (Free Law Project)";
  try {
    const id = String(docket_id ?? "").trim();
    if (!id) return fail("docket_id is required", source);

    const data = await fetchJson(`${COURT_LISTENER}/dockets/${id}/`);

    const entries: any[] = (data?.docket_entries ?? []).slice(0, 50).map(
      (e: any) => ({
        entry_number: e.entry_number ?? null,
        date_filed: e.date_filed ?? null,
        description: (e.description ?? "").slice(0, 500),
        short_description: e.short_description ?? null,
        document_url: e.entry_number
          ? `https://www.courtlistener.com/docket/${id}/${e.entry_number}/`
          : "",
      })
    );

    const docket = {
      id: data?.id ?? id,
      case_name: data?.case_name ?? "",
      date_filed: data?.date_filed ?? null,
      date_terminated: data?.date_terminated ?? null,
      court: data?.court ?? null,
      nature_of_suit: data?.nature_of_suit ?? null,
      cause: data?.cause ?? null,
      parties: (data?.parties ?? [])
        .slice(0, 20)
        .map((p: any) => ({
          name: p?.name ?? "",
          party_type:
            (p?.attorneys?.[0]?.roles ?? [p?.party_type])[0] ?? null,
          attorneys: (p?.attorneys ?? [])
            .slice(0, 5)
            .map((a: any) => a?.name ?? "")
            .filter(Boolean),
        })),
      docket_entries: entries,
      entry_count: data?.docket_entries?.length ?? 0,
    };

    return ok(docket, source, 1);
  } catch (e: any) {
    return fail(e?.message ?? String(e), source);
  }
}

// ——— 3. searchFederalRegister — federalregister.gov ———

export async function searchFederalRegister(
  query: string,
  agency?: string,
  type?: string
) {
  const source = "Federal Register API (federalregister.gov)";
  try {
    const q = (query ?? "").trim();
    if (!q) return fail("query is required", source);

    const params = new URLSearchParams();
    const conditions: string[] = [];
    if (q) conditions.push(`term:${q}`);
    if (agency) conditions.push(`agencies:${agency}`);
    if (type) conditions.push(`type:${type}`);
    params.set("conditions", conditions.join(" AND "));

    const data = await fetchJson(
      `${FEDERAL_REGISTER}/documents.json?${params.toString()}`
    );

    const results: any[] = (data?.results ?? []).map((d: any) => ({
      title: d.title ?? "",
      document_number: d.document_number ?? null,
      type: d.type ?? null,
      publication_date: d.publication_date ?? null,
      agencies: (d.agencies ?? [])
        .map((a: any) => a?.name ?? a?.raw_name ?? "")
        .filter(Boolean),
      agency_slugs: (d.agencies ?? [])
        .map((a: any) => a?.slug ?? null)
        .filter(Boolean),
      abstract: (d.abstract ?? "").slice(0, 1000),
      html_url: d.html_url ?? "",
      pdf_url: d.pdf_url ?? "",
      citation: d.citation ?? null,
      regulatory_id_numbers: d.regulation_id_numbers ?? [],
      significant: d.significant ?? false,
      topics: (d.topics ?? []).slice(0, 15),
      excerpts: d.excerpts ?? null,
    }));

    return ok(
      {
        query: q,
        agency_filter: agency ?? null,
        type_filter: type ?? null,
        total: data?.count ?? results.length,
        results,
      },
      source,
      results.length
    );
  } catch (e: any) {
    return fail(e?.message ?? String(e), source);
  }
}

// ——— 4. searchRegulations — regulations.gov with graceful fallback ———

export async function searchRegulations(
  query: string,
  status?: string
) {
  const source = "Regulations.gov API (fallback: Federal Register)";
  try {
    const q = (query ?? "").trim();
    if (!q) return fail("query is required", source);

    // Check for API key in env — regulations.gov requires a free key
    const apiKey =
      (typeof process !== "undefined" &&
        (process as any).env?.REGULATIONS_GOV_API_KEY) ||
      null;

    if (apiKey) {
      try {
        const params = new URLSearchParams({
          "api_key": apiKey,
          "search": q,
        });
        if (status) params.set("status", status);

        const data = await fetchJson(
          `${REGULATIONS_GOV}/regulations?${params.toString()}`
        );

        const results: any[] = (data?.data ?? []).map((d: any) => ({
          id: d.id ?? null,
          document_id: d.attributes?.documentId ?? d.id ?? null,
          title: d.attributes?.title ?? "",
          type: d.attributes?.documentType ?? null,
          agency: d.attributes?.agencyId ?? null,
          status: d.attributes?.status ?? null,
          posted_date: d.attributes?.postedDate ?? null,
          due_date: d.attributes?.commentDueDate ?? null,
          url: d.links?.self ?? "",
        }));

        return ok(
          {
            query: q,
            status_filter: status ?? null,
            source_detail: "regulations.gov v4 (keyed)",
            total: data?.meta?.total ?? results.length,
            results,
          },
          source,
          results.length
        );
      } catch {
        // fall through to Federal Register fallback
      }
    }

    // ——— Graceful fallback: search Federal Register instead ———
    const frParams = new URLSearchParams();
    const conditions: string[] = [`term:${q}`];
    if (status === "posted" || status === "open") {
      // narrow to recent 90 days as approximation for "open" comments
      const cutoff = new Date(Date.now() - 90 * 86400000)
        .toISOString()
        .slice(0, 10);
      conditions.push(`publication_date>=${cutoff}`);
    }
    frParams.set("conditions", conditions.join(" AND "));
    frParams.set("order", "newest");

    const frData = await fetchJson(
      `${FEDERAL_REGISTER}/documents.json?${frParams.toString()}`
    );

    const results: any[] = (frData?.results ?? []).map((d: any) => ({
      title: d.title ?? "",
      document_number: d.document_number ?? null,
      type: d.type ?? null,
      publication_date: d.publication_date ?? null,
      agencies: (d.agencies ?? [])
        .map((a: any) => a?.name ?? "")
        .filter(Boolean),
      abstract: (d.abstract ?? "").slice(0, 1000),
      html_url: d.html_url ?? "",
      pdf_url: d.pdf_url ?? "",
      comment_url: d.comments_url ?? null,
    }));

    return ok(
      {
        query: q,
        status_filter: status ?? null,
        source_detail:
          "Federal Register fallback (no regulations.gov API key configured)",
        fallback_reason:
          "Regulations.gov v4 requires a free API key (https://api.data.gov/signup/). Set REGULATIONS_GOV_API_KEY to enable direct regulations.gov queries.",
        total: frData?.count ?? results.length,
        results,
      },
      source,
      results.length
    );
  } catch (e: any) {
    return fail(e?.message ?? String(e), source);
  }
}

// ——— 5. searchPatents — Google Patents (keyless xhr endpoint) ———

export async function searchPatents(query: string, limit?: number) {
  const source = "Google Patents (xhr/query)";
  try {
    const q = (query ?? "").trim();
    if (!q) return fail("query is required", source);

    const maxResults = clamp(Math.trunc(limit ?? 20), 1, 100);

    // Google Patents xhr endpoint — url param is itself a query string
    const innerUrl = `q=${encodeURIComponent(q)}&num=${maxResults}`;
    const url = `${GOOGLE_PATENTS}?url=${encodeURIComponent(
      innerUrl
    )}&exp=`;

    const data = await fetchJson(url);

    // Parse the clustered result structure
    const cluster: any[] = data?.results?.cluster ?? [];
    const results: any[] = cluster.slice(0, maxResults).map((item: any) => {
      const p = item?.result ?? {};
      return {
        patent_id: p?.patent?.publication_number ?? null,
        title: p?.patent?.title ?? item?.patent?.title ?? "",
        snippet: (p?.patent?.snippet ?? "").slice(0, 800),
        publication_date: p?.patent?.publication_date ?? null,
        filing_date: p?.patent?.filing_date ?? null,
        grant_date: p?.patent?.grant_date ?? null,
        inventor: (p?.patent?.inventor ?? [])
          .map((inv: any) => inv?.name ?? "")
          .filter(Boolean)
          .slice(0, 10),
        assignee: (p?.patent?.assignee ?? [])
          .map((a: any) => a?.name ?? "")
          .filter(Boolean)
          .slice(0, 10),
        classification_cpc: (p?.patent?.cpc ?? [])
          .map((c: any) => c?.code ?? "")
          .filter(Boolean)
          .slice(0, 10),
        abstract: (p?.patent?.abstract ?? "").slice(0, 1500),
        url: p?.patent?.publication_number
          ? `https://patents.google.com/patent/${p.patent.publication_number}`
          : "",
        figures: p?.patent?.figures ?? [],
      };
    });

    return ok(
      {
        query: q,
        limit: maxResults,
        total: results.length,
        results,
      },
      source,
      results.length
    );
  } catch (e: any) {
    return fail(e?.message ?? String(e), source);
  }
}

// ——— 6. searchJudges — CourtListener V4 People API ———

export async function searchJudges(query: string, court?: string) {
  const source = "CourtListener V4 People API (Free Law Project)";
  try {
    const q = (query ?? "").trim();
    if (!q) return fail("query is required", source);

    const params = new URLSearchParams();
    params.set("q", q);
    if (court) params.set("court", court);

    const data = await fetchJson(
      `${COURT_LISTENER}/people/?${params.toString()}`
    );

    const results: any[] = (data?.results ?? []).map((p: any) => ({
      id: p.id ?? null,
      name: `${p.name_first ?? ""} ${p.name_last ?? ""}`.trim(),
      name_first: p.name_first ?? "",
      name_last: p.name_last ?? "",
      name_suffix: p.name_suffix ?? null,
      gender: p.gender ?? null,
      race: p.race ?? [],
      dob: p.dob ?? null,
      dod: p.dod ?? null,
      court: p?.positions?.[0]?.court?.short_name ??
        p?.positions?.[0]?.court?.full_name ??
        court ??
        null,
      appointment_date: p?.positions?.[0]?.date_start ?? null,
      positions: (p?.positions ?? []).slice(0, 10).map((pos: any) => ({
        court: pos?.court?.short_name ?? pos?.court?.full_name ?? "",
        court_id: pos?.court?.id ?? null,
        position_type: pos?.position_type ?? null,
        date_start: pos?.date_start ?? null,
        date_end: pos?.date_end ?? null,
        appointer: pos?.appointer?.[0]?.person?.name_first
          ? `${pos.appointer[0].person.name_first} ${pos.appointer[0].person.name_last ?? ""}`.trim()
          : null,
        nomination_process: pos?.nomination_process ?? null,
        selection_method: pos?.how_selected ?? null,
      })),
      education: (p?.educations ?? []).map((edu: any) => ({
        school: edu?.school?.name ?? "",
        degree: edu?.degree ?? "",
        degree_level: edu?.degree_detail ?? null,
        start_year: edu?.start_year ?? null,
        end_year: edu?.end_year ?? null,
      })),
      political_affiliations: (p?.political_affiliations ?? []).map((aff: any) => ({
        party: aff?.political_party ?? "",
        source: aff?.source ?? null,
        date_start: aff?.date_start ?? null,
        date_end: aff?.date_end ?? null,
      })),
      url: p.id
        ? `https://www.courtlistener.com/person/${p.id}/${(p.name_last ?? "").toLowerCase()}-${(p.name_first ?? "").toLowerCase()}/`
        : "",
    }));

    return ok(
      {
        query: q,
        court_filter: court ?? null,
        total: data?.count ?? results.length,
        results,
      },
      source,
      results.length
    );
  } catch (e: any) {
    return fail(e?.message ?? String(e), source);
  }
}

// ——— 7. searchTrademarks — USPTO Trademark Search ———

export async function searchTrademarks(query: string, owner?: string) {
  const source = "USPTO Trademark Search (developer.uspto.gov)";
  try {
    const q = (query ?? "").trim();
    if (!q) return fail("query is required", source);

    const params = new URLSearchParams();
    params.set("searchText", q);
    if (owner?.trim()) {
      params.set("owner", owner.trim());
    }

    const data = await fetchJson(
      `https://developer.uspto.gov/api/v1/trademarks?${params.toString()}`,
      { timeoutMs: 12000 }
    );

    const raw: any[] = data?.trademarks ?? data?.results ?? data ?? [];

    const results: any[] = (Array.isArray(raw) ? raw : []).map((t: any) => ({
      serial_number: t?.serialNumber ?? t?.serial_number ?? null,
      registration_number: t?.registrationNumber ?? t?.registration_number ?? null,
      mark_name: t?.trademarkName ?? t?.mark_name ?? t?.mark ?? "",
      mark_type: t?.trademarkType ?? t?.mark_type ?? null,
      owner: t?.ownerName ?? t?.owner ?? t?.currentOwner ?? "",
      status: t?.statusType ?? t?.status ?? t?.registrationStatus ?? "",
      status_date: t?.statusDate ?? t?.registrationDate ?? null,
      filing_date: t?.filingDate ?? t?.applicationDate ?? null,
      registration_date: t?.registrationDate ?? t?.registration_date ?? null,
      expiration_date: t?.expirationDate ?? t?.renewalDate ?? null,
      class_codes: t?.classNumbers ?? t?.internationalClass ?? [],
      attorney: t?.attorneyName ?? t?.attorney ?? null,
      url: t?.serialNumber ?? t?.serial_number
        ? `https://tsdr.uspto.gov/#caseNumber=${t.serialNumber ?? t.serial_number}&caseType=DEFAULT&caseSearchType=US_APPLICATION`
        : "",
    }));

    return ok(
      {
        query: q,
        owner_filter: owner ?? null,
        total: data?.totalFound ?? data?.count ?? results.length,
        results,
      },
      source,
      results.length
    );
  } catch (e: any) {
    return fail(e?.message ?? String(e), source);
  }
}
