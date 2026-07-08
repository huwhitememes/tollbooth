/**
 * Agent Security Intel — data products for x402 paid tools.
 *
 * Sources:
 * - OWASP Agentic Top 10 (CC BY-SA 4.0) — taxonomy + mappings
 * - Microsoft AGT (MIT) — policy patterns
 * - Public incident facts (postmark-mcp, etc.) — IOCs
 * - Simon Willison / CSA lethal trifecta methodology — scoring model
 *
 * Attribution included in every response. Derivative of OWASP material
 * is CC BY-SA 4.0.
 */

const LICENSE_NOTE =
  "Threat taxonomy derived from OWASP Agentic Top 10 (CC BY-SA 4.0). Policy patterns inspired by Microsoft AGT (MIT). IOC feed from public incident reports. Lethal trifecta model from Simon Willison / Cloud Security Alliance.";

// ─── 1. OWASP Agentic Threat Catalog ──────────────────────────────────────

export interface ThreatEntry {
  id: string;
  category: string;
  threat: string;
  description: string;
  detection_hints: string[];
  mitigations: string[];
  mapped_security_rules: string[];
  severity: "critical" | "high" | "medium";
  source: string;
  license: string;
}

const THREAT_CATALOG: ThreatEntry[] = [
  {
    id: "ASI01",
    category: "Agent Goal Hijack",
    threat: "Indirect prompt injection redirects agent from user's intended goal",
    description:
      "Untrusted content (web pages, emails, documents) contains instructions that override the agent's task. The agent follows attacker instructions instead of the operator's.",
    detection_hints: [
      "ignore previous instructions",
      "you are now",
      "new role",
      "override your policy",
      "disregard system prompt",
    ],
    mitigations: [
      "Treat all external content as untrusted data, not instructions",
      "Separate content channels from instruction channels in the prompt",
      "Use deterministic instruction-hierarchy enforcement (not prompt-level)",
      "Quarantine untrusted content spans before model ingestion",
    ],
    mapped_security_rules: [
      "ignore-prior-instructions",
      "role-reassignment",
      "reveal-system-prompt",
    ],
    severity: "critical",
    source: "OWASP Agentic Top 10 (2025)",
    license: "CC BY-SA 4.0",
  },
  {
    id: "ASI02",
    category: "Tool Misuse & Exploitation",
    threat: "Agent chains individually benign tool calls into harmful sequences",
    description:
      "An attacker tricks the agent into invoking tools in a sequence that causes damage — e.g., reading a file then sending its contents externally. Each call may be authorized, but the chain is malicious.",
    detection_hints: [
      "fake tool call",
      "function_call",
      "curl | bash",
      "rm -rf",
      "smuggled invocation",
    ],
    mitigations: [
      "Scope tool permissions to least privilege per agent identity",
      "Require human approval for irreversible or high-consequence actions",
      "Enforce deterministic tool-call policies before execution (not after)",
      "Sandbox code execution with no network access by default",
    ],
    mapped_security_rules: [
      "fake-tool-call",
      "remote-code-pipe",
      "destructive-command",
    ],
    severity: "critical",
    source: "OWASP Agentic Top 10 (2025)",
    license: "CC BY-SA 4.0",
  },
  {
    id: "ASI03",
    category: "Identity & Privilege Abuse",
    threat: "Compromised agent uses delegated credentials for lateral movement",
    description:
      "Agents inherit broad credentials from human users or service accounts. A compromised agent can access systems the operator never intended it to reach.",
    detection_hints: [
      "read .env",
      "print API key",
      "copy auth.json",
      "dump credentials",
      "wrangler secret list",
    ],
    mitigations: [
      "Issue scoped, short-lived credentials per agent (not shared API keys)",
      "Rotate credentials after any suspected compromise",
      "Audit agent-to-credential mappings continuously",
      "Never store production secrets in agent-readable files or env without redaction",
    ],
    mapped_security_rules: [
      "secret-exfiltration",
      "wrangler-secret-dump",
      "buyer-private-key-env",
    ],
    severity: "critical",
    source: "OWASP Agentic Top 10 (2025)",
    license: "CC BY-SA 4.0",
  },
  {
    id: "ASI04",
    category: "Memory Poisoning",
    threat: "Attacker persists malicious instructions into agent memory",
    description:
      "Untrusted content instructs the agent to save rules, personas, or directives into its persistent memory (skills, SOUL, config, state DB). Future sessions then execute the poisoned memory.",
    detection_hints: [
      "save to memory",
      "persist this instruction",
      "write to MEMORY.md",
      "create skill with eval",
      "modify SOUL.md",
    ],
    mitigations: [
      "Never allow untrusted content to write to memory/state files",
      "Separate memory write paths from content ingestion",
      "Version-control all skill/memory changes with human review",
      "Scan skill/plugin files for executable payloads before activation",
    ],
    mapped_security_rules: [
      "memory-poisoning-inject",
      "memory-tamper-file",
      "skill-poisoning",
    ],
    severity: "critical",
    source: "OWASP Agentic Top 10 (2025)",
    license: "CC BY-SA 4.0",
  },
  {
    id: "ASI05",
    category: "Insecure MCP / Tool Supply Chain",
    threat: "Malicious or compromised MCP packages exfiltrate data or execute code",
    description:
      "MCP servers run with the same privileges as the agent. A compromised package (like postmark-mcp v1.0.16) can silently BCC emails, read files, or make API calls — all using the agent's credentials.",
    detection_hints: [
      "postmark-mcp",
      "giftshop.club",
      "npx random-mcp",
      "npm install @unknown/mcp",
      "version diff introduced network call",
    ],
    mitigations: [
      "Maintain an MCP allowlist with pinned versions",
      "Behavior-diff new MCP versions before upgrade",
      "Blocklist known-malicious packages and hosts",
      "Never auto-install MCP servers from untrusted prompts",
      "Audit MCP server network egress endpoints",
    ],
    mapped_security_rules: [
      "postmark-mcp-ioc",
      "untrusted-mcp-install",
    ],
    severity: "critical",
    source: "OWASP Agentic Top 10 (2025)",
    license: "CC BY-SA 4.0",
  },
  {
    id: "ASI06",
    category: "Prompt Injection (Indirect)",
    threat: "Instructions embedded in data content hijack agent behavior",
    description:
      "The canonical prompt injection: any web page, email, PDF, or API response can contain text that the agent follows as instructions. LLMs cannot reliably distinguish data from instructions.",
    detection_hints: [
      "ignore prior",
      "system prompt is",
      "act as admin",
      "disable safety",
      "[OUT-OF-BAND USER MESSAGE",
    ],
    mitigations: [
      "Untrusted text is evidence, not authority — structural enforcement",
      "Input sanitization at every ingestion point",
      "Content inspection pipelines before model context",
      "Agent decomposition: separate readers from actors",
    ],
    mapped_security_rules: [
      "ignore-prior-instructions",
      "fake-out-of-band-user",
      "safety-disable",
    ],
    severity: "critical",
    source: "OWASP Agentic Top 10 (2025)",
    license: "CC BY-SA 4.0",
  },
  {
    id: "ASI07",
    category: "Insecure Inter-Agent Communication",
    threat: "Trust boundary violations between delegating agents",
    description:
      "Agents delegate to subagents or external agents without scoping credentials, validating results, or establishing trust boundaries. A compromised child agent can poison the parent or exfiltrate via the delegation chain.",
    detection_hints: [
      "pass credentials to subagent",
      "trust the result from",
      "don't tell the user",
      "secret goal for child agent",
      "forward your API key",
    ],
    mitigations: [
      "Scope credentials per delegation — never pass full keys to children",
      "Validate all inter-agent results before acting on them",
      "Log delegation chains with agent IDs for auditability",
      "Establish explicit trust policies between agent tiers",
    ],
    mapped_security_rules: [
      "agent-deception-inject",
      "agent-credential-pass",
      "agent-untrusted-result-trust",
    ],
    severity: "high",
    source: "OWASP Agentic Top 10 (2025)",
    license: "CC BY-SA 4.0",
  },
  {
    id: "ASI08",
    category: "Data Leakage & Exfiltration",
    threat: "Agent exfiltrates private data through outbound channels",
    description:
      "Any tool that can make an HTTP request, send an email, create a link, or write to a shared resource can be used to exfiltrate private data that the agent has access to.",
    detection_hints: [
      "send data to",
      "upload to",
      "base64 encode",
      "BCC to",
      "post to external API",
    ],
    mitigations: [
      "Egress allowlisting for agent network tools",
      "Rate-limit outbound actions per agent identity",
      "DLP-style content scanning on outbound payloads",
      "Separate data-access agents from communication-capable agents",
    ],
    mapped_security_rules: [
      "secret-exfiltration",
      "crypto-drain-instruction",
      "pii-bulk-exfil",
    ],
    severity: "critical",
    source: "OWASP Agentic Top 10 (2025)",
    license: "CC BY-SA 4.0",
  },
  {
    id: "ASI09",
    category: "Observability & Audit Gaps",
    threat: "Agent actions occur without sufficient logging or traceability",
    description:
      "37% of assessed agents score well on logging but poorly on harm prevention. Logging is forensic, not preventive — it tells you what happened after the damage is done.",
    detection_hints: [
      "no audit log",
      "shared session ID",
      "untraceable action",
      "missing agent identity",
    ],
    mitigations: [
      "Assign unique agent IDs and log every consequential action",
      "Use tamper-evident audit trails (Merkle, blockchain-anchored)",
      "Distinguish logging (forensic) from enforcement (preventive)",
      "Real-time anomaly detection on agent behavior baselines",
    ],
    mapped_security_rules: [],
    severity: "medium",
    source: "OWASP Agentic Top 10 (2025) + CSA AI Risk Quadrant Q2 2026",
    license: "CC BY-SA 4.0",
  },
  {
    id: "ASI10",
    category: "Unsafe Delegation & Autonomy",
    threat: "Agent delegates or acts autonomously beyond its authorized scope",
    description:
      "Agents with broad autonomy can spawn subagents, create tasks, or take irreversible actions without human approval — compounding blast radius at machine speed.",
    detection_hints: [
      "spawn agent without approval",
      "autonomous execute",
      "delegate without scope",
      "create cron job",
    ],
    mitigations: [
      "Human-in-the-loop for irreversible or high-value actions",
      "Rate-limit agent spawning and task creation",
      "Define and enforce autonomy boundaries per agent tier",
      "Circuit breakers / kill switches for runaway agent chains",
    ],
    mapped_security_rules: [],
    severity: "high",
    source: "OWASP Agentic Top 10 (2025)",
    license: "CC BY-SA 4.0",
  },
];

