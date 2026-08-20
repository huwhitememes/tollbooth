type JsonObject = Record<string, any>;

type SafetyInput = {
  server_url?: string;
  openapi_url?: string;
  openapi_json?: unknown;
  manifest_json?: unknown;
  tool_schema?: unknown;
  intended_task?: string;
  sensitive_context?: boolean;
  max_tools?: number;
};

type SellerAuditInput = {
  resource_url?: string;
  openapi_url?: string;
  openapi_json?: unknown;
  agent_json?: unknown;
  expected_price?: string | number;
  seller_address?: string;
  route_metadata?: unknown;
};

type ApprovalPackInput = {
  tool_name?: string;
  route_url?: string;
  price_usd?: string | number;
  task_intent?: string;
  max_payment_usd?: string | number;
  tool_schema?: unknown;
  method?: string;
  seller_address?: string;
};

const WRITE_METHODS = new Set(["post", "put", "patch", "delete"]);
const DESTRUCTIVE_METHODS = new Set(["put", "patch", "delete"]);
const RISK_FIELD_HINTS = ["token", "secret", "password", "api_key", "apikey", "authorization", "cookie", "bearer", "card", "iban", "account"];
const PII_FIELD_HINTS = ["email", "phone", "address", "ssn", "social", "name", "first_name", "last_name", "dob", "birth"];
const PROMPT_INJECTION_HINTS = ["url", "html", "markdown", "content", "page", "document", "prompt", "message", "instruction"];
const DEFAULT_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const MAX_TEXT_CHARS = 500_000;

function nowIso() {
  return new Date().toISOString();
}

function asObject(value: unknown): JsonObject | null {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : null;
    } catch {
      return null;
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function textOf(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.slice(0, MAX_TEXT_CHARS);
  try { return JSON.stringify(value).slice(0, MAX_TEXT_CHARS); } catch { return String(value).slice(0, MAX_TEXT_CHARS); }
}

function cleanText(value: unknown, fallback = ""): string {
  const text = String(value ?? "").trim().slice(0, 2_000);
  return text || fallback;
}

function numberPrice(value: unknown, fallback = 0.1): number {
  const match = String(value ?? "").replace(/[$,\s]/g, "").match(/-?\d+(?:\.\d+)?/);
  const n = match ? Number.parseFloat(match[0]) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function findMatchingKeys(value: unknown, hints: string[], prefix = ""): string[] {
  if (!value || typeof value !== "object") return [];
  const hits: string[] = [];
  const walk = (node: unknown, path: string, depth: number) => {
    if (!node || typeof node !== "object" || depth > 12) return;
    if (Array.isArray(node)) {
      node.slice(0, 20).forEach((child, index) => walk(child, `${path}[${index}]`, depth + 1));
      return;
    }
    for (const [key, child] of Object.entries(node as JsonObject).slice(0, 200)) {
      const next = path ? `${path}.${key}` : key;
      const lowered = key.toLowerCase();
      if (hints.some((hint) => lowered.includes(hint))) hits.push(next);
      walk(child, next, depth + 1);
    }
  };
  walk(value, prefix, 0);
  return unique(hits).slice(0, 30);
}

function findFirstStringForKeys(value: unknown, keys: string[]): string {
  const accepted = new Set(keys.map((key) => key.replace(/[^a-z0-9]/gi, "").toLowerCase()));
  let found = "";
  const walk = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 10) return;
    if (Array.isArray(node)) {
      node.slice(0, 30).forEach((child) => walk(child, depth + 1));
      return;
    }
    for (const [key, child] of Object.entries(node as JsonObject).slice(0, 200)) {
      const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
      if (accepted.has(normalized) && typeof child === "string" && child.trim()) {
        const candidate = child.trim();
        if (!found) found = candidate;
        if (/^0x[0-9a-fA-F]{40}$/.test(candidate)) {
          found = candidate;
          return;
        }
      }
      walk(child, depth + 1);
      if (/^0x[0-9a-fA-F]{40}$/.test(found)) return;
    }
  };
  walk(value, 0);
  return found;
}

