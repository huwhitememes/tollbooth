// Rate-limit / retry / key-rotation helper — shared across all feeds
// Per playbook: 2+ upstreams, TTL-based cache, exponential backoff 250ms*(attempt+1), 3 retries

type FetchOpts = { retries?: number; timeoutMs?: number; headers?: Record<string,string> };

export async function fetchWithRetry(url: string, opts: FetchOpts = {}){
  const retries = opts.retries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 12000;
  let lastErr: any = null;
  for(let attempt=0; attempt<retries; attempt++){
    try{
      const ctrl = new AbortController();
      const to = setTimeout(()=>ctrl.abort(), timeoutMs);
      const res = await fetch(url, { headers: { "User-Agent": "Tollbooth-OSINT/0.9.0", "Accept":"application/json,*/*", ...(opts.headers||{}) }, signal: ctrl.signal });
      clearTimeout(to);
      if(!res.ok){
        if(res.status===429 || res.status>=500){
          lastErr = new Error(`HTTP ${res.status} for ${url}`);
          await new Promise(r=>setTimeout(r, 250*(attempt+1)));
          continue;
        }
        throw new Error(`HTTP ${res.status} ${await res.text().catch(()=>'')} for ${url}`);
      }
      const ct = res.headers.get("content-type")||"";
      if(ct.includes("json")) return await res.json();
      return await res.text();
    }catch(e){
      lastErr = e;
      if(attempt < retries-1) await new Promise(r=>setTimeout(r, 250*(attempt+1)));
    }
  }
  throw lastErr ?? new Error(`fetch failed ${url}`);
}

export function keyRotator(keys: string[]){
  let i=0;
  return {
    next: ()=>{ const k = keys[i % keys.length]; i++; return k; },
    current: ()=> keys[i % keys.length],
  };
}

export class TokenBucket {
  constructor(private cap: number, private refillPerSec: number){
    this.tokens = cap;
    this.last = Date.now();
  }
  private tokens: number;
  private last: number;
  private refill(){
    const now = Date.now();
    const delta = (now - this.last)/1000;
    this.tokens = Math.min(this.cap, this.tokens + delta*this.refillPerSec);
    this.last = now;
  }
  async take(n=1){
    this.refill();
    if(this.tokens >= n){ this.tokens -= n; return; }
    const needed = n - this.tokens;
    const waitMs = (needed/this.refillPerSec)*1000;
    await new Promise(r=>setTimeout(r, waitMs));
    this.refill();
    this.tokens -= n;
  }
}
