// AUTO LANE: sec-8k-velocity — 8-K spike (EDGAR EFTS + Atom)
// Upstreams: free public no-key but UA required per edgar/_Downloader.py:49 + httpclient.py:180 9/s
// - EFTS: https://efts.sec.gov/LATEST/search-index JSON api (q= formType:"8-K" sort file_date)
// - Atom: https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&...&output=atom -- CompanyName Email UA mandated
// Value: filings last 1h vs 24h mean >3x spike -> earnings/merger/legal tail for Poly/Kalshi
// Rip notes: gits/edgartools efts.py:28 _fetch_page params, :81 filtered file_type prefix, :180 Rate 9/s, :350-550 search_filings client

import { fetchWithRetry, TokenBucket } from "./rate-limit";

const EFTS = "https://efts.sec.gov/LATEST/search-index";
const ATOM = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&CIK=&type=8-K&company=&dateb=&owner=include&start=0&count=100&output=atom";
// SEC requires CompanyName Email per 17 CFR 200.80 — edgar/edgar/_Downloader.py:49 realistic UA
const SEC_UA = "Sample Company admin@example.com Tollbooth-OSINT/0.9.0 Money-Stack Research";
// EDGAR rate limit 9/sec per edgar/httpclient.py:180 get_edgar_rate_limit_per_sec() enforcement via RateLimiter
const bucket = new TokenBucket(9, 9);

export type Sec8kRow = { slug: string; timestamp: string; signal: string; score: number; meta?: Record<string, unknown> };

function parseAtomEntries(xml: string): Array<{title:string; link:string; pubDate:string; summary:string}>{
  const out: Array<{title:string;link:string;pubDate:string;summary:string}> = [];
  const re = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;
  let m: RegExpExecArray | null;
  while((m = re.exec(xml)) !== null && out.length < 120){
    const b = m[1];
    const pick = (tag:string)=>{
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
      const hit = r.exec(b);
      if(!hit) return "";
      return hit[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g,"").trim().slice(0,600);
    };
    const linkMatch = /<link[^>]*href="([^\"]+)"[^>]*>/i.exec(b);
    out.push({ title: pick("title"), link: linkMatch ? linkMatch[1] : "", pubDate: pick("updated") || pick("published"), summary: pick("summary") || pick("content") });
  }
  return out;
}

type EftsHit = { _score:number; _source:{ form:string; file_date:string; display_names?:string[]; adsh?:string; items?:string[]; file_type?:string } };