function operationsFromOpenApi(spec: JsonObject | null) {
  const paths = spec?.paths && typeof spec.paths === "object" ? spec.paths as JsonObject : {};
  const operations: Array<{ method: string; path: string; operationId: string; description: string; schema: unknown; security: unknown }> = [];
  for (const [path, methods] of Object.entries(paths).slice(0, 500)) {
    if (!methods || typeof methods !== "object") continue;
    for (const [method, op] of Object.entries(methods as JsonObject)) {
      const lowered = method.toLowerCase();
      if (!["get", "post", "put", "patch", "delete"].includes(lowered)) continue;
      const obj = op && typeof op === "object" ? op as JsonObject : {};
      const parameterInputs = Array.isArray(obj.parameters)
        ? Object.fromEntries(obj.parameters.slice(0, 100).map((parameter: any, index: number) => [
            cleanText(parameter?.name, `parameter_${index + 1}`),
            parameter?.schema ?? parameter,
          ]))
        : obj.parameters ?? {};
      operations.push({
        method: lowered,
        path,
        operationId: cleanText(obj.operationId, `${lowered}_${path.replace(/[^a-zA-Z0-9]+/g, "_")}`),
        description: cleanText(obj.description, cleanText(obj.summary)),
        schema: {
          request_body: obj.requestBody ?? {},
          parameters: parameterInputs,
        },
        security: obj.security ?? spec?.security ?? null,
      });
    }
  }
  return operations;
}

function toolsFromManifest(manifest: JsonObject | null) {
  const raw = manifest?.tools ?? manifest?.capabilities ?? manifest?.server?.tools ?? [];
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 500).map((tool: any, index) => ({
    name: cleanText(tool?.name, `tool_${index + 1}`),
    description: cleanText(tool?.description),
    input: tool?.input ?? tool?.input_schema ?? tool?.schema ?? {},
    price: tool?.price_usd ?? tool?.price ?? null,
  }));
}

function schemaStats(openapi: JsonObject | null, manifest: JsonObject | null, toolSchema: JsonObject | null) {
  const operations = operationsFromOpenApi(openapi);
  const manifestTools = toolsFromManifest(manifest);
  const fallbackTools = toolSchema ? [{ name: cleanText(toolSchema.name, "submitted_tool"), description: cleanText(toolSchema.description), input: toolSchema.input ?? toolSchema.input_schema ?? toolSchema }] : [];
  const tools = operations.length ? operations.map((op) => ({ name: op.operationId, description: op.description, input: op.schema, method: op.method, path: op.path })) : manifestTools.length ? manifestTools : fallbackTools;
  const writeCount = operations.filter((op) => WRITE_METHODS.has(op.method)).length;
  const destructiveCount = operations.filter((op) => DESTRUCTIVE_METHODS.has(op.method)).length;
  const missingDescriptions = tools.filter((tool: any) => !cleanText(tool.description)).length;
  const sourceText = [openapi, manifest, toolSchema].map(textOf).join("\n");
  const inputSurfaces = {
    openapi: operations.map((operation) => operation.schema),
    manifest: manifestTools.map((tool) => tool.input),
    toolSchema,
  };
  const credentialFields = findMatchingKeys(inputSurfaces, RISK_FIELD_HINTS);
  const piiFields = findMatchingKeys(inputSurfaces, PII_FIELD_HINTS);
  const promptInjectionFields = findMatchingKeys(inputSurfaces, PROMPT_INJECTION_HINTS);
  const authMentions = /oauth|api[_ -]?key|bearer|authorization|cookie|jwt/i.test(sourceText);
  const paymentMentions = /x402|usdc|payment|required|price|payto|seller|wallet/i.test(sourceText);
  return {
    operations,
    tools,
    tool_count: tools.length,
    write_count: writeCount || tools.filter((tool: any) => /post|put|patch|delete|send|create|update|delete|transfer|pay|swap|trade/i.test(`${tool.name} ${tool.description}`)).length,
    destructive_count: destructiveCount || tools.filter((tool: any) => /delete|transfer|withdraw|swap|trade|send|purchase|pay/i.test(`${tool.name} ${tool.description}`)).length,
    missing_descriptions: missingDescriptions,
    credential_fields: credentialFields,
    pii_fields: piiFields,
    prompt_injection_fields: promptInjectionFields,
    auth_mentions: authMentions,
    payment_mentions: paymentMentions,
  };
}

