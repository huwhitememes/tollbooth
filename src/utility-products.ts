/**
 * Utility Products — Tollbooth x402 MCP
 *
 * Keyless utility APIs:
 * - Exchange rate API (open.er-api.com) — keyless, real-time FX
 * - Business day calculator (pure computation, US federal holidays)
 *
 * All functions return { success, data, cached, meta: { count, source, generated_at } }
 * and handle errors gracefully.
 */

// ─── Constants ───────────────────────────────────────────────────────────

const EXCHANGE_API = "https://open.er-api.com/v6/latest";

const USER_AGENT = "TollboothBot/1.0 Utility/0.9";

// ─── Helpers ─────────────────────────────────────────────────────────────

function nowISO(): string {
  return new Date().toISOString();
}

async function fetchJson(
  url: string,
  opts: RequestInit & { timeoutMs?: number } = {}
): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  try {
    const r = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        ...(opts.headers || {}),
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function ok(data: any, source: string, count?: number) {
  return {
    success: true as const,
    data,
    cached: false,
    meta: {
      count: count ?? 0,
      source,
      generated_at: nowISO(),
    },
  };
}

function fail(error: string, source: string) {
  return {
    success: false as const,
    data: null,
    cached: false,
    meta: {
      count: 0,
      source,
      generated_at: nowISO(),
    },
    error,
  };
}

// ─── 1. getExchangeRates — Keyless FX API ────────────────────────────────

export async function getExchangeRates(base?: string, target?: string) {
  const source = "open.er-api.com (keyless FX)";
  try {
    const baseCurrency = (base ?? "USD").trim().toUpperCase();
    const targetCurrency = target?.trim()?.toUpperCase() ?? null;

    const data = await fetchJson(`${EXCHANGE_API}/${baseCurrency}`);

    const rates: Record<string, number> = data?.rates ?? {};
    const lastUpdated = data?.time_last_update_utc ?? null;
    const nextUpdate = data?.time_next_update_utc ?? null;

    // Filter to specific target if provided
    const filteredRates = targetCurrency
      ? { [targetCurrency]: rates[targetCurrency] ?? null }
      : rates;

    return ok(
      {
        base: baseCurrency,
        target: targetCurrency,
        rates: filteredRates,
        rate_count: Object.keys(filteredRates).length,
        last_updated: lastUpdated,
        next_update: nextUpdate,
      },
      source,
      Object.keys(filteredRates).length
    );
  } catch (e: any) {
    return fail(e?.message ?? String(e), source);
  }
}

// ─── 2. getBusinessDays — Business Day Calculator ────────────────────────

// US Federal Holidays computation (pure logic, no deps)
function getUSFederalHolidays(year: number): Map<string, string> {
  const holidays = new Map<string, string>();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  // New Year's Day (Jan 1, observed on nearest weekday if weekend)
  let nyd = new Date(year, 0, 1);
  if (nyd.getDay() === 0) nyd = new Date(year, 0, 2);
  if (nyd.getDay() === 6) nyd = new Date(year, 0, 1); // Saturday → Friday Jan 1
  holidays.set(fmt(new Date(year, 0, 1)), "New Year's Day");

  // MLK Day (3rd Monday of January)
  const mlk = new Date(year, 0, 1 + (1 - new Date(year, 0, 1).getDay() + 7) % 7 + 14);
  holidays.set(fmt(mlk), "MLK Jr. Day");

  // Presidents' Day (3rd Monday of February)
  const pres = new Date(year, 1, 1 + (1 - new Date(year, 1, 1).getDay() + 7) % 7 + 14);
  holidays.set(fmt(pres), "Presidents' Day");

  // Memorial Day (last Monday of May)
  const mem = new Date(year, 4, 31);
  while (mem.getDay() !== 1) mem.setDate(mem.getDate() - 1);
  holidays.set(fmt(mem), "Memorial Day");

  // Juneteenth (June 19)
  holidays.set(fmt(new Date(year, 5, 19)), "Juneteenth");

  // Independence Day (July 4)
  holidays.set(fmt(new Date(year, 6, 4)), "Independence Day");

  // Labor Day (1st Monday of September)
  const labor = new Date(year, 8, 1);
  while (labor.getDay() !== 1) labor.setDate(labor.getDate() + 1);
  holidays.set(fmt(labor), "Labor Day");

  // Columbus Day (2nd Monday of October)
  const col = new Date(year, 9, 1);
  while (col.getDay() !== 1) col.setDate(col.getDate() + 1);
  col.setDate(col.getDate() + 7);
  holidays.set(fmt(col), "Columbus Day");

  // Veterans Day (Nov 11)
  holidays.set(fmt(new Date(year, 10, 11)), "Veterans Day");

  // Thanksgiving (4th Thursday of November)
  const thanks = new Date(year, 10, 1);
  while (thanks.getDay() !== 4) thanks.setDate(thanks.getDate() + 1);
  thanks.setDate(thanks.getDate() + 21);
  holidays.set(fmt(thanks), "Thanksgiving");

  // Christmas (Dec 25)
  holidays.set(fmt(new Date(year, 11, 25)), "Christmas Day");

  return holidays;
}

function isBusinessDay(date: Date, holidays: Map<string, string>): boolean {
  const day = date.getDay();
  if (day === 0 || day === 6) return false; // weekend
  if (holidays.has(date.toISOString().slice(0, 10))) return false;
  return true;
}

export async function getBusinessDays(
  start_date?: string,
  end_date?: string,
  days_ahead?: number
) {
  const source = "Pure computation (US federal holidays)";
  try {
    const start = start_date?.trim()
      ? new Date(start_date.trim())
      : new Date();
    if (isNaN(start.getTime())) return fail("Invalid start_date", source);

    // Determine end date: explicit end_date or days_ahead from start
    let end: Date;
    if (end_date?.trim()) {
      end = new Date(end_date.trim());
      if (isNaN(end.getTime())) return fail("Invalid end_date", source);
    } else {
      const ahead = Math.max(1, Math.min(365, days_ahead ?? 30));
      end = new Date(start);
      end.setDate(end.getDate() + ahead);
    }

    const yearRange = [start.getFullYear(), end.getFullYear()];
    const holidays = new Map<string, string>();
    for (let y = Math.min(...yearRange); y <= Math.max(...yearRange); y++) {
      getUSFederalHolidays(y).forEach((name, date) => holidays.set(date, name));
    }

    // Count business days and collect holidays in range
    const businessDays: string[] = [];
    const holidaysInRange: { date: string; name: string }[] = [];
    const cursor = new Date(start);
    cursor.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);

    while (cursor <= end) {
      const dateStr = cursor.toISOString().slice(0, 10);
      const holiday = holidays.get(dateStr);
      if (holiday) {
        holidaysInRange.push({ date: dateStr, name: holiday });
      }
      if (isBusinessDay(cursor, holidays)) {
        businessDays.push(dateStr);
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    return ok(
      {
        start_date: start.toISOString().slice(0, 10),
        end_date: end.toISOString().slice(0, 10),
        total_calendar_days: Math.round((end.getTime() - start.getTime()) / 86400000),
        business_day_count: businessDays.length,
        business_days: businessDays,
        holidays_in_range: holidaysInRange,
      },
      source,
      businessDays.length
    );
  } catch (e: any) {
    return fail(e?.message ?? String(e), source);
  }
}
