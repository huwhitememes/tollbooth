// Public API: HN Algolia front_page - dwell = points / age_hours
export async function fetchHnFrontpage(opts: { limit?: number; min_points?: number } = {}) {
  const limit = Math.min(opts.limit ?? 30, 50);
  const url = `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${limit}`;
  const ctrl = new AbortController(); const t=setTimeout(()=>ctrl.abort(),6000);
  try{
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "TollboothBot/1.0", Accept: "application/json" }});
    if(!r.ok) throw new Error(`hn ${r.status}`);
    const j = await r.json() as any;
    const now = Date.now();
    const rows = (j.hits ?? []).map((h:any)=>{
      const age_h = Math.max((now - new Date(h.created_at).getTime())/3600000, 0.5);
      const points = h.points ?? 0;
      return { id: h.objectID, title: h.title, url: h.url, points, num_comments: h.num_comments, author: h.author, created_at: h.created_at, age_hours: +age_h.toFixed(2), dwell: +(points / (age_h + 2)).toFixed(3), _tags: h._tags };
    }).sort((a:any,b:any)=>b.dwell-a.dwell)
    .filter((r:any)=> r.points >= (opts.min_points ?? 0));
    return { fetched_at: new Date().toISOString(), count: rows.length, rows, provenance: "https://hn.algolia.com/api/v1/search?tags=front_page" };
  } finally { clearTimeout(t); }
}