function riskLevel(score: number) {
  if (score >= 85) return "low";
  if (score >= 65) return "medium";
  return "high";
}

function safetyScore(stats: ReturnType<typeof schemaStats>, sensitiveContext = false) {
  let score = 100;
  if (stats.tool_count === 0) score -= 30;
  score -= Math.min(25, stats.write_count * 4);
  score -= Math.min(25, stats.destructive_count * 8);
  score -= Math.min(16, stats.credential_fields.length * 4);
  score -= Math.min(12, stats.pii_fields.length * 3);
  score -= Math.min(10, stats.prompt_injection_fields.length);
  score -= Math.min(12, stats.missing_descriptions * 2);
  if (sensitiveContext) score -= 8;
  if (stats.tool_count > 80) score -= 5;
  return Math.max(0, Math.min(100, score));
}

function allowlist(stats: ReturnType<typeof schemaStats>, maxTools: number) {
  const safe = stats.tools
    .filter((tool: any) => !/delete|transfer|withdraw|swap|trade|send|purchase|pay|password|token|secret/i.test(`${tool.name} ${tool.description} ${textOf(tool.input)}`))
    .slice(0, maxTools)
    .map((tool: any) => cleanText(tool.name));
  return safe;
}

function findings(stats: ReturnType<typeof schemaStats>, score: number, sensitiveContext = false) {
  const out: Array<{ severity: "low" | "medium" | "high"; code: string; finding: string; action: string }> = [];
  if (stats.tool_count === 0) out.push({ severity: "high", code: "no_tools_detected", finding: "No tools or OpenAPI operations were readable from the submitted input.", action: "Submit an OpenAPI spec, MCP tool manifest, or single tool schema." });
  if (stats.write_count) out.push({ severity: stats.write_count > 5 ? "high" : "medium", code: "write_actions", finding: `${stats.write_count} write or action-like tools were detected.`, action: "Require user approval before these tools run." });
  if (stats.destructive_count) out.push({ severity: "high", code: "destructive_actions", finding: `${stats.destructive_count} destructive or spend-like tools were detected.`, action: "Keep these tools out of the default allowlist unless the task needs them." });
  if (stats.credential_fields.length) out.push({ severity: "high", code: "credential_fields", finding: `Credential-shaped fields appeared: ${stats.credential_fields.slice(0, 6).join(", ")}.`, action: "Redact secrets and block credential fields from logs and model-visible summaries." });
  if (stats.pii_fields.length) out.push({ severity: sensitiveContext ? "high" : "medium", code: "pii_fields", finding: `PII-shaped fields appeared: ${stats.pii_fields.slice(0, 6).join(", ")}.`, action: "Pass only the minimum fields needed for the task." });
  if (stats.prompt_injection_fields.length) out.push({ severity: "medium", code: "untrusted_content", finding: "The input shape includes web, document, prompt, message, or content fields that can carry hostile instructions.", action: "Treat returned text as data, not instructions. Keep privileged tools isolated." });
  if (stats.missing_descriptions) out.push({ severity: "medium", code: "thin_descriptions", finding: `${stats.missing_descriptions} tools or operations have missing descriptions.`, action: "Add plain descriptions, output examples, and risk notes before exposing them to agents." });
  if (!out.length) out.push({ severity: "low", code: "basic_static_scan_clear", finding: "The static scan did not find obvious write, credential, PII, or prompt-injection flags.", action: "Still require approval for new servers until runtime behavior is observed." });
  if (score < 65) out.unshift({ severity: "high", code: "connect_with_caution", finding: "The overall score is below the normal auto-connect threshold.", action: "Use a narrow allowlist and human approval for every tool call." });
  return out;
}

