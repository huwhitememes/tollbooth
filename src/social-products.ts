/**
 * Social & Developer Intelligence Products — Tollbooth x402 MCP
 *
 * Free / keyless sources:
 * - Reddit JSON API (reddit.com/r/{sub}/search.json, .json endpoints) — keyless
 * - GitHub REST API (api.github.com) — 60 req/hr keyless, 5k with token
 *
 * All functions return { success, data, cached, meta: { count, source, generated_at } }
 * and handle errors gracefully.
 */

// ─── Constants ───────────────────────────────────────────────────────────

const GITHUB_API = "https://api.github.com";

const USER_AGENT = "TollboothBot/1.0 SocialIntel/0.9";

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
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      ...(opts.headers as Record<string, string> || {}),
    };
    // GitHub token if available (raises rate limit from 60 to 5k/hr)
    const ghToken =
      (typeof process !== "undefined" &&
        (process as any).env?.GITHUB_TOKEN) ||
      null;
    if (ghToken && url.includes("api.github.com")) {
      headers["Authorization"] = `Bearer ${ghToken}`;
    }
    const r = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers,
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

// ─── 1. searchReddit — Reddit JSON API ───────────────────────────────────

export async function searchReddit(
  query: string,
  subreddit?: string,
  sort?: string,
  limit?: number
) {
  const source = "Reddit JSON API (reddit.com)";
  try {
    const q = (query ?? "").trim();
    if (!q) return fail("query is required", source);

    const lim = clamp(Math.trunc(limit ?? 25), 1, 100);
    const sortBy = sort === "new" || sort === "top" || sort === "relevance" ? sort : "relevance";
    const sub = subreddit?.trim()?.replace(/^r\//, "") ?? null;

    // Build Reddit search URL
    const params = new URLSearchParams({
      q,
      sort: sortBy,
      limit: String(lim),
      restrict_sr: sub ? "true" : "false",
      raw_json: "1",
    });

    const url = sub
      ? `https://www.reddit.com/r/${sub}/search.json?${params.toString()}`
      : `https://www.reddit.com/search.json?${params.toString()}`;

    const data = await fetchJson(url, { timeoutMs: 10000 });

    const posts: any[] = (data?.data?.children ?? [])
      .map((c: any) => c?.data)
      .filter(Boolean);

    const results = posts.map((p: any) => ({
      title: p?.title ?? "",
      subreddit: p?.subreddit_name_prefixed ?? "",
      author: p?.author ?? "",
      score: p?.score ?? 0,
      upvote_ratio: p?.upvote_ratio ?? null,
      num_comments: p?.num_comments ?? 0,
      created_utc: p?.created_utc ?? null,
      created_date: p?.created_utc
        ? new Date(p.created_utc * 1000).toISOString()
        : null,
      permalink: p?.permalink
        ? `https://www.reddit.com${p.permalink}`
        : "",
      url: p?.url ?? "",
      is_self: p?.is_self ?? false,
      selftext: p?.is_self ? (p?.selftext ?? "").slice(0, 800) : null,
      flair: p?.link_flair_text ?? null,
      over_18: p?.over_18 ?? false,
    }));

    return ok(
      {
        query: q,
        subreddit_filter: sub ? `r/${sub}` : null,
        sort: sortBy,
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

// ─── 2. getRepoIntel — GitHub Repository Intelligence ────────────────────

export async function getRepoIntel(repo: string) {
  const source = "GitHub REST API (api.github.com)";
  try {
    const r = (repo ?? "").trim().replace(/^https?:\/\/github\.com\//, "");
    if (!r || !r.includes("/")) return fail("repo is required (format: owner/name)", source);

    // Fetch repo metadata
    const repoData = await fetchJson(`${GITHUB_API}/repos/${r}`, { timeoutMs: 10000 });

    // Fetch recent commits for cadence analysis
    const commits = await fetchJson(`${GITHUB_API}/repos/${r}/commits?per_page=30`, {
      timeoutMs: 10000,
    }).catch(() => []);

    const commitList: any[] = Array.isArray(commits) ? commits : [];
    const commitDates = commitList
      .map((c: any) => c?.commit?.author?.date)
      .filter(Boolean)
      .sort();

    // Calculate commit cadence
    let avgCommitGapDays: number | null = null;
    if (commitDates.length >= 2) {
      const gaps: number[] = [];
      for (let i = 1; i < commitDates.length; i++) {
        const diff = (new Date(commitDates[i]).getTime() - new Date(commitDates[i - 1]).getTime()) / 86400000;
        gaps.push(diff);
      }
      avgCommitGapDays = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    }

    // Fetch contributors count
    const contributors = await fetchJson(
      `${GITHUB_API}/repos/${r}/contributors?per_page=1&anon=true`,
      { timeoutMs: 8000 }
    ).catch(() => []);

    const contributorCount = Array.isArray(contributors)
      ? contributors.length
      : 0;

    // Fetch open issues count from repo data
    const result = {
      full_name: repoData?.full_name ?? r,
      description: repoData?.description ?? "",
      owner: repoData?.owner?.login ?? r.split("/")[0],
      created_at: repoData?.created_at ?? null,
      updated_at: repoData?.updated_at ?? null,
      pushed_at: repoData?.pushed_at ?? null,
      homepage: repoData?.homepage ?? null,
      language: repoData?.language ?? null,
      license: repoData?.license?.spdx_id ?? null,
      topics: repoData?.topics ?? [],
      stars: repoData?.stargazers_count ?? 0,
      watchers: repoData?.watchers_count ?? 0,
      forks: repoData?.forks_count ?? 0,
      open_issues: repoData?.open_issues_count ?? 0,
      default_branch: repoData?.default_branch ?? "main",
      size_kb: repoData?.size ?? 0,
      is_archived: repoData?.archived ?? false,
      is_fork: repoData?.fork ?? false,
      visibility: repoData?.visibility ?? "public",
      // Derived health metrics
      health: {
        avg_commit_gap_days: avgCommitGapDays !== null
          ? Math.round(avgCommitGapDays * 10) / 10
          : null,
        last_commit_date: commitDates[commitDates.length - 1] ?? null,
        days_since_last_commit: commitDates.length > 0
          ? Math.floor((Date.now() - new Date(commitDates[commitDates.length - 1]).getTime()) / 86400000)
          : null,
        commit_cadence_30d: commitList.length,
        contributor_count_sample: contributorCount,
        star_velocity: repoData?.stargazers_count && repoData?.created_at
          ? Math.round((repoData.stargazers_count / Math.max(1, (Date.now() - new Date(repoData.created_at).getTime()) / 86400000)) * 10) / 10
          : null,
        issue_ratio: repoData?.open_issues_count && repoData?.stargazers_count
          ? Math.round((repoData.open_issues_count / repoData.stargazers_count) * 1000) / 1000
          : null,
      },
      url: repoData?.html_url ?? `https://github.com/${r}`,
    };

    return ok(result, source, 1);
  } catch (e: any) {
    return fail(e?.message ?? String(e), source);
  }
}
