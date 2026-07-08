/**
 * Deterministic secret + PII scrubber for agenttoll.dev product outputs.

 */

const RE_ETH_PRIV = /(?<![a-fA-F0-9])(?:0x)?[a-fA-F0-9]{64}(?![a-fA-F0-9])/gi;
const RE_PEM = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const RE_JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const RE_BEARER = /\b(bearer|token|api[_-]?key|secret|password|authorization)\b\s*[:=]\s*['"]?([^\s'"\\,;]+)/gi;
const RE_OPENAI = /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/g;
const RE_AWS = /\bAKIA[0-9A-Z]{16}\b/g;
const RE_GITHUB = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g;
const RE_SEED_LINE = /\b(seed[_ -]?phrase|recovery[_ -]?phrase|mnemonic|secret recovery phrase)\b\s*[:=]?\s*.{0,200}/gi;
const RE_BUYER = /\bBUYER_PRIVATE_KEY\b\s*[:=]\s*\S+/gi;
const RE_ENV_ASSIGN = /\b([A-Z][A-Z0-9_]{2,})\b\s*=\s*([^\s'"#]{12,})/g;
const SECRETISH_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PRIVATE|MNEMONIC|SEED|AUTH|COOKIE|CREDENTIAL)/i;

const RE_EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const RE_PHONE = /(?<!\w)(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}(?!\w)/g;
const RE_SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const RE_WORDLIST =
  /\b(?:[a-z]{3,8}\s+){11}[a-z]{3,8}\b|\b(?:[a-z]{3,8}\s+){23}[a-z]{3,8}\b/g;

export type ScrubMode = "secrets" | "pii" | "all";

function hashToken(value: string, prefix: string): string {
  // FNV-1a 32-bit — no crypto dependency needed in Workers
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `[${prefix}:${(h >>> 0).toString(16).padStart(8, "0")}]`;
}

export function scrubSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  out = out.replace(RE_PEM, "[REDACTED_PEM_PRIVATE_KEY]");
  out = out.replace(RE_JWT, "[REDACTED_JWT]");
  out = out.replace(RE_OPENAI, "[REDACTED_API_KEY]");
  out = out.replace(RE_AWS, "[REDACTED_AWS_KEY_ID]");
  out = out.replace(RE_GITHUB, "[REDACTED_GITHUB_TOKEN]");
  out = out.replace(RE_BUYER, "BUYER_PRIVATE_KEY=[REDACTED]");
  out = out.replace(RE_SEED_LINE, (m) => {
    const head = m.split(/[:=]/)[0] ?? "seed";
    return `${head}=[REDACTED_SEED]`;
  });
  out = out.replace(RE_BEARER, (_m, k: string) => `${k}=[REDACTED]`);
  out = out.replace(RE_WORDLIST, "[REDACTED_POSSIBLE_MNEMONIC]");
  out = out.replace(RE_ETH_PRIV, "[REDACTED_ETH_PRIVATE_KEY]");
  out = out.replace(RE_ENV_ASSIGN, (full, name: string, _val: string) => {
    if (SECRETISH_ENV.test(name)) return `${name}=[REDACTED]`;
    return full;
  });
  return out;
}

export function scrubPii(text: string, opts: { hashEmails?: boolean } = {}): string {
  if (!text) return text;
  const hashEmails = opts.hashEmails !== false;
  let out = text;
  out = out.replace(RE_EMAIL, (m) =>
    hashEmails ? hashToken(m.toLowerCase(), "email") : "[REDACTED_EMAIL]",
  );
  out = out.replace(RE_PHONE, "[REDACTED_PHONE]");
  out = out.replace(RE_SSN, "[REDACTED_SSN]");
  return out;
}

export function scrubText(text: string, mode: ScrubMode = "all"): string {
  let out = text || "";
  if (mode === "secrets" || mode === "all") out = scrubSecrets(out);
  if (mode === "pii" || mode === "all") out = scrubPii(out);
  return out;
}

export function scrubScrapePayload<T extends Record<string, unknown>>(payload: T): T {
  const clone = { ...payload } as Record<string, unknown>;
  for (const key of ["title", "description", "text_content", "error"] as const) {
    if (typeof clone[key] === "string") {
      // free-text fields: scrub secrets + PII
      clone[key] = scrubText(clone[key] as string, "all");
    }
  }
  if (clone.meta && typeof clone.meta === "object") {
    const meta: Record<string, string> = {};
    for (const [k, v] of Object.entries(clone.meta as Record<string, string>)) {
      meta[k] = typeof v === "string" ? scrubText(v, "all") : v;
    }
    clone.meta = meta;
  }
  if (Array.isArray(clone.headings)) {
    clone.headings = (clone.headings as Array<{ level: number; text: string }>).map((h) => ({
      ...h,
      text: scrubText(h.text || "", "all"),
    }));
  }
  if (Array.isArray(clone.links)) {
    clone.links = (clone.links as Array<{ href: string; text: string }>).map((l) => ({
      href: scrubSecrets(l.href || ""),
      text: scrubText(l.text || "", "all"),
    }));
  }
  if (Array.isArray(clone.notes)) {
    clone.notes = (clone.notes as string[]).map((n) => scrubText(String(n), "all"));
  }
  if (typeof clone.company_name === "string") {
    clone.company_name = scrubText(clone.company_name, "secrets");
  }
  if (typeof clone.description === "string") {
    clone.description = scrubText(clone.description, "all");
  }
  return clone as T;
}

/** Contact extraction keeps business emails/phones; still strips secrets. */
export function scrubContactPayload<T extends Record<string, unknown>>(payload: T): T {
  const clone = { ...payload } as Record<string, unknown>;
  for (const key of ["title", "error"] as const) {
    if (typeof clone[key] === "string") clone[key] = scrubSecrets(clone[key] as string);
  }
  if (Array.isArray(clone.emails)) {
    clone.emails = (clone.emails as string[]).map((e) => scrubSecrets(String(e).toLowerCase()));
  }
  if (Array.isArray(clone.phones)) {
    clone.phones = (clone.phones as string[]).map((p) => scrubSecrets(String(p)));
  }
  return clone as T;
}
