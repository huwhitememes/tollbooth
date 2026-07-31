// KV cache layer for true auto — Cloudflare-native, zero browsers
// Paid handlers hit KV first -> <50ms, fallback to live on miss
// scheduled() pre-warms every 15min, so buyer never waits for upstream

const PREFIX = "v1:";
const DEFAULT_TTL_SEC = 60 * 15;

type KV = { get(k: string, opts?: any): Promise<any>; put(k: string, v: string, opts?: any): Promise<void>; list?(opts:any): Promise<any> };
type WithCache = { tollbooth_cache: KV };

function getKV(env: WithCache | any): KV | null {
  return (env?.tollbooth_cache ?? env?.TOLLBOOTH_CACHE ?? null) as KV | null;
}

export const FEED_TTLS: Record<string, number> = {
  "geo-pulse": 60 * 10,
  "flight-intel": 60 * 10,
  "attention-momentum": 60 * 15,
  "regulatory-pulse": 60 * 15,
  "research-pack": 60 * 30,
  "scenario-verdict": 60 * 30,
  "weather-bias": 60 * 60,
  "supply-stress": 60 * 30,
  "treasury-dts": 60 * 60 * 6,
  "sec-8k-velocity": 60 * 15,
  "fred-surprises": 60 * 60,
  "polymarket-trending": 60 * 5,
  "polymarket-volume": 60 * 5,
  "kalshi-markets": 60 * 5,
  "odds-feed": 60 * 2,
  "rebalance-scan": 60 * 2,
  "openrouter-model-usage": 60 * 60,
  "openrouter-models": 60 * 60,
  "github-trending": 60 * 10,
  "hn-frontpage": 60 * 10,
  "hn-frontpage-dwell": 60 * 10,
  "usgs-quake": 60 * 5,
  "openaq-air": 60 * 60,
  "polymarket-resolution": 60 * 10,
  "polymarket-res": 60 * 10,
  "x402-market-radar": 60 * 60 * 6,
  "x402-rank-audit": 60 * 30,
  "insider-cluster-brief": 60 * 30,
  "insider-cluster-brief-v2": 60 * 30,
  "gov-contract-fit-brief": 60 * 60,
  "gov-contract-fit-brief-v2": 60 * 60,
  "regulatory-impact-brief": 60 * 60,
};

export function cacheKey(feed: string, params?: unknown): string {
  if (!params || (typeof params === "object" && Object.keys(params as any).length === 0)) return `feed:${feed}:default`;
  const stable = JSON.stringify(params, Object.keys(params as any).sort());
  const short = stable.length > 200 ? stable.slice(0, 200) : stable;
  let h = 0;
  for (let i = 0; i < short.length; i++) h = (h * 31 + short.charCodeAt(i)) | 0;
  return `feed:${feed}:${Math.abs(h).toString(36)}`;
}

export async function kvGet<T>(env: WithCache, key: string): Promise<{ data: T; t: number } | null> {
  const kv = getKV(env);
  if (!kv) return null;
  try {
    const raw = await kv.get(PREFIX + key, "json");
    if (!raw) return null;
    if (raw && typeof raw === "object" && "data" in raw) return raw as any;
    return null;
  } catch {
    return null;
  }
}

export async function kvPut(env: WithCache, key: string, data: unknown, ttlSec = DEFAULT_TTL_SEC): Promise<void> {
  const kv = getKV(env);
  if (!kv) return;
  try {
    const envelope = { v: 1, t: Date.now(), data };
    await kv.put(PREFIX + key, JSON.stringify(envelope), { expirationTtl: ttlSec });
  } catch (e) {
    console.warn("kvPut failed", key, (e as Error)?.message);
  }
}

export type CachedWrap<T> = { data: T; cached: boolean; age_ms?: number; at?: number };

export async function getCachedOrLive<T>(
  env: WithCache,
  feed: string,
  liveFetcher: () => Promise<T>,
  opts: { params?: unknown; ttlSec?: number; bypass?: boolean } = {}
): Promise<CachedWrap<T>> {
  const key = cacheKey(feed, opts.params);
  if (!opts.bypass) {
    try {
      const hit = await kvGet<T>(env, key);
      if (hit?.data) return { data: hit.data, cached: true, age_ms: Date.now() - hit.t, at: hit.t };
    } catch {}
  }
  const live = await liveFetcher();
  const ttl = opts.ttlSec ?? FEED_TTLS[feed] ?? DEFAULT_TTL_SEC;
  kvPut(env, key, live, ttl).catch(() => {});
  return { data: live, cached: false };
}

