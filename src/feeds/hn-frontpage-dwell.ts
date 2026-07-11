// AUTO: hn-frontpage-dwell — HN front page via Algolia + dwell signal
export async function fetchHnFrontpage(opts: { limit?: number } = {}) {
  const fetched_at = new Date().toISOString();
  const url = `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${Math.min(opts.limit ?? 30, 50)}`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(url, {
      headers: { "User-Agent": "TollboothBot/1.0", Accept: "application/json" },
      signal: ctrl.signal,
    } as any);
    clearTimeout(t);
    if (!r.ok) throw new Error(`hn ${r.status}`);
    const j = (await r.json()) as any;
    const hits = Array.isArray(j?.hits) ? j.hits : [];
    const now = Date.now() / 1000;
    const rows = hits.map((h: any) => {
      const created = h.created_at_i ?? now;
      const hours_old = Math.max(0, (now - created) / 3600);
      const points = h.points ?? 0;
      const dwell = points / (hours_old + 2);
      return {
        id: h.objectID ?? String(h.objectID),
        title: String(h.title ?? "").slice(0, 200),
        url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
        points,
        comments: h.num_comments ?? 0,
        hours_old: Math.round(hours_old * 10) / 10,
        dwell_score: Math.round(dwell * 100) / 100,
        author: h.author ?? null,
        created_at: new Date(created * 1000).toISOString(),
      };
    });
    rows.sort((a: any, b: any) => b.dwell_score - a.dwell_score);
    return { fetched_at, rows };
  } catch (e: any) {
    return { fetched_at, rows: [], error: e?.message ?? String(e) };
  }
}
