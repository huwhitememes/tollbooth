/**
 * Security & Vulnerability Intelligence Products — Tollbooth x402 MCP
 *
 * Free / keyless sources:
 * - NIST NVD (National Vulnerability Database) — keyless, 5 req/30s
 * - OpenCorporates (company registration data) — free tier
 *
 * All functions return { success, data, cached, meta: { count, source, generated_at } }
 * and handle errors gracefully.
 */

// ─── Constants ───────────────────────────────────────────────────────────

const NVD_API = "https://services.nvd.nist.gov/rest/json/cves/2.0";
const OPENCORP_API = "https://api.opencorporates.com/v0.4";

const USER_AGENT = "TollboothBot/1.0 SecIntel/0.9";

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
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 12000);
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

// ─── 1. searchCVEs — NIST NVD CVE Search ─────────────────────────────────

export async function searchCVEs(
  keyword?: string,
  cve_id?: string,
  severity?: string,
  limit?: number
) {
  const source = "NIST NVD CVE API (services.nvd.nist.gov)";
  try {
    const lim = clamp(Math.trunc(limit ?? 20), 1, 100);

    const params = new URLSearchParams();

    if (cve_id?.trim()) {
      params.set("cveId", cve_id.trim().toUpperCase());
    } else if (keyword?.trim()) {
      params.set("keywordSearch", keyword.trim());
    } else {
      // No keyword or CVE ID — get most recent
      params.set("resultsPerPage", String(lim));
    }

    // Severity filter
    if (severity?.trim()) {
      const sev = severity.trim().toUpperCase();
      if (sev === "CRITICAL" || sev === "HIGH" || sev === "MEDIUM" || sev === "LOW") {
        params.set("cvssV3Severity", sev);
      }
    }

    params.set("resultsPerPage", String(lim));

    const data = await fetchJson(`${NVD_API}?${params.toString()}`, {
      timeoutMs: 15000,
    });

    const vulns: any[] = data?.vulnerabilities ?? [];

    const results = vulns.slice(0, lim).map((v: any) => {
      const cve = v?.cve ?? {};
      const descriptions: any[] = cve?.descriptions ?? [];
      const enDesc = descriptions.find((d) => d?.lang === "en");

      // Extract CVSS metrics
      const metrics = cve?.metrics ?? {};
      const cvssV31 = metrics?.cvssMetricV31?.[0]?.cvssData ?? null;
      const cvssV30 = metrics?.cvssMetricV30?.[0]?.cvssData ?? null;
      const cvss = cvssV31 ?? cvssV30;

      // Extract affected products (CPE)
      const configurations: any[] = cve?.configurations ?? [];
      const affectedProducts: string[] = [];
      for (const config of configurations) {
        for (const node of config?.nodes ?? []) {
          for (const cpeMatch of node?.cpeMatch ?? []) {
            if (cpeMatch?.criteria) {
              affectedProducts.push(cpeMatch.criteria);
            }
          }
        }
      }

      // Extract references
      const references: any[] = (cve?.references ?? []).slice(0, 5).map((ref: any) => ({
        url: ref?.url ?? "",
        source: ref?.source ?? null,
        tags: ref?.tags ?? [],
      }));

      return {
        cve_id: cve?.id ?? null,
        description: (enDesc?.value ?? "").slice(0, 1000),
        published: cve?.published ?? null,
        last_modified: cve?.lastModified ?? null,
        cvss_score: cvss?.baseScore ?? null,
        cvss_severity: cvss?.baseSeverity ?? null,
        cvss_vector: cvss?.vectorString ?? null,
        affected_products: Array.from(new Set(affectedProducts)).slice(0, 20),
        references,
        cwe: cve?.weaknesses?.[0]?.description?.[0]?.value ?? null,
        status: cve?.vulnStatus ?? null,
      };
    });

    return ok(
      {
        keyword_filter: keyword ?? null,
        cve_id_filter: cve_id ?? null,
        severity_filter: severity ?? null,
        total: data?.totalResults ?? results.length,
        results,
      },
      source,
      results.length
    );
  } catch (e: any) {
    return fail(e?.message ?? String(e), source);
  }
}

// ─── 2. searchCompanies — OpenCorporates Company Search ─────────────────

export async function searchCompanies(
  query: string,
  jurisdiction?: string,
  limit?: number
) {
  const source = "OpenCorporates API (api.opencorporates.com)";
  try {
    const q = (query ?? "").trim();
    if (!q) return fail("query is required", source);

    const lim = clamp(Math.trunc(limit ?? 10), 1, 30);

    const params = new URLSearchParams({
      q,
      per_page: String(lim),
    });
    if (jurisdiction?.trim()) {
      params.set("jurisdiction_code", jurisdiction.trim().toLowerCase());
    }

    // OpenCorporates free tier — no API key needed for basic searches
    const apiKey =
      (typeof process !== "undefined" &&
        (process as any).env?.OPENCORPORATES_API_KEY) ||
      null;
    if (apiKey) params.set("api_token", apiKey);

    const data = await fetchJson(
      `${OPENCORP_API}/companies/search?${params.toString()}`,
      { timeoutMs: 12000 }
    );

    const companies: any[] = data?.results?.companies ?? [];

    const results = companies.map((c: any) => {
      const co = c?.company ?? {};
      return {
        name: co?.name ?? "",
        company_number: co?.company_number ?? null,
        jurisdiction: co?.jurisdiction_code ?? null,
        jurisdiction_name: co?.jurisdiction_name ?? null,
        company_type: co?.company_type ?? null,
        status: co?.current_status ?? null,
        incorporation_date: co?.incorporation_date ?? null,
        dissolution_date: co?.dissolution_date ?? null,
        registered_address: co?.registered_address_in_full ?? null,
        registered_agent: co?.registered_agent_name ?? null,
        industry_codes: (co?.industry_codes ?? []).map((ic: any) => ({
          code: ic?.industry_code?.code ?? "",
          description: ic?.industry_code?.description ?? "",
        })),
        officers_count: co?.officer_count ?? null,
        url: co?.registry_url ?? null,
        source: co?.source?.publisher ?? null,
      };
    });

    return ok(
      {
        query: q,
        jurisdiction_filter: jurisdiction ?? null,
        total: data?.results?.total_count ?? results.length,
        page: data?.results?.page ?? 1,
        results,
      },
      source,
      results.length
    );
  } catch (e: any) {
    return fail(e?.message ?? String(e), source);
  }
}
