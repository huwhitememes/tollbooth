/**
 * Tollbooth scraper + enrichment engine
 * Runs inside Cloudflare Workers — uses HTMLRewriter (built-in, zero deps)
 */

import { scrubScrapePayload, scrubSecrets, scrubText, type ScrubMode } from "./pii-scrub";

const USER_AGENT =
  "Mozilla/5.0 (compatible; agenttoll.dev/1.0; +https://agenttoll.dev)";

const TECH_PATTERNS: Array<[string, RegExp]> = [
  ["next.js", /_next\/|__NEXT_DATA__/i],
  ["nuxt", /_nuxt\/|__nuxt/i],
  ["react", /react(-dom)?\.|data-reactroot/i],
  ["vue", /vue\.(min\.)?js|data-v-/i],
  ["angular", /ng-version|angular\./i],
  ["svelte", /svelte-/i],
  ["wordpress", /wp-content|wp-includes/i],
  ["shopify", /cdn\.shopify|shopify\./i],
  ["squarespace", /squarespace/i],
  ["wix", /wix\.com|wixstatic/i],
  ["webflow", /webflow/i],
  ["ghost", /ghost/i],
  ["cloudflare", /cloudflare/i],
  ["vercel", /vercel/i],
  ["stripe", /stripe\.(com|js|pk_|chk)/i],
  ["google-analytics", /google-analytics\.com|gtag\(|GA_|googletagmanager/i],
  ["tailwind", /tailwind/i],
  ["bootstrap", /bootstrap/i],
  ["jquery", /jquery/i],
  ["hotjar", /hotjar/i],
  ["intercom", /intercom/i],
  ["hubspot", /hubspot|hsforms/i],
  ["segment", /segment\.(com|io|analytics)/i],
  ["sentry", /sentry/i],
  ["plausible", /plausible/i],
];

export interface ScrapeResult {
  url: string;
  final_url: string;
  status: number;
  content_type: string;
  title: string;
  description: string;
  meta: Record<string, string>;
  text_content: string;
  word_count: number;
  headings: { level: number; text: string }[];
  links: { href: string; text: string }[];
  tech_signals: string[];
  scraped_at: string;
  error?: string;
}

export interface LeadEnrichment {
  domain: string;
  url: string;
  status: number;
  company_name: string;
  description: string;
  tech_stack: string[];
  social: Record<string, string>;
  open_graph: Record<string, string>;
  dns: { a: string[]; ns: string[] };
  https: boolean;
  detected_platform: string | null;
  contact_links: string[];
  notes: string[];
  enriched_at: string;
  error?: string;
}

function detectTech(parts: string[]): string[] {
  const combined = parts.join(" ");
  return TECH_PATTERNS.filter(([, p]) => p.test(combined)).map(([n]) => n);
}

function normalizeDomain(input: string): { domain: string; url: string } {
  let d = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .replace(/^www\./, "");
  return { domain: d, url: `https://${d}` };
}

function resolveUrl(href: string, base: string): string | null {
  if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:"))
    return null;
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

async function dnsLookup(domain: string): Promise<{ a: string[]; ns: string[] }> {
  try {
    const [aRes, nsRes] = await Promise.all([
      fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=A`, {
        headers: { Accept: "application/dns-json" },
      }),
      fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=NS`, {
        headers: { Accept: "application/dns-json" },
      }),
    ]);
    const [aData, nsData] = (await Promise.all([aRes.json(), nsRes.json()])) as any[];
    return {
      a: (aData.Answer || []).filter((r: any) => r.type === 1).map((r: any) => r.data),
      ns: (nsData.Answer || []).filter((r: any) => r.type === 2).map((r: any) => r.data),
    };
  } catch {
    return { a: [], ns: [] };
  }
}

function extractSocial(links: { href: string; text: string }[]): Record<string, string> {
  const s: Record<string, string> = {};
  for (const l of links) {
    if (/twitter\.com|x\.com/i.test(l.href) && !s.twitter) s.twitter = l.href;
    else if (/github\.com/i.test(l.href) && !s.github) s.github = l.href;
    else if (/linkedin\.com/i.test(l.href) && !s.linkedin) s.linkedin = l.href;
    else if (/youtube\.com/i.test(l.href) && !s.youtube) s.youtube = l.href;
    else if (/discord\.(com|gg)/i.test(l.href) && !s.discord) s.discord = l.href;
  }
  return s;
}

function detectPlatform(tech: string[]): string | null {
  for (const p of ["wordpress", "shopify", "squarespace", "wix", "webflow", "ghost"])
    if (tech.includes(p)) return p;
  return null;
}

function applyScrapeScrub<T extends Record<string, unknown>>(payload: T, mode: ScrubMode | "none"): T {
  if (mode === "none") return payload;
  if (mode === "secrets") {
    // secrets only — preserve business emails/phones for contact tools
    const clone = { ...payload } as Record<string, unknown>;
    for (const key of ["title", "description", "text_content", "error", "company_name"] as const) {
      if (typeof clone[key] === "string") clone[key] = scrubSecrets(clone[key] as string);
    }
    if (clone.meta && typeof clone.meta === "object") {
      const meta: Record<string, string> = {};
      for (const [k, v] of Object.entries(clone.meta as Record<string, string>)) {
        meta[k] = typeof v === "string" ? scrubSecrets(v) : v;
      }
      clone.meta = meta;
    }
    if (Array.isArray(clone.headings)) {
      clone.headings = (clone.headings as Array<{ level: number; text: string }>).map((h) => ({
        ...h,
        text: scrubSecrets(h.text || ""),
      }));
    }
    if (Array.isArray(clone.links)) {
      clone.links = (clone.links as Array<{ href: string; text: string }>).map((l) => ({
        href: scrubSecrets(l.href || ""),
        text: scrubSecrets(l.text || ""),
      }));
    }
    return clone as T;
  }
  return scrubScrapePayload(payload);
}

export async function scrapeUrl(
  rawUrl: string,
  opts: { scrub?: ScrubMode | "none" } = {},
): Promise<ScrapeResult> {
  const scrubMode = opts.scrub ?? "all";
  const now = new Date().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(rawUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/json,text/plain",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);

    const contentType = response.headers.get("content-type") || "unknown";
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });

    // JSON: return raw text (still useful for agents)
    if (contentType.includes("json")) {
      const text = await response.text();
      const clipped = text.substring(0, 50000);
      return applyScrapeScrub({
        url: rawUrl,
        final_url: response.url,
        status: response.status,
        content_type: contentType,
        title: "",
        description: "",
        meta: {},
        text_content: clipped,
        word_count: clipped.split(/\s+/).filter(Boolean).length,
        headings: [],
        links: [],
        tech_signals: detectTech([text, ...Object.values(responseHeaders)]),
        scraped_at: now,
      }, scrubMode);
    }

    // HTML: parse with HTMLRewriter
    let title = "";
    let description = "";
    const meta: Record<string, string> = {};
    const headings: { level: number; text: string }[] = [];
    const contentBlocks: string[] = [];
    const links: { href: string; text: string }[] = [];
    const scripts: string[] = [];

    let titleBuf = "";
    let hBuf = "";
    let hLevel = 0;
    let pBuf = "";
    let linkBuf = "";
    let linkHref = "";

    const transformed = new HTMLRewriter()
      .on("title", {
        element(el: any) {
          titleBuf = "";
          el.onEndTag(() => {
            title = titleBuf.trim();
          });
        },
        text(t: any) {
          titleBuf += t.text;
        },
      })
      .on("meta[name='description'], meta[property='og:description']", {
        element(el: any) {
          const c = el.getAttribute("content");
          if (c && !description) description = c;
        },
      })
      .on("meta", {
        element(el: any) {
          const name = el.getAttribute("name") || el.getAttribute("property");
          const content = el.getAttribute("content");
          if (name && content) meta[name] = content;
        },
      })
      .on("h1,h2,h3,h4,h5,h6", {
        element(el: any) {
          hLevel = parseInt(el.tagName[1]);
          hBuf = "";
          el.onEndTag(() => {
            const t = hBuf.trim();
            if (t) {
              headings.push({ level: hLevel, text: t });
              contentBlocks.push(`${"#".repeat(hLevel)} ${t}`);
            }
          });
        },
        text(t: any) {
          hBuf += t.text;
        },
      })
      .on("p", {
        element(el: any) {
          pBuf = "";
          el.onEndTag(() => {
            const t = pBuf.trim();
            if (t.length > 20) contentBlocks.push(t);
          });
        },
        text(t: any) {
          pBuf += t.text;
        },
      })
      .on("a[href]", {
        element(el: any) {
          linkHref = el.getAttribute("href") || "";
          linkBuf = "";
          el.onEndTag(() => {
            const resolved = resolveUrl(linkHref, response.url);
            if (resolved && links.length < 100)
              links.push({ href: resolved, text: linkBuf.trim().substring(0, 100) });
          });
        },
        text(t: any) {
          linkBuf += t.text;
        },
      })
      .on("script[src]", {
        element(el: any) {
          const s = el.getAttribute("src");
          if (s) scripts.push(s);
        },
      })
      .transform(response);

    await transformed.text();

    const techParts = [
      ...scripts,
      ...Object.values(meta),
      ...Object.entries(responseHeaders).map(([k, v]) => `${k}:${v}`),
    ];
    const tech = detectTech(techParts);
    const fullText = contentBlocks.join("\n\n");

    return applyScrapeScrub({
      url: rawUrl,
      final_url: response.url,
      status: response.status,
      content_type: contentType,
      title,
      description,
      meta,
      text_content: fullText.substring(0, 50000),
      word_count: fullText.split(/\s+/).filter(Boolean).length,
      headings: headings.slice(0, 50),
      links: links.slice(0, 100),
      tech_signals: tech,
      scraped_at: now,
    }, scrubMode);
  } catch (err) {
    clearTimeout(timeout);
    return applyScrapeScrub({
      url: rawUrl,
      final_url: rawUrl,
      status: 0,
      content_type: "",
      title: "",
      description: "",
      meta: {},
      text_content: "",
      word_count: 0,
      headings: [],
      links: [],
      tech_signals: [],
      scraped_at: now,
      error: err instanceof Error ? err.message : String(err),
    }, scrubMode);
  }
}