export async function kvListKeys(env: WithCache, prefix?: string): Promise<Array<{ name: string; expiration?: number }>> {
  const kv = getKV(env);
  if (!kv?.list) return [];
  try {
    const p = prefix ? PREFIX + prefix : PREFIX;
    const res = await (kv as any).list({ prefix: p, limit: 100 });
    const keys = (res?.keys ?? res ?? []) as Array<{ name: string; expiration?: number }>;
    return keys;
  } catch {
    return [];
  }
}


export type RouteAnalyticsEvent = "metadata_views" | "payment_challenges" | "paid_successes" | "upstream_failures" | "post_other";
export type RouteAnalyticsCounters = Record<RouteAnalyticsEvent, number>;
export type RouteAnalyticsDay = {
  day: string;
  updated_at: string;
  routes: Record<string, Partial<RouteAnalyticsCounters>>;
};

const ANALYTICS_EVENTS: RouteAnalyticsEvent[] = ["metadata_views", "payment_challenges", "paid_successes", "upstream_failures", "post_other"];

function analyticsDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function analyticsKey(day: string): string {
  return `analytics:route-funnel:${day}`;
}

function blankCounters(): RouteAnalyticsCounters {
  return { metadata_views: 0, payment_challenges: 0, paid_successes: 0, upstream_failures: 0, post_other: 0 };
}

export async function routeAnalyticsIncrement(env: WithCache, route: string, event: RouteAnalyticsEvent, amount = 1): Promise<void> {
  const safeRoute = route.startsWith("/paid/") ? route : "/unknown";
  const day = analyticsDay();
  const key = analyticsKey(day);
  const current = (await kvGet<RouteAnalyticsDay>(env, key))?.data ?? { day, updated_at: new Date().toISOString(), routes: {} };
  const existing = { ...blankCounters(), ...(current.routes[safeRoute] ?? {}) };
  existing[event] = (existing[event] ?? 0) + amount;
  current.routes[safeRoute] = existing;
  current.updated_at = new Date().toISOString();
  await kvPut(env, key, current, 60 * 60 * 24 * 35);
}

export async function routeAnalyticsSnapshot(env: WithCache, days = 1): Promise<{ window_days: number; generated_at: string; route_count: number; totals: RouteAnalyticsCounters; routes: Array<RouteAnalyticsCounters & { path: string; challenge_to_paid_rate: number; metadata_to_challenge_rate: number }> }> {
  const boundedDays = Math.max(1, Math.min(35, Math.floor(days || 1)));
  const merged: Record<string, RouteAnalyticsCounters> = {};
  for (let i = 0; i < boundedDays; i++) {
    const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const day = analyticsDay(date);
    const data = (await kvGet<RouteAnalyticsDay>(env, analyticsKey(day)))?.data;
    if (!data?.routes) continue;
    for (const [route, counters] of Object.entries(data.routes)) {
      const target = merged[route] ?? blankCounters();
      for (const event of ANALYTICS_EVENTS) target[event] += Number((counters as any)?.[event] ?? 0);
      merged[route] = target;
    }
  }
  const totals = blankCounters();
  const routes = Object.entries(merged)
    .map(([path, counters]) => {
      for (const event of ANALYTICS_EVENTS) totals[event] += counters[event] ?? 0;
      const payment_challenges = counters.payment_challenges || 0;
      const metadata_views = counters.metadata_views || 0;
      const paid_successes = counters.paid_successes || 0;
      return {
        path,
        ...counters,
        challenge_to_paid_rate: payment_challenges ? Number((paid_successes / payment_challenges).toFixed(4)) : 0,
        metadata_to_challenge_rate: metadata_views ? Number((payment_challenges / metadata_views).toFixed(4)) : 0,
      };
    })
    .sort((a, b) => (b.payment_challenges + b.paid_successes + b.metadata_views) - (a.payment_challenges + a.paid_successes + a.metadata_views));
  return { window_days: boundedDays, generated_at: new Date().toISOString(), route_count: routes.length, totals, routes };
}

export const _PREFIX = PREFIX;
