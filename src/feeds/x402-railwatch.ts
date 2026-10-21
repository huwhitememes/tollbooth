// x402 rail watch — live GitHub pulse on the x402 ecosystem + curated rail ledger
// Feeds the "sell the intel" wedge: who is building on the agent payment standard, ranked, with a judgment layer.

const UA = "TollboothBot/1.0 (agenttoll.dev)";

async function ghJson(url: string): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/vnd.github+json" }, signal: ctrl.signal } as any);
    if (!r.ok) throw new Error(`gh ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// Live ecosystem: top x402 repos by stars, plus new entrants (last 30 days)
export async function fetchX402Ecosystem(opts: { limit?: number } = {}) {
  const fetched_at = new Date().toISOString();
  const limit = Math.min(Math.max(opts.limit ?? 25, 5), 50);
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const createdSince = since.toISOString().slice(0, 10);
  try {
    const [top, fresh] = await Promise.all([
      ghJson(`https://api.github.com/search/repositories?q=x402+in:name,description&sort=stars&order=desc&per_page=${limit}`),
      ghJson(`https://api.github.com/search/repositories?q=x402+in:name,description+created:%3E${createdSince}&sort=stars&order=desc&per_page=15`),
    ]);
    const mapRepo = (it: any) => ({
      repo: it.full_name ?? null,
      stars: it.stargazers_count ?? 0,
      forks: it.forks_count ?? 0,
      lang: it.language ?? null,
      pushed: it.pushed_at ?? null,
      created: it.created_at ?? null,
      desc: String(it.description ?? "").slice(0, 240),
      url: it.html_url ?? null,
    });
    return {
      fetched_at,
      top: (Array.isArray(top?.items) ? top.items : []).map(mapRepo),
      new_entrants_30d: (Array.isArray(fresh?.items) ? fresh.items : []).map(mapRepo),
      total_repo_count: top?.total_count ?? null,
      error: null as string | null,
    };
  } catch (e: any) {
    return { fetched_at, top: [], new_entrants_30d: [], total_repo_count: null, error: e?.message ?? String(e) };
  }
}

// Watchlist: fixed set of ecosystem-critical repos, live stats (all verified 200 on 2026-10-08)
const WATCH_REPOS = [
  "x402-foundation/x402",
  "coinbase/x402",
  "solana-foundation/pay",
];

export async function fetchX402Watchlist() {
  const fetched_at = new Date().toISOString();
  const results = await Promise.allSettled(
    WATCH_REPOS.map(async (repo) => {
      const j = await ghJson(`https://api.github.com/repos/${repo}`);
      return {
        repo: j.full_name ?? repo,
        stars: j.stargazers_count ?? 0,
        forks: j.forks_count ?? 0,
        open_issues: j.open_issues_count ?? 0,
        pushed: j.pushed_at ?? null,
        desc: String(j.description ?? "").slice(0, 240),
        url: j.html_url ?? `https://github.com/${repo}`,
      };
    })
  );
  const rows = results.filter(r => r.status === "fulfilled").map(r => (r as PromiseFulfilledResult<any>).value);
  const failed = results.filter(r => r.status === "rejected").map(r => (r as PromiseRejectedResult).reason?.message ?? "unknown");
  return { fetched_at, rows, failed_count: failed.length };
}

// Curated rail ledger — explicit dating, no invented numbers. Sources are the ones
// reported in the Sep 21-30 2026 announcement window coverage.
const CURATED = {
  as_of: "2026-10-08",
  headline: "Five new lanes announced in ten days. Agentic share of settled value still reads under ten percent. Supply is running ahead of demand.",
  rails: [
    { chain: "Bitcoin", rail: "Lightning via Block joining the x402 Foundation", status: "announced Sep 25", why_it_matters: "First non-EVM anchor rail. Opens BTC-native agent wallets to x402.", source: "Blockonomi (Sep 25)" },
    { chain: "Cardano", rail: "ADA facilitator + official x402 SDK support", status: "announced Sep 22, facilitator off mainnet", why_it_matters: "SDK integration signals builder-side commitment before infrastructure ships. Watch for the facilitator going live.", source: "The Street (Sep 22)" },
    { chain: "Algorand", rail: "x402 facilitator", status: "public preview targeted at month's end (stated Sep 21)", why_it_matters: "Instant-finality chain pitching machine-speed settlement for per-call payments.", source: "TradingView (Sep 21)" },
    { chain: "Solana", rail: "Batch settlement via Sunrise (v1.5)", status: "live", why_it_matters: "Sub-second finality attacks the latency constraint on micropayment settlement.", source: "AMBCrypto (Sep 29)" },
    { chain: "Base (Ethereum L2)", rail: "USDC exact scheme — the reference rail", status: "dominant settled volume", why_it_matters: "Where real settlement happens today. Every new rail is bidding against this default.", source: "TRM Labs (Sep 2026)" },
  ],
  read: "Watch the facilitator layer, not the announcements. A rail becomes real when a third-party facilitator settles its first paid call. Until then it is a press release. On demand: TRM Labs put agentic share of screened settled x402 value at 0.6 to 7.5 percent in September. Lanes are multiplying faster than traffic. The edge is positioning where settlement actually happens before the crowd reroutes.",
};

export async function buildRailWatch(opts: { section?: string; limit?: number } = {}) {
  const generated_at = new Date().toISOString();
  const section = opts.section === "ecosystem" || opts.section === "watchlist" || opts.section === "brief" ? opts.section : "all";
  const out: Record<string, unknown> = { generated_at, source: "GitHub Search/REST API + curated rail ledger", section };
  if (section === "all" || section === "ecosystem") out.ecosystem = await fetchX402Ecosystem({ limit: opts.limit });
  if (section === "all" || section === "watchlist") out.watchlist = await fetchX402Watchlist();
  if (section === "all" || section === "brief") out.brief = CURATED;
  return out;
}
