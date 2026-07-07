// AUTO LANE: Treasury DTS — TGA cash balance -> liquidity / debt-ceiling signal
// Upstream: https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/dts/operating_cash_balance
// Filter: record_date:gte:YYYY-MM-DD | Free public no-key, public domain
// 2nd upstream: deposits_withdrawals_operating_cash (same base, enrichment)
// Pattern: fetchWithRetry + TokenBucket per ./rate-limit.ts, no circular import

import { fetchWithRetry, TokenBucket } from "./rate-limit";

const BASE = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/dts";
const BAL_URL = `${BASE}/operating_cash_balance`;
const DEP_URL = `${BASE}/deposits_withdrawals_operating_cash`;

const bucket = new TokenBucket(5, 1);

function daysAgo(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function toNum(v: unknown): number | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === "null") return null;
  const n = Number(s.replace(/[, ]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function scoreBal(closeM: number | null, deltaM: number | null): number {
  if (closeM == null) return 0.4;
  let b = 0.35;
  if (closeM < 250) b = 0.95;
  else if (closeM < 400) b = 0.85;
  else if (closeM < 550) b = 0.7;
  else if (closeM > 850) b = 0.62;
  else if (closeM > 700) b = 0.5;
  if (deltaM != null) {
    const a = Math.abs(deltaM);
    if (a > 80) b = Math.min(1, b + 0.25);
    else if (a > 50) b = Math.min(1, b + 0.15);
    else if (a > 25) b = Math.min(1, b + 0.07);
  }
  return Math.round(b * 100) / 100;
}

export type TreasuryDtsRow = {
  slug: string;
  timestamp: string;
  signal: string;
  score: number;
  meta?: Record<string, unknown>;
};
export type TodayAutoRow = TreasuryDtsRow;

export async function fetchTreasuryDts(opts: { days?: number; minScore?: number } = {}): Promise<TreasuryDtsRow[]> {
  const from = daysAgo(Math.min(Math.max(opts.days ?? 7, 2), 30));
  const url = `${BAL_URL}?filter=record_date:gte:${from}&sort=-record_date&page[size]=50`;

  await bucket.take(1);
  let raw: any;
  try {
    raw = await fetchWithRetry(url, { retries: 3, timeoutMs: 12000 });
  } catch {
    await bucket.take(1);
    raw = await fetchWithRetry(`${BAL_URL}?sort=-record_date&page[size]=20`, { retries: 2 }).catch(() => ({ data: [] }));
  }

  const rows: any[] = Array.isArray(raw?.data) ? raw.data : [];
  if (!rows.length) {
    return [{
      slug: `treasury-dts-empty-${from}`,
      timestamp: new Date().toISOString(),
      signal: `DTS empty for >=${from}`,
      score: 0.1,
      meta: { from },
    }];
  }

  const byDate = new Map<string, any[]>();
  for (const r of rows) if (r.record_date) (byDate.get(r.record_date) ?? byDate.set(r.record_date, []).get(r.record_date)!).push(r);
  const dates = [...byDate.keys()].sort().reverse();

  let enrich: any[] = [];
  try {
    await bucket.take(1);
    const dep = await fetchWithRetry(`${DEP_URL}?filter=record_date:eq:${dates[0]}&page[size]=20`, { retries: 2, timeoutMs: 8000 }).catch(() => null);
    enrich = Array.isArray((dep as any)?.data) ? (dep as any).data : [];
  } catch {}

  const out: TreasuryDtsRow[] = [];
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const day = byDate.get(date)!;
    const closing = day.find((r) => /Closing Balance/i.test(r.account_type)) ?? null;
    const opening = day.find((r) => (/Opening Balance/i.test(r.account_type) && !/This Month|Fiscal/.test(r.account_type)) || r.src_line_nbr === 1)
      ?? day.find((r) => r.account_type === "Treasury General Account (TGA) Opening Balance") ?? null;
    const deposits = day.find((r) => /Deposits/.test(r.account_type)) ?? null;
    const withdrawals = day.find((r) => /Withdrawals/.test(r.account_type)) ?? null;

    const closeM = toNum(closing?.open_today_bal ?? closing?.open_month_bal ?? closing?.close_today_bal);
    const openM = toNum(opening?.open_today_bal);
    const depM = toNum(deposits?.open_today_bal);
    const withM = toNum(withdrawals?.open_today_bal);

    let prevCloseM: number | null = null;
    const older = dates[i + 1];
    if (older) {
      const od = byDate.get(older) ?? [];
      const oc = od.find((r) => /Closing/.test(r.account_type));
      prevCloseM = toNum(oc?.open_today_bal ?? oc?.open_month_bal);
    }
    const deltaM = closeM != null && prevCloseM != null ? closeM - prevCloseM : null;

    const parts: string[] = [];
    if (closeM != null) parts.push(`TGA $${(closeM / 1000).toFixed(1)}B`);
    if (deltaM != null) parts.push(`${deltaM >= 0 ? "+" : ""}${(deltaM / 1000).toFixed(1)}B d/d`);
    if (depM != null) parts.push(`dep ${(depM / 1000).toFixed(1)}B`);
    if (withM != null) parts.push(`wd ${(withM / 1000).toFixed(1)}B`);

    out.push({
      slug: `treasury-dts-${date}`,
      timestamp: new Date(`${date}T00:00:00Z`).toISOString(),
      signal: parts.join(" | ") || `${date} TGA`,
      score: scoreBal(closeM, deltaM),
      meta: {
        record_date: date,
        close_m: closeM,
        open_m: openM,
        dep_m: depM,
        with_m: withM,
        delta_m: deltaM,
        enrich: enrich.slice(0, 3).map((e: any) => ({ t: e.account_type, b: e.open_today_bal })),
        provenance: [
          { src: "fiscaldata.treasury.gov DTS", url: BAL_URL, license: "public domain gov no-key", filter: `record_date:gte:${from}` },
          { src: "DTS deposits_withdrawals", url: DEP_URL, license: "public domain" },
        ],
      },
    });
  }

  out.sort((a, b) => (b.timestamp > a.timestamp ? 1 : -1));
  return typeof opts.minScore === "number" ? out.filter((r) => r.score >= opts.minScore!) : out;
}

export const fetchTodayAuto = fetchTreasuryDts;
export async function fetchTreasuryDtsTodayAuto(): Promise<TreasuryDtsRow[]> {
  return fetchTreasuryDts({ days: 7 });
}

// lightweight raw variant required by spec naming
export async function fetchTodayAutoFeed(opts: { days?: number } = {}) {
  const from = daysAgo(opts.days ?? 7);
  await bucket.take(1);
  const raw = await fetchWithRetry(`${BAL_URL}?filter=record_date:gte:${from}&sort=-record_date&page[size]=30`, {
    retries: 3,
    timeoutMs: 12000,
  }) as any;
  const rows = Array.isArray(raw?.data) ? raw.data : [];
  return rows.map((r: any) => ({
    slug: `today-auto-${r.record_date}-${String(r.account_type).slice(0, 18).replace(/\s+/g, "-").toLowerCase()}`,
    timestamp: new Date(`${r.record_date}T00:00:00Z`).toISOString(),
    signal: `${r.account_type} $${r.open_today_bal ?? r.close_today_bal ?? "n/a"}M ${r.record_date}`,
    score: 0.5,
    meta: r,
  }));
}