// ─── 2. MCP Supply Chain IOC Feed ─────────────────────────────────────────

export interface McpIoc {
  package: string;
  ecosystem: string;
  malicious_versions: string;
  c2_host: string;
  c2_email: string;
  description: string;
  first_seen: string;
  status: string;
  source: string;
}

const MCP_IOCS: McpIoc[] = [
  {
    package: "postmark-mcp",
    ecosystem: "npm",
    malicious_versions: ">=1.0.16",
    c2_host: "giftshop.club",
    c2_email: "phan@giftshop.club",
    description:
      "Legitimate-looking Postmark email MCP impersonated the official package. Version 1.0.16 added a single BCC line copying every agent-sent email to attacker server. ~1,500 weekly downloads, est. 300 orgs compromised.",
    first_seen: "2025-12",
    status: "package-deleted-from-npm-but-still-installed-locally",
    source: "Koi Security research",
  },
];

// ─── 3. Lethal Trifecta Scoring Engine ────────────────────────────────────

export interface TrifectaInput {
  has_private_data: boolean;
  has_untrusted_content: boolean;
  has_outbound_actions: boolean;
  compensating_controls: string[];
}

export interface TrifectaResult {
  score: number;
  level: "safe" | "elevated" | "dangerous" | "critical";
  lethal_trifecta: boolean;
  legs_present: string[];
  missing_controls: string[];
  recommendations: string[];
  decomposition_advice: string | null;
  attribution: string;
}