export async function enrichDomain(input: string): Promise<LeadEnrichment> {
  const now = new Date().toISOString();
  const { domain, url } = normalizeDomain(input);

  const [scrape, dns] = await Promise.all([scrapeUrl(url), dnsLookup(domain)]);

  const social = extractSocial(scrape.links);
  const tech = scrape.tech_signals;
  const platform = detectPlatform(tech);

  const contactLinks = scrape.links
    .filter((l) => /\/(contact|about|team|careers|jobs|pricing|blog)/i.test(l.href))
    .map((l) => l.href)
    .slice(0, 10);

  const notes: string[] = [];
  if (scrape.error) notes.push(`Homepage fetch error: ${scrape.error}`);
  if (dns.a.length === 0) notes.push("No A records found.");
  if (scrape.status >= 400) notes.push(`Homepage returned HTTP ${scrape.status}.`);
  if (tech.length > 0) notes.push(`Detected ${tech.length} tech signals.`);
  if (platform) notes.push(`Site appears to run on ${platform}.`);
  if (scrape.links.length === 0) notes.push("No links extracted (JS-heavy site?).");

  const companyName =
    scrape.title.replace(/\s*[|·–-].*$/, "").trim() || domain;

  return scrubScrapePayload({
    domain,
    url: scrape.final_url,
    status: scrape.status,
    company_name: companyName,
    description: scrape.description || scrape.meta["og:description"] || "",
    tech_stack: tech,
    social,
    open_graph: Object.fromEntries(
      Object.entries(scrape.meta).filter(([k]) => k.startsWith("og:")),
    ),
    dns,
    https: url.startsWith("https://"),
    detected_platform: platform,
    contact_links: contactLinks,
    notes: notes.map((n) => scrubText(n, "all")),
    enriched_at: now,
    error: scrape.error,
  });
}