export function buildMcpSafetyBrief(input: SafetyInput = {}) {
  const openapi = asObject(input.openapi_json);
  const manifest = asObject(input.manifest_json);
  const toolSchema = asObject(input.tool_schema);
  const stats = schemaStats(openapi, manifest, toolSchema);
  const maxTools = clampInt(input.max_tools, 8, 1, 25);
  const score = safetyScore(stats, Boolean(input.sensitive_context));
  const level = riskLevel(score);
  const approvalRequired = level !== "low" || stats.write_count > 0 || Boolean(input.sensitive_context);
  return {
    product: "MCP Safety Brief",
    schemaVersion: "agenttoll.mcp_safety_brief.v1",
    generated_at: nowIso(),
    source: {
      server_url: cleanText(input.server_url) || null,
      openapi_url: cleanText(input.openapi_url) || null,
      submitted_openapi: Boolean(openapi),
      submitted_manifest: Boolean(manifest),
      submitted_tool_schema: Boolean(toolSchema),
    },
    intended_task: cleanText(input.intended_task) || null,
    summary: {
      score,
      risk_level: level,
      tools_detected: stats.tool_count,
      write_actions: stats.write_count,
      destructive_actions: stats.destructive_count,
      approval_required: approvalRequired,
    },
    findings: findings(stats, score, Boolean(input.sensitive_context)),
    recommended_allowlist: allowlist(stats, maxTools),
    approval_policy: {
      default: approvalRequired ? "require_approval" : "allow_read_only_after_review",
      require_approval_for: ["write actions", "spend actions", "credential fields", "PII fields", "untrusted content returned by remote tools"],
      never_send: unique([...stats.credential_fields, ...stats.pii_fields]).slice(0, 12),
    },
    user_approval_line: `This MCP connection has ${stats.tool_count} detected tools and a ${level} static risk rating. Use a narrow allowlist, require approval for write or spend actions, and do not send secrets.`,
    provenance: {
      method: "Static schema and manifest analysis. No remote tool calls were executed.",
      sources: ["submitted OpenAPI", "submitted MCP manifest", "submitted tool schema"].filter((_, i) => [openapi, manifest, toolSchema][i]),
    },
  };
}

function hostFromUrl(url: string) {
  try { return new URL(url).hostname; } catch { return ""; }
}

