// AUTO: openaq-air-pulse — OpenAQ locations pulse with v3->v2 fallback
export async function fetchOpenAq(opts: { limit?: number; country?: string } = {}) {
  const fetched_at = new Date().toISOString();
  const limit = Math.min(opts.limit ?? 30, 50);
  const countryQ = opts.country ? `&country=${encodeURIComponent(opts.country)}` : "";
  const urls = [
    `https://api.openaq.org/v3/locations?limit=${limit}&order_by=lastUpdated&sort=desc${countryQ}`,
    `https://api.openaq.org/v2/locations?limit=${limit}&order_by=lastUpdated&sort=desc${countryQ}`,
  ];
  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(url, {
        headers: { "User-Agent": "TollboothBot/1.0", Accept: "application/json" },
        signal: ctrl.signal,
      } as any);
      clearTimeout(t);
      if (!r.ok) continue;
      const j = (await r.json()) as any;
      const results = Array.isArray(j?.results) ? j.results : Array.isArray(j?.data) ? j.data : [];
      const rows = results.slice(0, limit).map((loc: any) => ({
        id: loc.id ?? loc.locationId ?? String(loc.location ?? ""),
        name: loc.name ?? loc.location ?? "",
        city: loc.city ?? loc.cityName ?? null,
        country: loc.country ?? null,
        coords: loc.coordinates ? [loc.coordinates.longitude ?? loc.coordinates?.lng, loc.coordinates.latitude ?? loc.coordinates?.lat] : loc.coords ? [loc.coords.longitude, loc.coords.latitude] : [],
        last_updated: loc.datetimeLast?.utc ?? loc.lastUpdated ?? loc.datetime ?? null,
        parameter: loc.parameter ?? loc.parameters?.[0]?.parameter ?? null,
        value: loc.parameterCount ?? loc.count ?? null,
        url: `https://openaq.org/#/locations/${loc.id ?? loc.locationId ?? ""}`,
      }));
      return { fetched_at, rows, source: url };
    } catch {
      continue;
    }
  }
  try {
    // ultimate empty fallback, still valid shape
    return { fetched_at, rows: [], source: urls[0], note: "openaq both endpoints failed — empty pulse" };
  } catch (e: any) {
    return { fetched_at, rows: [], error: e?.message ?? String(e) };
  }
}