export async function fetchSec8kVelocity(opts:{ hours?:number; minScore?:number; limit?:number; atomFallback?:boolean } = {}): Promise<Sec8kRow[]>{
  const hours = Math.min(Math.max(opts.hours ?? 6, 1), 72);
  const limit = Math.min(Math.max(opts.limit ?? 100, 10), 200);
  const now = Date.now();
  const windowMs = hours*3600*1000;
  const rows: Sec8kRow[] = [];

  let eftsHits: EftsHit[] = [];
  try {
    await bucket.take(1);
    // EFTS query: q= "8-K" + sort file_date desc per efts.py:28 + search_filings forms="8-K"
    const url = `${EFTS}?q=%22formType%3A%5C%228-K%5C%22%22&dateRange=custom&startdt=${new Date(now - Math.max(windowMs, 24*3600*1000)).toISOString().slice(0,10)}&forms=8-K`;
    const j = await fetchWithRetry(url, { retries: 3, timeoutMs: 12000, headers: { "User-Agent": SEC_UA, "Accept":"application/json" } }) as any;
    const hits = j?.hits?.hits ?? [];
    eftsHits = (hits as EftsHit[]).slice(0, limit);
  } catch { /* EFTS occasionally 403 without cookie — try Atom */ }

  if(eftsHits.length){
    // bucket by hour for velocity calc — template {hour} per local-tooling normalization reasoning
    const hourly: Record<string, number> = {};
    const nowH = Math.floor(now/(3600*1000));
    for(const h of eftsHits){
      const fd = h._source?.file_date ?? "";
      const ts = Date.parse(fd);
      if(!isFinite(ts)) continue;
      const hk = Math.floor(ts/(3600*1000)).toString();
      hourly[hk] = (hourly[hk] ?? 0) + 1;
    }
    const hoursArr = Object.entries(hourly).sort(([a],[b])=>Number(b)-Number(a));
    const last1hCount = (()=>{ const recentCut = Math.floor((now-windowMs)/3600000); let c=0; for(const [hk,cnt] of hoursArr){ if(Number(hk) >= recentCut) c+=cnt; } return c || eftsHits.filter(h=> Date.now()-Date.parse(h._source.file_date) < windowMs).length; })();
    const last24hTotal = eftsHits.length;
    const mean24 = last24hTotal/24;
    const ratio = mean24 ? last1hCount / mean24 : last1hCount;

    for(const h of eftsHits){
      const src = h._source;
      const company = (src.display_names?.[0] ?? "Unknown").slice(0,120);
      const filed = src.file_date ?? new Date().toISOString();
      const items = (src.items ?? []).join(",");
      const acc = (src.adsh ?? "").replace(/-/g,"").slice(0,20);
      let score = 0.35 + Math.min(0.4, (ratio/6));
      // boost Item 1.01/2.02/5.02 material events per 8-K Item table
      if(/1\.0[15]|2\.0(?:[125])|4\.0[12]|5\.0(?:[12])/i.test(items)) score = Math.min(1, score+0.25);
      if(/cyber|security incident|1\.05/i.test(items + src.form + company)) score = Math.min(1, score+0.15);
      rows.push({
        slug: `sec-8k-${acc || Date.parse(filed)}-${company.slice(0,12).replace(/[^A-Za-z0-9]+/g,"-").toLowerCase()}`,
        timestamp: new Date(filed).toISOString(),
        signal: `${company} filed ${src.form || "8-K"} Item ${items || "?"} type ${src.file_type||""} filed ${filed} — 1h:${last1hCount} vs 24h mean ${mean24.toFixed(1)} ratio ${ratio.toFixed(2)}x`,
        score: Math.round(score*100)/100,
        meta: { _score: h._score, form: src.form, file_date: filed, company, items, file_type: src.file_type, adsh: src.adsh, velocity: { last_1h: last1hCount, mean_24h: Number(mean24.toFixed(2)), ratio: Number(ratio.toFixed(2)), total_window: last24hTotal } },
      });
    }
    const sorted = rows.sort((a,b)=> b.timestamp.localeCompare(a.timestamp));
    if(typeof opts.minScore === "number") return sorted.filter(r=> r.score >= opts.minScore!);
    return sorted;
  }

  // Atom fallback — when EFTS 403 (needs App-Cookie) we fall back to Atom which is documented in registry as public-domain no-auth but UA mandated
  if(opts.atomFallback !== false){
    try{
      await bucket.take(1);
      const xml = await fetchWithRetry(ATOM, { retries: 2, timeoutMs: 12000, headers: { "User-Agent": SEC_UA, "Accept":"application/atom+xml,text/xml,*/*" } }) as unknown as string;
      const entries = typeof xml === "string" ? parseAtomEntries(xml) : [];
      for(const e of entries.slice(0, limit)){
        rows.push({
          slug: `sec-8k-atom-${(e.link.match(/data\/\d+\/([^/]+)\/[^/]+$/)?.[1] || e.title.replace(/[^A-Za-z0-9]+/g,"-").slice(0,30)).toLowerCase()}`,
          timestamp: (()=>{ try { return new Date(e.pubDate).toISOString(); } catch { return new Date().toISOString(); } })(),
          signal: `${e.title.slice(0,140)} — ${e.summary.slice(0,160)}`,
          score: 0.45,
          meta: { source: "sec-edgar-current-atom", link: e.link, title: e.title, published: e.pubDate, summary: e.summary, atom_url: ATOM, license: "public-domain gov", provenance: [{ src:"SEC EDGAR Atom getcurrent 8-K", url: ATOM, ua_required:"CompanyName Email per 17 CFR 200.80" }] },
        });
      }
      rows.sort((a,b)=> b.timestamp.localeCompare(a.timestamp));
      if(typeof opts.minScore==="number") return rows.filter(r=> r.score >= opts.minScore!);
      return rows;
    }catch{ /* empty */ }
  }

  return [{ slug:`sec-8k-empty-${new Date().toISOString().slice(0,10)}`, timestamp:new Date().toISOString(), signal:`SEC 8-K empty EFTS ${EFTS} + Atom ${ATOM} — both unreachable`, score:0.05, meta:{ error:true } }];
}

export const fetchTodayAuto = fetchSec8kVelocity;
