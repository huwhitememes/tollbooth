/**
 * Academic & Scientific Research Products — Tollbooth x402 MCP
 *
 * Free / keyless academic data sources:
 * - Semantic Scholar Graph API — keyless, rate-limited ~1 req/sec
 * - arXiv Atom API — keyless, community-supported
 * - NCBI PubMed E-utilities — keyless (3 req/sec without key)
 * - ClinicalTrials.gov v2 API — keyless
 * - OpenAlex API — keyless (polite pool with mailto)
 *
 * All functions return { success, data, cached, meta: { count, source, generated_at } }
 * and handle errors gracefully (return { success: false, error } on failure).
 */

// ——— Constants ———

const SEMANTIC_SCHOLAR = "https://api.semanticscholar.org/graph/v1";
const ARXIV_API = "https://export.arxiv.org/api/query";
const PUBMED_ESEARCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const PUBMED_ESUMMARY = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi";
const CLINICAL_TRIALS = "https://clinicaltrials.gov/api/v2/studies";
const OPEN_ALEX = "https://api.openalex.org/works";

const USER_AGENT = "TollboothBot/1.0 AcademicIntel/0.9";

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

// ——— Atom/XML parsing for arXiv (lightweight regex-based, no XML parser needed) ———

function parseAtomEntries(xml: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const entryRe = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1];
    const pick = (tag: string): string => {
      const re = new RegExp(
        `<${tag}[^>]*>([\\s\\S]*?)</${tag}>`,
        "i"
      );
      const hit = re.exec(block);
      if (!hit) return "";
      return hit[1]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/<[^>]+>/g, "")
        .trim();
    };
    const linkMatch = /<link[^>]*href="([^"]+)"[^>]*>/i.exec(block);
    const doiMatch = /<arxiv:doi[^>]*>([^<]+)<\/arxiv:doi>/i.exec(block);
    const catMatchAll = /<category[^>]*term="([^"]+)"[^>]*>/gi;
    const categories: string[] = [];
    let cm: RegExpExecArray | null;
    while ((cm = catMatchAll.exec(block)) !== null)
      categories.push(cm[1]);

    out.push({
      id: pick("id"),
      title: pick("title").replace(/\s+/g, " ").trim(),
      summary: pick("summary").slice(0, 1200),
      authors: Array.from(
        block.matchAll(/<name>([^<]+)<\/name>/gi)
      ).map((a) => a[1]),
      published: pick("published") || new Date().toISOString(),
      updated: pick("updated"),
      link: linkMatch ? linkMatch[1] : "",
      doi: doiMatch ? doiMatch[1] : null,
      primary_category:
        /<arxiv:primary_category[^>]*term="([^"]+)"[^>]*>/i.exec(
          block
        )?.[1] ?? null,
      categories,
    });
  }
  return out;
}

// ——— 1. searchPapers — Semantic Scholar Graph API ———

export async function searchPapers(
  query: string,
  limit?: number,
  fields?: string
) {
  const source = "Semantic Scholar Graph API";
  try {
    const q = (query ?? "").trim();
    if (!q) return fail("query is required", source);

    const maxLimit = clamp(Math.trunc(limit ?? 20), 1, 100);
    const fieldList =
      (fields?.trim() ||
        "title,abstract,citationCount,year,authors,venue,openAccessPdf,url,externalIds,publicationDate,tldr") ??
      "title,abstract,citationCount,year,authors";

    const params = new URLSearchParams({
      query: q,
      limit: String(maxLimit),
      fields: fieldList,
    });

    // Semantic Scholar is rate-limited to ~1 req/sec without key
    const data = await fetchJson(
      `${SEMANTIC_SCHOLAR}/paper/search?${params.toString()}`,
      { timeoutMs: 10000 }
    );

    const results: any[] = (data?.data ?? []).map((p: any) => ({
      paper_id: p.paperId ?? null,
      title: p.title ?? "",
      abstract: (p.abstract ?? "").slice(0, 2000),
      year: p.year ?? null,
      venue: p.venue ?? null,
      citation_count: p.citationCount ?? 0,
      publication_date: p.publicationDate ?? null,
      authors: (p.authors ?? []).map((a: any) => ({
        name: a?.name ?? "",
        author_id: a?.authorId ?? null,
      })),
      tldr: p.tldr?.text ?? null,
      open_access_pdf: p.openAccessPdf?.url ?? null,
      url: p.url ?? (p.paperId ? `https://www.semanticscholar.org/paper/${p.paperId}` : ""),
      external_ids: p.externalIds ?? {},
      influential_citation_count: p.influentialCitationCount ?? null,
    }));

    return ok(
      {
        query: q,
        limit: maxLimit,
        fields: fieldList,
        total: data?.total ?? results.length,
        results,
      },
      source,
      results.length
    );
  } catch (e: any) {
    return fail(e?.message ?? String(e), source);
  }
}