const ALL_CONTROLS = [
  "redact_secrets",
  "redact_pii",
  "smart_approvals",
  "mcp_allowlist",
  "input_sanitization",
  "sandboxed_execution",
  "egress_allowlist",
  "audit_logging",
  "human_in_the_loop_high_risk",
  "no_private_keys_in_context",
  "agent_identity_scoping",
  "memory_isolation",
];

export function scoreTrifecta(input: TrifectaInput): TrifectaResult {
  const legs: string[] = [];
  if (input.has_private_data) legs.push("private_data");
  if (input.has_untrusted_content) legs.push("untrusted_content");
  if (input.has_outbound_actions) legs.push("outbound_actions");
  const lethal = legs.length >= 3;

  const controls = new Set(input.compensating_controls.map((c) => c.toLowerCase()));
  const missing = ALL_CONTROLS.filter((c) => !controls.has(c));

  // Base score by legs
  let score = legs.length * 25;
  // Reduce for controls
  const coverage = (ALL_CONTROLS.length - missing.length) / ALL_CONTROLS.length;
  score = Math.round(score * (1 - coverage * 0.6));

  let level: TrifectaResult["level"];
  if (!lethal) level = "safe";
  else if (score >= 60) level = "critical";
  else if (score >= 40) level = "dangerous";
  else level = "elevated";

  const recommendations: string[] = [];
  if (input.has_private_data && missing.includes("redact_secrets"))
    recommendations.push("Enable secret redaction on all agent-visible text");
  if (input.has_private_data && missing.includes("no_private_keys_in_context"))
    recommendations.push("Ensure no private keys, seeds, or mnemonics can enter agent context");
  if (input.has_untrusted_content && missing.includes("input_sanitization"))
    recommendations.push("Deploy content inspection/sanitization at every ingestion point");
  if (input.has_outbound_actions && missing.includes("egress_allowlist"))
    recommendations.push("Egress-allowlist agent network tools to known endpoints only");
  if (lethal && missing.includes("human_in_the_loop_high_risk"))
    recommendations.push("Require human approval for irreversible or high-value actions");
  if (lethal && missing.includes("agent_identity_scoping"))
    recommendations.push("Issue scoped, short-lived credentials per agent identity");
  if (missing.includes("audit_logging"))
    recommendations.push("Log every consequential agent action with agent ID and timestamp");
  if (lethal && missing.includes("mcp_allowlist"))
    recommendations.push("Maintain MCP server allowlist with pinned versions");

  let decomposition: string | null = null;
  if (lethal) {
    decomposition =
      "Separate the reader agent (untrusted content access, no outbound) from the actor agent (outbound actions, no untrusted content access). Pass structured summaries between them — never raw untrusted text.";
  }

  return {
    score,
    level,
    lethal_trifecta: lethal,
    legs_present: legs,
    missing_controls: missing,
    recommendations,
    decomposition_advice: decomposition,
    attribution: "Model from Simon Willison (lethal trifecta) + CSA AI Risk Quadrant Q2 2026",
  };
}

