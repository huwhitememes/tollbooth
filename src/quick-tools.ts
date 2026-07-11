/**
 * Quick tools — free, no-key public API wrappers.
 * Each function fetches from a verified free JSON endpoint and returns structured data.
 */

const UA = "Tollbooth/0.14 (agenttoll.dev)";

async function fetchJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  const r = await fetch(url, { headers: { "User-Agent": UA, ...headers } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} from ${url}`);
  return r.json();
}

// ── Environmental ──────────────────────────────────────────────────

export async function getSpaceWeatherKp(): Promise<unknown> {
  return fetchJson("https://services.swpc.noaa.gov/json/planetary_k_index_1m.json");
}

export async function getWeatherForecast(lat: number, lon: number): Promise<unknown> {
  const points = await fetchJson(`https://api.weather.gov/points/${lat},${lon}`) as any;
  const forecastUrl = points?.properties?.forecast;
  if (!forecastUrl) throw new Error("Could not resolve forecast URL from NWS points API");
  return fetchJson(forecastUrl);
}

export async function getWeatherCurrent(lat: number, lon: number, variables?: string): Promise<unknown> {
  const vars = variables || "temperature_2m,wind_speed_10m,relative_humidity_2m,precipitation";
  return fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=${vars}`);
}

export async function getAuroraForecast(): Promise<unknown> {
  return fetchJson("https://services.swpc.noaa.gov/json/ovation_aurora_latest.json");
}

export async function getMarineConditions(lat: number, lon: number): Promise<unknown> {
  return fetchJson(`https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&current=wave_height,wave_direction,sea_surface_temperature,wind_wave_height`);
}

// ── Health & Safety ────────────────────────────────────────────────

export async function getAirQualityIndex(lat: number, lon: number, variables?: string): Promise<unknown> {
  const vars = variables || "pm2_5,uv_index,ozone,nitrogen_dioxide,sulphur_dioxide";
  return fetchJson(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=${vars}`);
}

// ── Government ─────────────────────────────────────────────────────

export async function getPostalLookup(country: string, postalCode: string): Promise<unknown> {
  return fetchJson(`https://api.zippopotam.us/${country}/${postalCode}`);
}

// ── OSINT & Intelligence ───────────────────────────────────────────

export async function getIpGeolocation(ip: string): Promise<unknown> {
  return fetchJson(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city,lat,lon,isp,as,query`);
}

export async function getTimezoneCurrent(timezone: string): Promise<unknown> {
  return fetchJson(`https://timeapi.io/api/Time/current/zone?timeZone=${encodeURIComponent(timezone)}`);
}

export async function getAirportStatus(icao: string): Promise<unknown> {
  return fetchJson(`https://opensky-network.org/api/airports?icao=${encodeURIComponent(icao)}`);
}

// ── Security ───────────────────────────────────────────────────────

export async function getDnsRecords(domain: string, type?: string): Promise<unknown> {
  const rtype = type || "A";
  return fetchJson(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${rtype}`, {
    accept: "application/dns-json",
  });
}

// ── Academic & Science ─────────────────────────────────────────────

export async function getIsbnLookup(isbn: string): Promise<unknown> {
  return fetchJson(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`);
}

// ── Finance ────────────────────────────────────────────────────────

export async function getCryptoPrice(coin: string, currency?: string): Promise<unknown> {
  const cur = currency || "usd";
  return fetchJson(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coin)}&vs_currencies=${cur}`);
}

export async function getBtcBalance(address: string, limit?: number): Promise<unknown> {
  const n = limit || 5;
  return fetchJson(`https://blockchain.info/rawaddr/${address}?limit=${n}`);
}

export async function getBtcFees(): Promise<unknown> {
  return fetchJson("https://mempool.space/api/v1/fees/recommended");
}

// ── Health & Safety extra ──────────────────────────────────────────

export async function getFoodRecalls(query?: string, limit?: number): Promise<unknown> {
  const n = Math.min(limit || 20, 50);
  const q = query ? `?search=recalling_firm:"${encodeURIComponent(query)}"&limit=${n}` : `?limit=${n}`;
  return fetchJson(`https://api.fda.gov/food/enforcement.json${q}`);
}
