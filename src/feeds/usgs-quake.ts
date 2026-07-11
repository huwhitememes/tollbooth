// AUTO: usgs-quake-live — USGS all-day geojson
export async function fetchUsgsQuakes(opts: { min_mag?: number; limit?: number } = {}) {
  const fetched_at = new Date().toISOString();
  const url = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(url, {
      headers: { "User-Agent": "TollboothBot/1.0", Accept: "application/json" },
      signal: ctrl.signal,
    } as any);
    clearTimeout(t);
    if (!r.ok) throw new Error(`usgs ${r.status}`);
    const j = (await r.json()) as any;
    const feats = Array.isArray(j?.features) ? j.features : [];
    let rows = feats.map((f: any) => ({
      mag: f.properties?.mag ?? null,
      place: f.properties?.place ?? "",
      time: f.properties?.time ? new Date(f.properties.time).toISOString() : null,
      coords: Array.isArray(f.geometry?.coordinates) ? f.geometry.coordinates : [],
      url: f.properties?.url ?? "",
      tsunami: f.properties?.tsunami ?? 0,
      id: f.id ?? "",
      alert: f.properties?.alert ?? null,
    }));
    if (typeof opts.min_mag === "number") rows = rows.filter((x: any) => x.mag != null && x.mag >= opts.min_mag!);
    rows.sort((a: any, b: any) => (b.mag ?? 0) - (a.mag ?? 0));
    if (typeof opts.limit === "number") rows = rows.slice(0, opts.limit);
    return { fetched_at, rows, count: rows.length, source: url };
  } catch (e: any) {
    return { fetched_at, rows: [], error: e?.message ?? String(e) };
  }
}