export function buildX402SellerReadinessAudit(input: SellerAuditInput = {}) {
  const openapi = asObject(input.openapi_json);
  const agent = asObject(input.agent_json);
  const metadata = asObject(input.route_metadata);
  const manifest = agent ?? (Array.isArray(metadata?.tools) ? metadata : null);
  const stats = schemaStats(openapi, manifest, null);
  const resource = cleanText(input.resource_url, "unknown");
  const resourceHost = hostFromUrl(resource);
  const resourceValid = /^https:\/\//i.test(resource) && Boolean(resourceHost);
  const sourceText = [openapi, agent, metadata, input.resource_url, input.openapi_url].map(textOf).join("\n").toLowerCase();
  const expectedPrice = input.expected_price == null ? null : numberPrice(input.expected_price, -1);
  const seller = cleanText(
    input.seller_address
      ?? findFirstStringForKeys({ openapi, agent, metadata }, ["seller_address", "seller", "pay_to", "payTo"]),
  );
  const sellerValid = /^0x[0-9a-fA-F]{40}$/.test(seller);
  const explicitPriceValid = input.expected_price == null || (expectedPrice != null && expectedPrice > 0);
  const metadataPriceVisible = /(?:price(?:_usd)?|amount|maxpayment|max_payment)[^\d]{0,20}\d/.test(sourceText)
    || /costs?\s+\$?\d/.test(sourceText);
  const baseVisible = /\bbase(?: mainnet)?\b|eip155:8453/.test(sourceText);
  const usdcVisible = /usdc|0x833589fc/.test(sourceText);
  const checks = [
    { code: "resource_url", passed: resourceValid, fix: "Publish a stable HTTPS paid resource URL." },
    { code: "openapi_or_metadata", passed: Boolean(openapi || metadata || agent), fix: "Expose OpenAPI, route metadata, or agent.json before payment." },
    { code: "price_visible", passed: explicitPriceValid && ((expectedPrice ?? 0) > 0 || metadataPriceVisible), fix: "Show a positive price and max payment in free metadata." },
    { code: "x402_visible", passed: /x402|payment required|402/.test(sourceText), fix: "Mention x402 and the unpaid 402 challenge in metadata." },
    { code: "base_usdc_visible", passed: baseVisible && usdcVisible, fix: "Show Base mainnet and the USDC asset contract." },
    { code: "seller_visible", passed: sellerValid, fix: "Show a valid 0x seller wallet so buyers can verify payTo before approval." },
    { code: "receipt_visible", passed: /receipt|hash|transaction|settlement/.test(sourceText), fix: "Describe the receipt or settlement proof returned after payment." },
    { code: "tool_descriptions", passed: stats.tool_count > 0 && stats.missing_descriptions === 0, fix: "Give every paid operation a plain buyer-facing description." },
    { code: "approval_copy", passed: /approval|maxpayment|before approving|spend cap/.test(sourceText), fix: "Add a one-line approval prompt with price, cap, seller, and expected result." },
  ];
  const passed = checks.filter((check) => check.passed).length;
  const score = Math.round((passed / checks.length) * 100);
  const missing = checks.filter((check) => !check.passed).map((check) => ({ code: check.code, fix: check.fix }));
  return {
    product: "x402 Seller Readiness Audit",
    schemaVersion: "agenttoll.x402_seller_readiness.v1",
    generated_at: nowIso(),
    resource: resource === "unknown" ? null : resource,
    host: resourceHost,
    summary: {
      readiness_score: score,
      verdict: score >= 85 ? "agent_ready" : score >= 60 ? "needs_metadata_work" : "not_ready_for_agent_buyers",
      checks_passed: passed,
      checks_total: checks.length,
      tools_detected: stats.tool_count,
    },
    checks,
    missing,
    buyer_prompt: `This x402 route${expectedPrice != null && expectedPrice > 0 ? ` costs about $${expectedPrice.toFixed(2)}` : " has a paid x402 flow"}. Verify the Base USDC asset, seller wallet, spend cap, and expected result before approval.`,
    next_actions: missing.length ? missing.slice(0, 5).map((item) => item.fix) : ["Keep the metadata current.", "Run a fresh audit after changing price, seller wallet, or output shape."],
    provenance: { method: "Static review of submitted URL, OpenAPI, route metadata, and agent manifest. No paid call was made." },
  };
}

