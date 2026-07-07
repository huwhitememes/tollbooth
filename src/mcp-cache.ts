// MCP cache helper — wraps getCachedOrLive using McpAgent env (this.env)
// Falls back to live if KV missing or fetch fails.
import { getCachedOrLive } from "./cache.js";

type EnvLike = { tollbooth_cache?: any; TOLLBOOTH_CACHE?: any };

export async function mcpGetCachedOrLive<T>(
  env: EnvLike | any,
  feedKey: string,
  liveFn: () => Promise<T>,
  params?: unknown,
): Promise<T> {
  try {
    const kv = (env as any)?.tollbooth_cache ?? (env as any)?.TOLLBOOTH_CACHE;
    if (!kv) return await liveFn();
    const wrapped = await getCachedOrLive(env as any, feedKey, liveFn, { params });
    return wrapped.data as T;
  } catch {
    // on any cache error, go live
    return await liveFn();
  }
}
