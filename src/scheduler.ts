// True 100% Auto: Cloudflare Cron Trigger pre-warm scheduler
// Runs every 15min via triggers.crons — zero manual, zero browsers
// Pre-warms KV so paid requests are <50ms cache hits

import { FEED_TTLS, cacheKey } from "./cache.js";
import { queryGeoPulse, queryFlightIntel, queryAttentionMomentum, queryRegulatoryPulse, querySec8kVelocity, queryFredSurprises, queryTreasuryDts, querySupplyStress, queryWeatherBias, queryResearchPack } from "./osint-products.js";
import { oddsFeed, volumeAnalytics, kalshiMarkets } from "./data-products.js";
import { scanTrendingMarkets } from "./rebalance.js";
import { fetchGithubTrending } from "./feeds/github-trending.js";
import { fetchHnFrontpage } from "./feeds/hn-frontpage.js";
import { fetchUsgsQuakes } from "./feeds/usgs-quake.js";
import { fetchOpenAq } from "./feeds/openaq-air.js";

// Safe parallel with limit — avoids thundering herd on upstreams
async function pLimit<T>(tasks: Array<() => Promise<T>>, concurrency = 3): Promise<Array<{ ok: boolean; val?: T; err?: string }>> {
  const results: Array<{ ok: boolean; val?: T; err?: string }> = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const cur = idx++;
      try {
        const val = await tasks[cur]();
        results[cur] = { ok: true, val };
      } catch (e) {
        results[cur] = { ok: false, err: (e as Error).message?.slice(0, 300) };
      }
    }
  }
  results.length = tasks.length;
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

type EnvLike = { tollbooth_cache?: any; TOLLBOOTH_CACHE?: any };

export async function runAllFeedWarms(env: EnvLike) {
  const kv = (env as any).tollbooth_cache ?? (env as any).TOLLBOOTH_CACHE;
  if (!kv) {
    console.log("[cron] no KV binding, skipping");
    return { warmed: 0, failed: 0, skipped: 1 };
  }

  async function put(feedKey: string, data: unknown, ttlSec?: number) {
    const key = cacheKey(feedKey, undefined);
    const ttl = ttlSec ?? FEED_TTLS[feedKey] ?? 900;
    const envelope = { v: 1, t: Date.now(), data };
    await kv.put(`v1:${key}`, JSON.stringify(envelope), { expirationTtl: ttl });
  }

  const tasks: Array<() => Promise<string>> = [
    async () => { const d = await queryGeoPulse({ hours_back: 24 }); await put("geo-pulse", d); return "geo-pulse"; },
    async () => { const d = await queryFlightIntel({ hours_back: 12 }); await put("flight-intel", d); return "flight-intel"; },
    async () => { const d = await queryAttentionMomentum({ window: "24h" }); await put("attention-momentum", d); return "attention-momentum"; },
    async () => { const d = await queryRegulatoryPulse({ hours_back: 24 }); await put("regulatory-pulse", d); return "regulatory-pulse"; },
    async () => { const d = await querySec8kVelocity({ hours: 24, limit: 30 }); await put("sec-8k-velocity", d); return "sec-8k-velocity"; },
    async () => { const d = await queryFredSurprises({ days: 7 }); await put("fred-surprises", d); return "fred-surprises"; },
    async () => { const d = await queryTreasuryDts({ days: 7 }); await put("treasury-dts", d); return "treasury-dts"; },
    async () => { const d = await querySupplyStress({}); await put("supply-stress", d); return "supply-stress"; },
    async () => { const d = await queryWeatherBias({ city: "NYC" }); await put("weather-bias", d); return "weather-bias"; },
    async () => { const d = await oddsFeed({ limit: 30, platform: "both" }); await put("odds-feed", d); return "odds-feed"; },
    async () => { const d = await volumeAnalytics({ limit: 30 }); await put("polymarket-volume", d); return "polymarket-volume"; },
    async () => { const d = await scanTrendingMarkets({ limit: 30 }); await put("polymarket-trending", d); return "polymarket-trending"; },
    async () => { const d = await kalshiMarkets({ limit: 30 }); await put("kalshi-markets", d); return "kalshi-markets"; },
    async () => {
      const r = await fetch("https://openrouter.ai/api/v1/models", { headers: { "User-Agent": "TollboothBot/1.0 cron/1.0" } });
      const j = await r.json() as any;
      const models = Array.isArray(j?.data) ? j.data : [];
      const normalized = { fetched_at: new Date().toISOString(), count: models.length, models: models.slice(0, 200).map((m: any) => ({ id: m.id, name: m.name, context_length: m.context_length, pricing: m.pricing })) };
      await put("openrouter-model-usage", normalized, 3600);
      await put("openrouter-models", normalized, 3600);
      return "openrouter-model-usage";
    },
    async () => { const d = await queryResearchPack({ topic: "AI agents x402 prediction markets" }); await put("research-pack", d); return "research-pack"; },
    async () => { const d = await fetchGithubTrending({ limit: 25 }); await put("github-trending", d); return "github-trending"; },
    async () => { const d = await fetchHnFrontpage({ limit: 30 }); await put("hn-frontpage", d); return "hn-frontpage"; },
    async () => { const d = await fetchUsgsQuakes({ limit: 30 }); await put("usgs-quake", d); return "usgs-quake"; },
    async () => { const d = await fetchOpenAq({ limit: 30 }); await put("openaq-air", d); return "openaq-air"; },
  ];

  console.log(`[cron] warming ${tasks.length} feeds at ${new Date().toISOString()}`);
  const started = Date.now();
  const results = await pLimit(tasks, 4);
  const ok = results.filter(r => r.ok);
  const fail = results.filter(r => !r.ok);
  const elapsed = Date.now() - started;
  console.log(`[cron] warmed ${ok.length}/${tasks.length} in ${elapsed}ms, failed: ${fail.map(f => f.err).join("; ").slice(0, 500)}`);
  return { warmed: ok.length, failed: fail.length, elapsed_ms: elapsed, failed_details: fail.map(f => f.err).slice(0, 5) };
}
