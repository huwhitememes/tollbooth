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

export const _PREFIX = PREFIX;