// ─── 4. Agent Security Policy Templates ───────────────────────────────────

export interface PolicyTemplate {
  profile: string;
  description: string;
  rules: Array<{
    name: string;
    condition: string;
    action: string;
    rationale: string;
  }>;
  source_attribution: string;
  license: string;
}

const POLICY_TEMPLATES: PolicyTemplate[] = [
  {
    profile: "coding-agent",
    description:
      "Policy for agents with code execution, file write, and repository access. Highest blast radius category per CSA assessment.",
    rules: [
      {
        name: "block-destructive-shell",
        condition: "tool == 'terminal' AND command MATCHES 'rm -rf /|mkfs|dd if='",
        action: "deny",
        rationale: "Destructive operations require human approval",
      },
      {
        name: "block-secret-read",
        condition: "tool == 'read_file' AND path MATCHES '.env|auth.json|id_rsa|wallet'",
        action: "require_approval",
        rationale: "Prevent credential exfiltration via file access",
      },
      {
        name: "block-public-bind",
        condition: "tool == 'terminal' AND command MATCHES '0.0.0.0|tailscale funnel|ngrok'",
        action: "require_approval",
        rationale: "Public network exposure requires explicit authorization",
      },
      {
        name: "block-remote-pipe",
        condition: "tool == 'terminal' AND command MATCHES 'curl.*|.*sh|wget.*|.*bash'",
        action: "deny",
        rationale: "Remote code execution via pipe is blocked",
      },
      {
        name: "require-sandbox",
        condition: "tool == 'execute_code'",
        action: "require_sandbox",
        rationale: "Code execution must be sandboxed with no network egress",
      },
    ],
    source_attribution: "Microsoft Agent Governance Toolkit (MIT) + OWASP ASI02",
    license: "MIT (pattern source); CC BY-SA 4.0 (taxonomy mapping)",
  },
  {
    profile: "browser-agent",
    description:
      "Policy for agents with web browsing and page interaction capability. All-sites access creates large privacy blast radius.",
    rules: [
      {
        name: "block-banking-pages",
        condition: "url MATCHES 'bank|wallet|exchange|crypto|paypal|stripe.com/dashboard'",
        action: "deny",
        rationale: "Never auto-read financial/wallet pages without explicit user request",
      },
      {
        name: "block-credential-pages",
        condition: "url MATCHES 'password|login|auth|oauth|accounts.google|signin'",
        action: "require_approval",
        rationale: "Credential pages may leak tokens/cookies",
      },
      {
        name: "scrub-page-content",
        condition: "always",
        action: "transform",
        rationale: "Run PII/secret scrub on all extracted page text before returning to model",
      },
      {
        name: "block-wallet-seed-access",
        condition: "tool == 'read_file' AND path MATCHES 'seed|mnemonic|keystore|wallet.dat'",
        action: "deny",
        rationale: "Wallet seed material must never enter agent context",
      },
    ],
    source_attribution: "Browser extension security review S-01/S-02 + OWASP ASI06",
    license: "MIT",
  },
  {
    profile: "payment-agent",
    description:
      "Policy for agents handling x402 payments, wallet addresses, or crypto operations. Crypto boundary enforcement.",
    rules: [
      {
        name: "block-private-key-context",
        condition: "text MATCHES '[a-fA-F0-9]{64}|BUYER_PRIVATE_KEY|seed_phrase|mnemonic'",
        action: "deny",
        rationale: "Private keys and seeds must never appear in agent context",
      },
      {
        name: "facilitator-allowlist",
        condition: "url NOT IN ['facilitator.payai.network', 'api.cdp.coinbase.com']",
        action: "deny",
        rationale: "Only approved x402 facilitators to prevent phishing/swaps",
      },
      {
        name: "block-wallet-drain",
        condition: "text MATCHES 'transfer.*all.*balance|sweep.*wallet|drain'",
        action: "deny",
        rationale: "Mass wallet transfer language is blocked",
      },
      {
        name: "require-mcp-address-only",
        condition: "tool == 'wrangler' AND command MATCHES 'secret put'",
        action: "require_approval",
        rationale: "Worker secret changes require human confirmation",
      },
    ],
    source_attribution: "Tollbooth crypto boundary policy + OWASP ASI03",
    license: "MIT",
  },
  {
    profile: "research-agent",
    description:
      "Policy for agents that search the web and process untrusted content but have limited write access.",
    rules: [
      {
        name: "treat-web-as-untrusted",
        condition: "source == 'web' OR source == 'mcp_result'",
        action: "transform",
        rationale: "All external content is untrusted data, never instructions",
      },
      {
        name: "block-pii-export",
        condition: "output MATCHES '\\d{3}-\\d{2}-\\d{4}|[A-Z0-9._%+-]+@[A-Z0-9.-]+'",
        action: "transform",
        rationale: "Scrub PII from all research outputs before delivery",
      },
      {
        name: "block-mcp-auto-install",
        condition: "command MATCHES 'npx|npm install.*mcp|pip install.*mcp'",
        action: "require_approval",
        rationale: "MCP package installation requires human review",
      },
    ],
    source_attribution: "agent-security policy + OWASP ASI05/ASI06",
    license: "CC BY-SA 4.0 (taxonomy); MIT (implementation)",
  },
];