export function buildMcpApprovalPack(input: ApprovalPackInput = {}) {
  const tool = cleanText(input.tool_name, "submitted_tool");
  const parsedPrice = input.price_usd == null ? 0 : numberPrice(input.price_usd, -1);
  const price = parsedPrice >= 0 ? parsedPrice : 0;
  const parsedMaxPayment = input.max_payment_usd == null ? price : numberPrice(input.max_payment_usd, -1);
  const maxPayment = parsedMaxPayment >= 0 ? parsedMaxPayment : price;
  const schema = asObject(input.tool_schema);
  const stats = schemaStats(null, null, schema);
  const method = cleanText(input.method, "POST").toUpperCase();
  const actionText = `${tool} ${cleanText(schema?.description)}`.toLowerCase();
  const actionStats = {
    ...stats,
    destructive_count: Math.max(stats.destructive_count, DESTRUCTIVE_METHODS.has(method.toLowerCase()) || /delete|transfer|withdraw|swap|trade|send|purchase|pay/.test(actionText) ? 1 : 0),
    write_count: Math.max(stats.write_count, WRITE_METHODS.has(method.toLowerCase()) || /send|create|update|delete|transfer|pay|swap|trade/.test(actionText) ? 1 : 0),
  };
  const seller = cleanText(input.seller_address);
  const task = cleanText(input.task_intent, "the requested task");
  const riskScore = safetyScore(actionStats, true);
  const level = riskLevel(riskScore);
  const policyErrors: string[] = [];
  if (input.price_usd != null && parsedPrice < 0) policyErrors.push("price_usd is not a valid nonnegative amount");
  if (input.max_payment_usd != null && parsedMaxPayment < 0) policyErrors.push("max_payment_usd is not a valid nonnegative amount");
  if (maxPayment < price) policyErrors.push(`max_payment_usd $${maxPayment.toFixed(2)} is below the route price $${price.toFixed(2)}`);
  if (maxPayment > 0 && !/^0x[0-9a-fA-F]{40}$/.test(seller)) policyErrors.push("seller_address is required for a paid call and must be a valid 0x wallet");
  const routeUrl = cleanText(input.route_url);
  if (routeUrl && !/^https:\/\//i.test(routeUrl)) policyErrors.push("route_url must use HTTPS");
  const inputRoot = asObject(schema?.input) ?? asObject(schema?.input_schema) ?? schema;
  const propertySource = inputRoot?.properties ?? inputRoot ?? {};
  const submittedFields = propertySource && typeof propertySource === "object" && !Array.isArray(propertySource) ? Object.keys(propertySource).slice(0, 30) : [];
  const sensitivePaths = [...stats.credential_fields, ...stats.pii_fields];
  const blockedFields = submittedFields.filter((field) => {
    const lowered = field.toLowerCase();
    return [...RISK_FIELD_HINTS, ...PII_FIELD_HINTS].some((hint) => lowered.includes(hint))
      || sensitivePaths.some((path) => path.split(/[.\[\]]+/).includes(field));
  });
  const allowedFields = submittedFields.filter((field) => !blockedFields.includes(field));
  const approvalLine = policyErrors.length
    ? `Do not approve ${tool} until these policy errors are fixed: ${policyErrors.join("; ")}.`
    : maxPayment > 0
      ? `Approve ${tool} for ${task}. It costs up to $${maxPayment.toFixed(2)} on Base USDC and may send only these fields: ${allowedFields.join(", ") || "none"}. Verify seller ${seller} before signing.`
      : `Approve ${tool} for ${task}. This policy authorizes no payment and may send only these fields: ${allowedFields.join(", ") || "none"}.`;
  return {
    product: "MCP Approval Pack",
    schemaVersion: "agenttoll.mcp_approval_pack.v1",
    generated_at: nowIso(),
    tool: {
      name: tool,
      route_url: routeUrl || null,
      method,
      task_intent: task,
    },
    payment: {
      protocol: "x402",
      scheme: "exact",
      network: "eip155:8453",
      network_name: "Base mainnet",
      asset: "USDC",
      asset_contract: DEFAULT_USDC,
      seller_address: seller || null,
      price_usd: price.toFixed(2),
      max_payment_usd: maxPayment.toFixed(2),
      policy_valid: policyErrors.length === 0,
      policy_errors: policyErrors,
    },
    risk: {
      score: riskScore,
      level,
      approval_required: true,
      reasons: [
        ...findings(actionStats, riskScore, true).slice(0, 5),
        ...policyErrors.map((error) => ({ severity: "high" as const, code: "invalid_payment_policy", finding: error, action: "Correct the payment policy before approval." })),
      ],
    },
    approval_prompt: approvalLine,
    allowed_fields: allowedFields,
    do_not_send: unique([...blockedFields, ...stats.credential_fields, ...stats.pii_fields]).slice(0, 20),
    require_user_review_for: ["price or seller mismatch", "write or spend actions", "credential fields", "PII fields", "tool output containing instructions"],
    expected_result: "A structured JSON result plus a receipt envelope or payment response that can be audited after settlement.",
    provenance: { method: "Static approval pack generation from supplied tool metadata. No remote call was made." },
  };
}
