// AUTO LANE: fred-surprises — FRED no-auth CSV free public-domain gov Fed St Louis
// Upstreams: fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10 (10y), DGS2 (2y spread -> curve inversion), DFEDTARU etc — free public domain, no-key, rate polite
// 2nd upstream: WOOST? No just CSV + fiscaldata expansion already present
// CBP BWT probe also coded as fallback in supply-stress but FRED here gives rates pillar edge for Kalshi Fed/FOMC markets
// Pattern: TokenBucket 2/s polite, fetchWithRetry, normalized rows timestamp/signal/score
// Rip: FRED api is typical pattern per gits/fredapi — fredgraph.csv free path requires no API key, csv parse

import { fetchWithRetry, TokenBucket } from "./rate-limit";

const FRED_BASE = "https://fred.stlouisfed.org/graph/fredgraph.csv";
const bucket = new TokenBucket(2, 1);

function parseCsv(csv: string): Array<{ observation_date: string; value: string }> {
  const lines = csv.trim().split(/\r?\n/);
  const out: Array<{ observation_date: string; value: string }> = [];
  for(let i=1;i<lines.length;i++){
    const line = lines[i].trim();
    if(!line) continue;
    const [date, ...rest] = line.split(",");
    const v = rest.join(",").trim();
    if(date && v !== undefined) out.push({ observation_date: date, value: v });
  }
  return out;
}
function toNum(v: string): number | null {
  if(!v) return null;
  if(v.toLowerCase()===".") return null;
  const n = Number(v.replace(/[,]/g,""));
  return Number.isFinite(n) ? n : null;
}

export type FredRow = { slug: string; timestamp: string; signal: string; score: number; meta?: Record<string,unknown> };

const SERIES: Array<{ id: string; label: string; kind: "rate"|"spread" }> = [
  { id: "DGS10", label: "10Y Treasury %", kind: "rate" },
  { id: "DGS2", label: "2Y Treasury %", kind: "rate" },
];

export async function fetchFredSurprises(opts:{ days?:number; minScore?:number } = {}): Promise<FredRow[]>{
  const days = Math.min(Math.max(opts.days ?? 14, 5), 90);
  const out: FredRow[] = [];
  let last10: number | null = null;
  let last2: number | null = null;
  const seriesData: Record<string, Array<{ date:string; val:number|null }>> = {};
  for(const s of SERIES){
    await bucket.take(1);
    const url = `${FRED_BASE}?id=${encodeURIComponent(s.id)}`;
    let csv: string;
    try{
      csv = await fetchWithRetry(url, { retries: 3, timeoutMs: 15000 }) as unknown as string;
    } catch {
      continue;
    }
    const parsed = parseCsv(csv);
    const recent = parsed.slice(-days).map(p=>({ date: p.observation_date, val: toNum(p.value) }));
    seriesData[s.id] = recent;
    if(s.id==="DGS10") last10 = recent.filter(r=>r.val!=null).slice(-1)[0]?.val ?? null;
    if(s.id==="DGS2") last2 = recent.filter(r=>r.val!=null).slice(-1)[0]?.val ?? null;
    for(const r of recent){
      if(r.val==null) continue;
      const prevDay = recent[recent.indexOf(r)-1];
      const delta = prevDay?.val!=null ? r.val-prevDay.val : null;
      let score = 0.35;
      if(delta!=null && Math.abs(delta) > 0.10) score = 0.70;
      if(delta!=null && Math.abs(delta) > 0.20) score = 0.88;
      out.push({
        slug: `fred-${s.id}-${r.date}`.toLowerCase(),
        timestamp: new Date(`${r.date}T00:00:00Z`).toISOString(),
        signal: `${s.label} ${r.val.toFixed(2)}${delta!=null?` ${delta>=0?"+":""}${delta.toFixed(2)} d/d`:""}`.trim(),
        score: Math.round(score*100)/100,
        meta: { series: s.id, label: s.label, date: r.date, value: r.val, delta, provenance: [{ src:"fred.stlouisfed.org fredgraph.csv", url:`${FRED_BASE}?id=${s.id}`, license:"public domain gov FRED no-key" }] },
      });
    }
  }
  // curve spread bonus row
  if(last10!=null && last2!=null){
    const spread10_2 = last10 - last2;
    const inv = spread10_2 < 0;
    out.unshift({
      slug: `fred-10y2y-${new Date().toISOString().slice(0,10)}`,
      timestamp: new Date().toISOString(),
      signal: `10Y-2Y spread ${spread10_2.toFixed(2)}bps ${inv?"INVERSION":"normal"} DGS10 ${last10.toFixed(2)}% DGS2 ${last2.toFixed(2)}%`,
      score: inv ? 0.82 : (Math.abs(spread10_2) < 0.25 ? 0.65 : 0.40),
      meta: { series:"DGS10-DGS2-spread", spread_10y_2y: spread10_2, dgs10: last10, dgs2: last2, inversion: inv },
    });
  }
  out.sort((a,b)=> b.timestamp.localeCompare(a.timestamp));
  if(typeof opts.minScore === "number") return out.filter(r=> r.score >= opts.minScore!);
  return out.slice(0, 60);
}
export const fetchTodayAuto2 = fetchFredSurprises;