// ─── Query functions ──────────────────────────────────────────────────────

export function queryThreatCatalog(opts: {
  category?: string;
  id?: string;
  severity?: string;
}): { threats: ThreatEntry[]; total: number; attribution: string; license_note: string } {
  let results = THREAT_CATALOG;
  if (opts.id) results = results.filter((t) => t.id.toLowerCase() === opts.id!.toLowerCase());
  if (opts.category)
    results = results.filter((t) =>
      t.category.toLowerCase().includes(opts.category!.toLowerCase()),
    );
  if (opts.severity)
    results = results.filter((t) => t.severity === opts.severity!.toLowerCase());
  return {
    threats: results,
    total: results.length,
    attribution: "OWASP Agentic Top 10 for Agentic Applications (2025)",
    license_note: LICENSE_NOTE,
  };
}

export function queryMcpIocs(opts: {
  package?: string;
  host?: string;
}): { iocs: McpIoc[]; total: number; last_updated: string; attribution: string } {
  let results = MCP_IOCS;
  if (opts.package)
    results = results.filter((i) =>
      i.package.toLowerCase().includes(opts.package!.toLowerCase()),
    );
  if (opts.host)
    results = results.filter((i) => i.c2_host.includes(opts.host!));
  return {
    iocs: results,
    total: results.length,
    last_updated: "2026-07-10",
    attribution: "Aggregated from public security research reports",
  };
}

export function getPolicyTemplates(opts: {
  profile?: string;
}): { templates: PolicyTemplate[]; total: number; attribution: string } {
  let results = POLICY_TEMPLATES;
  if (opts.profile)
    results = results.filter((p) =>
      p.profile.toLowerCase().includes(opts.profile!.toLowerCase()),
    );
  return {
    templates: results,
    total: results.length,
    attribution: "Patterns derived from Microsoft AGT (MIT) + OWASP Agentic Top 10",
  };
}
