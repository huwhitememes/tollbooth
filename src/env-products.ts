/**
 * Environmental & Climate Data — data products for x402 paid tools.
 *
 * Sources (all free / public government APIs):
 * - NASA FIRMS (wildfire detection, DEMO_KEY fallback)
 * - NWS / weather.gov (weather alerts, keyless)
 * - NOAA CO-OPS (tide predictions, keyless)
 * - NOAA SWPC (space weather, keyless)
 * - USGS Water Services (stream gauge levels, keyless)
 *
 * Each function returns { success, data, cached, meta: { count, source, generated_at } }.
 */

// ─── helpers ─────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

async function fetchJson(
  url: string,
  opts: RequestInit & { timeoutMs?: number } = {},
): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  try {
    const r = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "TollboothBot/1.0 EnvClimate/0.9",
        ...(opts.headers || {}),
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchText(url: string, timeoutMs = 8000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "TollboothBot/1.0 EnvClimate/0.9",
        Accept: "*/*",
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

function meta(count: number, source: string) {
  return { count, source, generated_at: new Date().toISOString() };
}

// ─── 1. getWildfires — NASA FIRMS ────────────────────────────────────────

export async function getWildfires(
  limit?: number,
  region?: string,
): Promise<{ success: boolean; data: any; cached: boolean; meta: { count: number; source: string; generated_at: string } }> {
  const lim = clamp(limit ?? 50, 1, 500);
  const area = region?.trim() || "world"; // FIRMS area: "world" or lat,lon,bound bbox
  const firmsKey = process.env.FIRMS_API_KEY ?? "DEMO_KEY";

  // FIRMS area CSV endpoint: /api/area/csv/{key}/{area}/{source}/{day_range}
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${firmsKey}/${encodeURIComponent(area)}/1/10`;

  try {
    const csv = await fetchText(url, 12000);
    const lines = csv.trim().split("\n");
    if (lines.length < 2) {
      return {
        success: true,
        data: [],
        cached: false,
        meta: meta(0, "NASA FIRMS"),
      };
    }
    const headers = lines[0].split(",").map((h) => h.trim());

    const results = lines.slice(1, lim + 1).map((line) => {
      const cols = line.split(",");
      const row: Record<string, string> = {};
      headers.forEach((h, i) => { row[h] = cols[i]?.trim() ?? ""; });
      return {
        latitude: parseFloat(row.latitude) || 0,
        longitude: parseFloat(row.longitude) || 0,
        brightness: parseFloat(row.brightness) || 0,
        scan: parseFloat(row.scan) || 0,
        track: parseFloat(row.track) || 0,
        acq_date: row.acq_date ?? "",
        acq_time: row.acq_time ?? "",
        satellite: row.satellite ?? "",
        confidence: row.confidence ?? "",
        version: row.version ?? "",
        bright_t31: parseFloat(row.bright_t31) || 0,
        frp: parseFloat(row.frp) || 0, // Fire Radiative Power (MW)
        daynight: row.daynight ?? "",
      };
    }).filter((r) => r.latitude !== 0 || r.longitude !== 0);

    return {
      success: true,
      data: results,
      cached: false,
      meta: meta(results.length, "NASA FIRMS"),
    };
  } catch (e: any) {
    return {
      success: false,
      data: { error: e?.message ?? String(e), url },
      cached: false,
      meta: meta(0, "NASA FIRMS"),
    };
  }
}

// ─── 2. getWeatherAlerts — NWS API ───────────────────────────────────────

export async function getWeatherAlerts(
  state?: string,
  zone?: string,
): Promise<{ success: boolean; data: any; cached: boolean; meta: { count: number; source: string; generated_at: string } }> {
  let url = "https://api.weather.gov/alerts?status=actual&message_type=alert";
  if (zone?.trim()) {
    url = `https://api.weather.gov/alerts/active/zone/${encodeURIComponent(zone.trim().toUpperCase())}`;
  } else if (state?.trim()) {
    url = `https://api.weather.gov/alerts?area=${encodeURIComponent(state.trim().toUpperCase())}&status=actual`;
  }

  try {
    const json = await fetchJson(url, { timeoutMs: 8000 });
    const features = (json?.features ?? []).map((f: any) => {
      const p = f.properties ?? {};
      return {
        id: f.id ?? "",
        event: p.event ?? "",
        headline: p.headline ?? "",
        description: (p.description ?? "").slice(0, 500),
        instruction: (p.instruction ?? "").slice(0, 400),
        severity: p.severity ?? "",
        certainty: p.certainty ?? "",
        urgency: p.urgency ?? "",
        area_desc: p.areaDesc ?? "",
        sent: p.sent ?? "",
        effective: p.effective ?? "",
        onset: p.onset ?? "",
        expires: p.expires ?? "",
        ends: p.ends ?? "",
        sender: p.senderName ?? "",
      };
    });

    return {
      success: true,
      data: features,
      cached: false,
      meta: meta(features.length, "NWS api.weather.gov"),
    };
  } catch (e: any) {
    return {
      success: false,
      data: { error: e?.message ?? String(e), url },
      cached: false,
      meta: meta(0, "NWS api.weather.gov"),
    };
  }
}

// ─── 3. getTideData — NOAA CO-OPS ────────────────────────────────────────

export async function getTideData(
  station?: string,
  date?: string,
): Promise<{ success: boolean; data: any; cached: boolean; meta: { count: number; source: string; generated_at: string } }> {
  const stn = station?.trim() || "8443970"; // default: Boston, MA
  const dt = date?.trim() || "today";

  const url =
    `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=${encodeURIComponent(stn)}` +
    `&product=predictions&datum=mllw&units=metric&time_zone=gmt` +
    `&application=web_services&format=json&date=${encodeURIComponent(dt)}`;

  try {
    const json = await fetchJson(url, { timeoutMs: 8000 });

    // Handle error from API
    if (json?.error) {
      return {
        success: false,
        data: { error: json.error.message ?? String(json.error) },
        cached: false,
        meta: meta(0, "NOAA CO-OPS"),
      };
    }

    const predictions = (json?.predictions ?? []).map((p: any) => ({
      time: p.t ?? "",
      height_m: parseFloat(p.v) || 0,
    }));

    return {
      success: true,
      data: { station: stn, date: dt, predictions },
      cached: false,
      meta: meta(predictions.length, "NOAA CO-OPS"),
    };
  } catch (e: any) {
    return {
      success: false,
      data: { error: e?.message ?? String(e), url },
      cached: false,
      meta: meta(0, "NOAA CO-OPS"),
    };
  }
}

// ─── 4. getSpaceWeather — NOAA SWPC ──────────────────────────────────────

const SPACE_WEATHER_TYPES: Record<string, string> = {
  "planetary_k_index": "planetary_k_index_1m.json",
  "kp_index_1m": "planetary_k_index_1m.json",
  "solar_flare": "goes/primary/xray-flares-6-hour.json",
  "xray_flux": "goes/primary/xrays-6-hour.json",
  "solar_wind": "addons/ace/mag-sw-2h.json",
  "proton_flux": "goes/primary/particles-6-hour.json",
  "aurora_forecast": "ovation_aurora_latest.json",
  "cme": "notifications.json",
  "notifications": "notifications.json",
  "sunspot": "solar_region_summary.json",
};

export async function getSpaceWeather(
  type?: string,
  days?: number,
): Promise<{ success: boolean; data: any; cached: boolean; meta: { count: number; source: string; generated_at: string } }> {
  const dataType = type?.trim().toLowerCase() ?? "planetary_k_index";
  const filename = SPACE_WEATHER_TYPES[dataType] ?? "planetary_k_index_1m.json";
  const url = `https://services.swpc.noaa.gov/json/${filename}`;

  try {
    const json = await fetchJson(url, { timeoutMs: 10000 });

    // Some SWPC endpoints return arrays directly, others objects with arrays
    let results: any[];
    if (Array.isArray(json)) {
      results = json;
    } else if (json?.time_tag || json?.Product) {
      results = [json];
    } else {
      results = json ? [json] : [];
    }

    // Optional time filter
    if (days && days > 0 && results.length > 0) {
      const cutoff = Date.now() - days * 86400000;
      results = results.filter((r: any) => {
        const tag = r.time_tag ?? r.time ?? r.observation_time ?? "";
        try {
          return new Date(tag).getTime() >= cutoff;
        } catch {
          return true;
        }
      });
    }

    // Summarize
    let summary: Record<string, any> = {};
    if (dataType === "planetary_k_index" && results.length > 0) {
      const kpValues = results.map((r: any) => parseFloat(r.kp)).filter((v) => !isNaN(v));
      if (kpValues.length) {
        const maxKp = Math.max(...kpValues);
        summary = {
          max_kp: maxKp,
          storm_level: maxKp >= 8 ? "G5-Extreme" : maxKp >= 7 ? "G4-Severe" : maxKp >= 6 ? "G3-Strong" : maxKp >= 5 ? "G2-Moderate" : maxKp >= 4 ? "G1-Minor" : "Quiet",
          aurora_visibility: maxKp >= 5 ? "Possible at mid-latitudes" : maxKp >= 7 ? "Possible at low-latitudes" : "High-latitudes only",
        };
      }
    }

    return {
      success: true,
      data: { type: dataType, summary, readings: results.slice(0, 100) },
      cached: false,
      meta: meta(results.length, "NOAA SWPC"),
    };
  } catch (e: any) {
    return {
      success: false,
      data: { error: e?.message ?? String(e), url },
      cached: false,
      meta: meta(0, "NOAA SWPC"),
    };
  }
}

// ─── 5. getWaterLevels — USGS Water Services ─────────────────────────────

export async function getWaterLevels(
  state?: string,
  parameter_code?: string,
): Promise<{ success: boolean; data: any; cached: boolean; meta: { count: number; source: string; generated_at: string } }> {
  const st = state?.trim()?.toLowerCase() ?? "al"; // default: Alabama
  const pcode = parameter_code?.trim() || "00060"; // default: Discharge, cubic feet/sec

  const url =
    `https://waterservices.usgs.gov/nwis/iv/?stateCd=${encodeURIComponent(st.toUpperCase())}` +
    `&parameterCd=${encodeURIComponent(pcode)}&format=json`;

  try {
    const json = await fetchJson(url, { timeoutMs: 12000 });

    const stations = (json?.value?.timeSeries ?? []).map((ts: any) => {
      const src = ts.sourceInfo ?? {};
      const site = src.siteCode?.[0]?.value ?? "";
      const siteName = src.siteName ?? "";
      const geo = src.geoLocation?.geogLocation ?? {};
      const variable = ts.variable?.variableCode?.[0]?.value ?? pcode;
      const unit = ts.variable?.unit?.unitCode ?? "";
      const vals = (ts.values?.[0]?.value ?? []).slice(-5); // last 5 readings
      const latest = vals[vals.length - 1];
      return {
        site_code: site,
        site_name: siteName,
        latitude: geo.latitude ?? 0,
        longitude: geo.longitude ?? 0,
        variable_code: variable,
        unit,
        latest_value: latest ? parseFloat(latest.value) || 0 : null,
        latest_time: latest?.qualifiers?.[0] === "A" ? "approved" : "provisional",
        readings: vals.map((v: any) => ({ value: parseFloat(v.value) || 0, time: v.dateTime ?? "" })),
      };
    });

    return {
      success: true,
      data: { state: st.toUpperCase(), parameter_code: pcode, stations },
      cached: false,
      meta: meta(stations.length, "USGS Water Services"),
    };
  } catch (e: any) {
    return {
      success: false,
      data: { error: e?.message ?? String(e), url },
      cached: false,
      meta: meta(0, "USGS Water Services"),
    };
  }
}
