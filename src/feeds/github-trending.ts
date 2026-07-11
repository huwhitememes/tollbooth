// AUTO: github-trending-live — GitHub search API trending by stars+pushed
export async function fetchGithubTrending(opts: { q?: string; limit?: number; language?: string; since_days?: number } = {}) {
  const fetched_at = new Date().toISOString();
  const since = new Date();
  since.setDate(since.getDate() - (opts.since_days ?? 7));
  const sinceStr = since.toISOString().slice(0, 10);
  let q = opts.q ?? `stars:>1 pushed:>${sinceStr}`;
  if (opts.language && !opts.q) q += ` language:${opts.language}`;
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${Math.min(opts.limit ?? 30, 50)}`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(url, {
      headers: { "User-Agent": "TollboothBot/1.0", Accept: "application/vnd.github+json" },
      signal: ctrl.signal,
    } as any);
    clearTimeout(t);
    if (!r.ok) throw new Error(`gh ${r.status}`);
    const j = (await r.json()) as any;
    const items = Array.isArray(j?.items) ? j.items : [];
    const rows = items.map((it: any) => ({
      repo: it.full_name ?? `${it.owner?.login}/${it.name}`,
      stars: it.stargazers_count ?? 0,
      desc: String(it.description ?? "").slice(0, 300),
      url: it.html_url ?? `https://github.com/${it.full_name}`,
      lang: it.language ?? null,
      pushed: it.pushed_at ?? it.updated_at ?? null,
    }));
    return { fetched_at, rows };
  } catch (e: any) {
    return { fetched_at, rows: [], error: e?.message ?? String(e) };
  }
}