// ——— 2. searchArxiv — arXiv Atom API ———

export async function searchArxiv(
  query: string,
  category?: string,
  limit?: number
) {
  const source = "arXiv Atom API (export.arxiv.org)";
  try {
    const q = (query ?? "").trim();
    if (!q) return fail("query is required", source);

    const maxResults = clamp(Math.trunc(limit ?? 20), 1, 100);

    // Build search query — combine text + category filter if provided
    let searchQuery = `all:${encodeURIComponent(q)}`;
    if (category) {
      searchQuery = `cat:${encodeURIComponent(category)}+AND+all:${encodeURIComponent(q)}`;
    }

    const params = new URLSearchParams({
      search_query: category
        ? `cat:${category} AND all:${q}`
        : `all:${q}`,
      start: "0",
      max_results: String(maxResults),
      sortBy: "relevance",
      sortOrder: "descending",
    });

    const xml = await fetchText(
      `${ARXIV_API}?${params.toString()}`,
      10000
    );

    const entries = parseAtomEntries(xml);

    const results: any[] = entries.map((e) => ({
      arxiv_id: (e.id as string)?.replace(
        "http://arxiv.org/abs/",
        ""
      ),
      title: e.title ?? "",
      summary: e.summary ?? "",
      authors: e.authors ?? [],
      published: e.published ?? null,
      updated: e.updated ?? null,
      link: e.link ?? "",
      doi: e.doi ?? null,
      primary_category: e.primary_category ?? null,
      categories: e.categories ?? [],
      pdf_url: e.id
        ? `https://arxiv.org/pdf/${(e.id as string)?.replace(
            "http://arxiv.org/abs/",
            ""
          )}`
        : "",
    }));

    return ok(
      {
        query: q,
        category_filter: category ?? null,
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

// ——— 3. searchPubmed — NCBI E-utilities (esearch + esummary) ———

export async function searchPubmed(query: string, limit?: number) {
  const source = "NCBI PubMed E-utilities";
  try {
    const q = (query ?? "").trim();
    if (!q) return fail("query is required", source);

    const retmax = clamp(Math.trunc(limit ?? 20), 1, 100);

    // Step 1: esearch to get PMIDs
    const searchParams = new URLSearchParams({
      db: "pubmed",
      term: q,
      retmax: String(retmax),
      retmode: "json",
      sort: "relevance",
    });

    const searchData = await fetchJson(
      `${PUBMED_ESEARCH}?${searchParams.toString()}`
    );

    const idList: string[] = searchData?.esearchresult?.idlist ?? [];
    if (idList.length === 0) {
      return ok(
        {
          query: q,
          limit: retmax,
          total: 0,
          results: [],
        },
        source,
        0
      );
    }

    // Step 2: esummary to get details
    const summaryParams = new URLSearchParams({
      db: "pubmed",
      id: idList.join(","),
      retmode: "json",
    });

    const summaryData = await fetchJson(
      `${PUBMED_ESUMMARY}?${summaryParams.toString()}`
    );

    const resultMap = summaryData?.result ?? {};
    const results: any[] = idList
      .map((id) => {
        const r = resultMap[id];
        if (!r) return null;
        return {
          pmid: id,
          title: r.title ?? "",
          authors: (r.authors ?? []).map((a: any) => ({
            name: a?.name ?? "",
            authtype: a?.authtype ?? null,
          })),
          journal: r.fulljournalname ?? r.source ?? "",
          pubdate: r.pubdate ?? null,
          epubdate: r.epubdate ?? null,
          articleids: (r.articleids ?? []).map((a: any) => ({
            id_type: a?.idtype ?? null,
            value: a?.value ?? "",
          })),
          doi: (r.articleids ?? []).find(
            (a: any) => a?.idtype === "doi"
          )?.value ?? null,
          volume: r.volume ?? null,
          issue: r.issue ?? null,
          pages: r.pages ?? null,
          lang: r.lang ?? [],
          pubtype: r.pubtype ?? [],
          abstract: (r.abstract ?? "").slice(0, 2000),
          sortpubdate: r.sortpubdate ?? null,
        };
      })
      .filter(Boolean);

    return ok(
      {
        query: q,
        limit: retmax,
        total: Number(searchData?.esearchresult?.count ?? results.length),
        results,
      },
      source,
      results.length
    );
  } catch (e: any) {
    return fail(e?.message ?? String(e), source);
  }
}

// ——— 4. searchClinicalTrials — ClinicalTrials.gov v2 API ———

export async function searchClinicalTrials(
  query: string,
  status?: string,
  limit?: number
) {
  const source = "ClinicalTrials.gov v2 API";
  try {
    const q = (query ?? "").trim();
    if (!q) return fail("query is required", source);

    const pageSize = clamp(Math.trunc(limit ?? 20), 1, 100);

    const params = new URLSearchParams({
      "query.term": q,
      pageSize: String(pageSize),
      format: "json",
    });

    // Optional status filter
    if (status) {
      const statusMap: Record<string, string> = {
        recruiting: "RECRUITING",
        active: "ACTIVE_NOT_RECRUITING",
        completed: "COMPLETED",
        not_yet_recruiting: "NOT_YET_RECRUITING",
        terminated: "TERMINATED",
        withdrawn: "WITHDRAWN",
        suspended: "SUSPENDED",
        enrolling: "ENROLLING_BY_INVITATION",
      };
      const mapped = statusMap[status.toLowerCase()] ?? status.toUpperCase();
      params.set("filter.overallStatus", mapped);
    }

    const data = await fetchJson(
      `${CLINICAL_TRIALS}?${params.toString()}`
    );

    const studies: any[] = (data?.studies ?? []).map((s: any) => {
      const proto = s?.protocolSection ?? {};
      const ident = proto?.identificationModule ?? {};
      const status = proto?.statusModule ?? {};
      const sponsors = proto?.sponsorCollaboratorsModule ?? {};
      const desc = proto?.descriptionModule ?? {};
      const cond = proto?.conditionsModule ?? {};
      const design = proto?.designModule ?? {};
      const arms = proto?.armsInterventionsModule ?? {};
      const outcomes = proto?.outcomesModule ?? {};
      const loc = proto?.contactsLocationsModule ?? {};
      const elig = proto?.eligibilityModule ?? {};

      return {
        nct_id: ident?.nctId ?? s?.nctId ?? null,
        brief_title: ident?.briefTitle ?? "",
        official_title: ident?.officialTitle ?? "",
        overall_status: status?.overallStatus ?? null,
        start_date: status?.startDateStruct?.date ?? null,
        completion_date: status?.completionDateStruct?.date ?? null,
        primary_completion_date:
          status?.primaryCompletionDateStruct?.date ?? null,
        last_update_date:
          status?.lastUpdateSubmitDateStruct?.date ?? null,
        study_type: design?.studyType ?? null,
        phases: design?.phases ?? [],
        allocation: design?.designInfo?.allocation ?? null,
        primary_purpose:
          design?.designInfo?.primaryPurpose ?? null,
        enrollment: design?.enrollmentInfo?.count ?? null,
        conditions: cond?.conditions ?? [],
        keywords: cond?.keywords ?? [],
        sponsor: sponsors?.leadSponsor?.name ?? null,
        collaborators: (sponsors?.collaborators ?? []).map(
          (c: any) => c?.name ?? ""
        ),
        brief_summary: (desc?.briefSummary ?? "").slice(0, 2000),
        interventions: (arms?.interventions ?? []).map((i: any) => ({
          type: i?.type ?? null,
          name: i?.name ?? "",
        })),
        arms: (arms?.armGroups ?? []).map((a: any) => ({
          label: a?.label ?? "",
          type: a?.type ?? null,
          description: (a?.description ?? "").slice(0, 500),
        })),
        locations: (loc?.locations ?? [])
          .slice(0, 10)
          .map((l: any) => ({
            facility: l?.facility ?? "",
            city: l?.city ?? "",
            state: l?.state ?? "",
            country: l?.country ?? "",
            status: l?.status ?? null,
          })),
        eligibility: {
          criteria: (elig?.eligibilityCriteria ?? "").slice(0, 1500),
          gender: elig?.sex ?? null,
          min_age: elig?.minimumAge ?? null,
          max_age: elig?.maximumAge ?? null,
        },
        primary_outcomes: (outcomes?.primaryOutcomes ?? [])
          .map((o: any) => o?.measure ?? "")
          .filter(Boolean),
        url: ident?.nctId
          ? `https://clinicaltrials.gov/study/${ident.nctId}`
          : "",
      };
    });

    return ok(
      {
        query: q,
        status_filter: status ?? null,
        limit: pageSize,
        total: data?.totalCount ?? studies.length,
        next_page_token: data?.nextPageToken ?? null,
        results: studies,
      },
      source,
      studies.length
    );
  } catch (e: any) {
    return fail(e?.message ?? String(e), source);
  }
}

// ——— 5. searchOpenAlex — OpenAlex API ———

export async function searchOpenAlex(query: string, limit?: number) {
  const source = "OpenAlex API (openalex.org)";
  try {
    const q = (query ?? "").trim();
    if (!q) return fail("query is required", source);

    const perPage = clamp(Math.trunc(limit ?? 25), 1, 200);

    const params = new URLSearchParams({
      search: q,
      "per-page": String(perPage),
    });

    // Add mailto for polite pool (better rate limits) — works keyless
    const url = `${OPEN_ALEX}?${params.toString()}`;

    const data = await fetchJson(url, { timeoutMs: 10000 });

    const results: any[] = (data?.results ?? []).map((w: any) => ({
      openalex_id: w?.id ?? null,
      doi: w?.doi ?? null,
      title: w?.title ?? "",
      publication_year: w?.publication_year ?? null,
      publication_date: w?.publication_date ?? null,
      cited_by_count: w?.cited_by_count ?? 0,
      type: w?.type ?? null,
      language: w?.language ?? null,
      is_oa: w?.open_access?.is_oa ?? false,
      oa_url: w?.open_access?.oa_url ?? null,
      oa_status: w?.open_access?.oa_status ?? null,
      authors: (w?.authorships ?? []).map((a: any) => ({
        name: a?.author?.display_name ?? "",
        author_id: a?.author?.id ?? null,
        orcid: a?.author?.orcid ?? null,
        institutions: (a?.institutions ?? []).map(
          (i: any) => i?.display_name ?? ""
        ),
      })),
      primary_location: w?.primary_location?.source?.display_name ?? null,
      primary_location_url: w?.primary_location?.landing_page_url ?? null,
      concepts: (w?.concepts ?? [])
        .slice(0, 10)
        .map((c: any) => ({
          name: c?.display_name ?? "",
          level: c?.level ?? null,
          score: c?.score ?? null,
        })),
      topics: (w?.topics ?? [])
        .slice(0, 10)
        .map((t: any) => ({
          name: t?.display_name ?? "",
          score: t?.score ?? null,
        })),
      keywords: (w?.keywords ?? [])
        .slice(0, 15)
        .map((k: any) => k?.display_name ?? k?.keyword ?? "")
        .filter(Boolean),
      abstract: w?.abstract_inverted_index
        ? reconstructAbstract(w.abstract_inverted_index)
        : null,
      apc_list: w?.apc_list?.value ?? null,
      apc_paid: w?.apc_paid?.value ?? null,
      referenced_works: (w?.referenced_works ?? []).slice(0, 20),
      related_works: (w?.related_works ?? []).slice(0, 10),
    }));

    return ok(
      {
        query: q,
        limit: perPage,
        total: data?.meta?.count ?? results.length,
        count_per_page: data?.meta?.count ?? results.length,
        next_cursor: data?.meta?.next_cursor ?? null,
        results,
      },
      source,
      results.length
    );
  } catch (e: any) {
    return fail(e?.message ?? String(e), source);
  }
}

/**
 * Reconstruct an abstract from OpenAlex's inverted index format.
 * Format: { "word": [0, 5, 12], "another": [1, 3], ... }
 */
function reconstructAbstract(invertedIndex: Record<string, number[]>): string {
  if (!invertedIndex || typeof invertedIndex !== "object") return "";
  const positions: Map<number, string> = new Map();
  for (const [word, indices] of Object.entries(invertedIndex)) {
    if (!Array.isArray(indices)) continue;
    for (const pos of indices) {
      if (typeof pos === "number") positions.set(pos, word);
    }
  }
  const allPositions = Array.from(positions.keys());
  const maxPos = allPositions.length > 0 ? Math.max.apply(null, allPositions) : 0;
  const words: string[] = [];
  for (let i = 0; i <= maxPos; i++) {
    const w = positions.get(i);
    if (w) words.push(w);
  }
  return words.join(" ").slice(0, 2000);
}

// ——— 6. getPaperDetails — Semantic Scholar Paper Lookup ———

export async function getPaperDetails(paperId: string) {
  const source = "Semantic Scholar Graph API (paper details)";
  try {
    const id = (paperId ?? "").trim();
    if (!id) return fail("paperId is required", source);

    const fields =
      "title,abstract,authors,year,citationCount,influentialCitationCount,fieldsOfStudy,openAccessPdf,venue,publicationDate,externalIds,url,tldr";

    const data = await fetchJson(
      `${SEMANTIC_SCHOLAR}/paper/${encodeURIComponent(id)}?fields=${fields}`,
      { timeoutMs: 10000 }
    );

    const result = {
      paper_id: data?.paperId ?? id,
      title: data?.title ?? "",
      abstract: (data?.abstract ?? "").slice(0, 3000),
      authors: (data?.authors ?? []).map((a: any) => ({
        name: a?.name ?? "",
        author_id: a?.authorId ?? null,
      })),
      year: data?.year ?? null,
      venue: data?.venue ?? null,
      publication_date: data?.publicationDate ?? null,
      citation_count: data?.citationCount ?? 0,
      influential_citations: data?.influentialCitationCount ?? 0,
      fields_of_study: data?.fieldsOfStudy ?? [],
      pdf_url: data?.openAccessPdf?.url ?? null,
      tldr: data?.tldr?.text ?? null,
      external_ids: data?.externalIds ?? {},
      url:
        data?.url ??
        (data?.paperId
          ? `https://www.semanticscholar.org/paper/${data.paperId}`
          : ""),
    };

    return ok(result, source, 1);
  } catch (e: any) {
    return fail(e?.message ?? String(e), source);
  }
}

// ——— 7. getCitationGraph — Semantic Scholar Citations/References ———

export async function getCitationGraph(
  paperId: string,
  direction?: "forward" | "backward"
) {
  const source = "Semantic Scholar Graph API (citation graph)";
  try {
    const id = (paperId ?? "").trim();
    if (!id) return fail("paperId is required", source);

    const dir = direction ?? "forward";
    const endpoint = dir === "forward" ? "citations" : "references";
    const fields =
      "title,authors,year,citationCount,influentialCitationCount,venue,publicationDate,abstract,isInfluential";

    const data = await fetchJson(
      `${SEMANTIC_SCHOLAR}/paper/${encodeURIComponent(id)}/${endpoint}?fields=${fields}&limit=100`,
      { timeoutMs: 15000 }
    );

    const rawList: any[] = data?.data ?? [];

    const results: any[] = rawList.map((item: any) => {
      // Forward citations: item.citingPaper; backward references: item.citedPaper
      const p = item?.citingPaper ?? item?.citedPaper ?? {};
      return {
        paper_id: p.paperId ?? null,
        title: p.title ?? "",
        authors: (p.authors ?? []).map((a: any) => a?.name ?? ""),
        year: p.year ?? null,
        venue: p.venue ?? null,
        citation_count: p.citationCount ?? 0,
        influential: item?.isInfluential ?? false,
        abstract: (p.abstract ?? "").slice(0, 500),
        url: p.paperId
          ? `https://www.semanticscholar.org/paper/${p.paperId}`
          : "",
      };
    });

    return ok(
      {
        paper_id: id,
        direction: dir,
        total: data?.offset ? data.offset + results.length : results.length,
        count_estimate: results.length,
        results,
      },
      source,
      results.length
    );
  } catch (e: any) {
    return fail(e?.message ?? String(e), source);
  }
}
