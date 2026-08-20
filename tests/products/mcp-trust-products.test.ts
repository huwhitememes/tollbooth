import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildMcpApprovalPack, buildMcpSafetyBrief, buildX402SellerReadinessAudit } from "../../src/mcp-trust-products";

const source = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");

test("MCP safety brief flags write tools and sensitive fields", () => {
  const result = buildMcpSafetyBrief({
    openapi_json: {
      openapi: "3.1.0",
      paths: {
        "/messages": {
          post: {
            summary: "Send message",
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "object", properties: { email: { type: "string" }, api_key: { type: "string" }, message: { type: "string" } } },
                },
              },
            },
          },
        },
      },
    },
    intended_task: "send a support message",
    sensitive_context: true,
  });

  assert.equal(result.product, "MCP Safety Brief");
  assert.equal(result.summary.approval_required, true);
  assert.ok(result.summary.write_actions >= 1);
  assert.ok(result.approval_policy.never_send.some((field) => field.includes("api_key")));
  assert.match(result.user_approval_line, /narrow allowlist/);
});

test("MCP safety brief never falls back to allowlisting destructive tools", () => {
  const result = buildMcpSafetyBrief({
    manifest_json: {
      tools: [{ name: "delete_user", description: "Delete a user account", input: { user_id: { type: "string" } } }],
    },
  });

  assert.deepEqual(result.recommended_allowlist, []);
  assert.equal(result.summary.approval_required, true);
});

test("MCP manifest metadata is not misclassified as submitted PII", () => {
  const result = buildMcpSafetyBrief({
    manifest_json: {
      tools: [{ name: "read_profile", description: "Read a public profile", input: { user_id: { type: "string" } } }],
    },
  });

  assert.ok(!result.approval_policy.never_send.some((field) => field.endsWith(".name")));
  assert.deepEqual(result.recommended_allowlist, ["read_profile"]);
});

test("MCP safety brief scans OpenAPI parameters as well as request bodies", () => {
  const result = buildMcpSafetyBrief({
    openapi_json: {
      paths: {
        "/report": {
          get: {
            description: "Read one report",
            parameters: [{ name: "api_key", in: "header", schema: { type: "string" } }],
          },
        },
      },
    },
  });

  assert.ok(result.approval_policy.never_send.some((field) => field.includes("api_key")));
});

test("x402 seller readiness audit scores visible buyer metadata", () => {
  const result = buildX402SellerReadinessAudit({
    resource_url: "https://agenttoll.dev/paid/x402/market-radar",
    expected_price: "0.05",
    seller_address: "0x62a0D3d9DF0dE8804983009949c714EaeAFd87F1",
    route_metadata: {
      protocol: "x402",
      network: "eip155:8453",
      asset: "USDC",
      asset_contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      receipt_schema: "agenttoll.receipt.v1",
      approval_prompt: "Approve up to $0.05 before paying.",
      tools: [{ name: "market_radar", description: "Finds x402 market demand and ranking gaps.", price_usd: "0.05" }],
    },
  });

  assert.equal(result.product, "x402 Seller Readiness Audit");
  assert.ok(result.summary.readiness_score >= 75);
  assert.equal(result.summary.tools_detected, 1);
  assert.ok(result.checks.some((check) => check.code === "x402_visible" && check.passed));
  assert.ok(result.checks.some((check) => check.code === "seller_visible" && check.passed));
  assert.match(result.buyer_prompt, /Verify the Base USDC asset/);
});

test("x402 seller readiness does not accept a malformed seller address", () => {
  const result = buildX402SellerReadinessAudit({
    resource_url: "https://example.com/paid/x402/report",
    expected_price: "0.10",
    seller_address: "not-a-wallet",
    route_metadata: { protocol: "x402", network: "eip155:8453", asset: "USDC" },
  });

  assert.equal(result.checks.find((check) => check.code === "seller_visible")?.passed, false);
});

test("x402 seller readiness reads nested payTo and requires both Base and USDC", () => {
  const nestedSeller = buildX402SellerReadinessAudit({
    resource_url: "https://example.com/paid/report",
    route_metadata: {
      protocol: "x402",
      network: "eip155:8453",
      asset: "USDC",
      seller: "Example vendor",
      payment: { payTo: "0x62a0D3d9DF0dE8804983009949c714EaeAFd87F1" },
    },
  });
  const usdcOnly = buildX402SellerReadinessAudit({
    resource_url: "https://example.com/paid/report",
    seller_address: "0x62a0D3d9DF0dE8804983009949c714EaeAFd87F1",
    route_metadata: { protocol: "x402", asset: "USDC" },
  });

  assert.equal(nestedSeller.checks.find((check) => check.code === "seller_visible")?.passed, true);
  assert.equal(nestedSeller.checks.find((check) => check.code === "base_usdc_visible")?.passed, true);
  assert.equal(nestedSeller.checks.find((check) => check.code === "price_visible")?.passed, false);
  assert.equal(usdcOnly.checks.find((check) => check.code === "base_usdc_visible")?.passed, false);
});

test("x402 seller readiness requires an HTTPS resource and descriptions for every tool", () => {
  const result = buildX402SellerReadinessAudit({
    openapi_url: "https://example.com/openapi.json",
    route_metadata: {
      protocol: "x402",
      network: "eip155:8453",
      asset: "USDC",
      tools: [{ name: "paid_report" }],
    },
  });

  assert.equal(result.checks.find((check) => check.code === "resource_url")?.passed, false);
  assert.equal(result.checks.find((check) => check.code === "tool_descriptions")?.passed, false);
});

test("MCP approval pack returns a coherent spend policy and blocks sensitive fields", () => {
  const result = buildMcpApprovalPack({
    tool_name: "send_invoice",
    route_url: "https://example.com/paid/invoice/send",
    price_usd: "0.05",
    max_payment_usd: "0.03",
    task_intent: "send one invoice draft",
    tool_schema: { properties: { customer_email: { type: "string" }, auth_token: { type: "string" }, amount: { type: "number" } } },
  });

  assert.equal(result.payment.max_payment_usd, "0.03");
  assert.equal(result.payment.policy_valid, false);
  assert.ok(result.payment.policy_errors.some((error) => error.includes("below the route price")));
  assert.match(result.approval_prompt, /send_invoice/);
  assert.ok(result.do_not_send.some((field) => field.includes("auth_token")));
  assert.ok(!result.allowed_fields.includes("auth_token"));
  assert.ok(!result.allowed_fields.includes("customer_email"));
  assert.ok(result.allowed_fields.includes("amount"));
  assert.equal(result.risk.approval_required, true);
});

test("MCP approval pack rejects malformed payment metadata", () => {
  const result = buildMcpApprovalPack({
    tool_name: "paid_report",
    route_url: "http://example.com/paid/report",
    price_usd: "free-ish",
    max_payment_usd: "none",
  });

  assert.equal(result.payment.policy_valid, false);
  assert.ok(result.payment.policy_errors.some((error) => error.includes("price_usd")));
  assert.ok(result.payment.policy_errors.some((error) => error.includes("max_payment_usd")));
  assert.ok(result.payment.policy_errors.some((error) => error.includes("HTTPS")));
  assert.match(result.approval_prompt, /^Do not approve/);
});

test("MCP approval pack does not invent a seller or payment amount", () => {
  const paidWithoutSeller = buildMcpApprovalPack({ tool_name: "paid_report", price_usd: "0.05" });
  const freeTool = buildMcpApprovalPack({ tool_name: "read_report", price_usd: "0" });

  assert.equal(paidWithoutSeller.payment.policy_valid, false);
  assert.equal(paidWithoutSeller.payment.seller_address, null);
  assert.ok(paidWithoutSeller.payment.policy_errors.some((error) => error.includes("seller_address")));
  assert.equal(freeTool.payment.price_usd, "0.00");
  assert.equal(freeTool.payment.seller_address, null);
  assert.equal(freeTool.payment.policy_valid, true);
  assert.match(freeTool.approval_prompt, /authorizes no payment/);
});

test("MCP approval pack accounts for HTTP method risk and nested sensitive fields", () => {
  const result = buildMcpApprovalPack({
    tool_name: "remove_report",
    method: "DELETE",
    price_usd: "0",
    tool_schema: {
      properties: {
        payload: { type: "object", properties: { api_key: { type: "string" }, report_id: { type: "string" } } },
        reason: { type: "string" },
      },
    },
  });

  assert.ok(result.risk.reasons.some((reason) => reason.code === "destructive_actions"));
  assert.ok(!result.allowed_fields.includes("payload"));
  assert.ok(result.do_not_send.some((field) => field.includes("api_key")));
});

test("new trust products are wired to every required public surface", () => {
  const products = [
    { name: "mcp_safety_brief", route: "/paid/mcp/safety-brief", builder: "buildMcpSafetyBrief" },
    { name: "x402_seller_readiness_audit", route: "/paid/x402/seller-readiness-audit", builder: "buildX402SellerReadinessAudit" },
    { name: "mcp_approval_pack", route: "/paid/mcp/approval-pack", builder: "buildMcpApprovalPack" },
  ];
  const x402PlainSource = source.slice(source.indexOf("function x402WellKnownPlain"), source.indexOf("function x402WellKnownJson"));

  for (const { name, route, builder } of products) {
    assert.match(source, new RegExp(`name: "${name}"`), `${name} catalog entry`);
    assert.match(source, new RegExp(`"POST ${route.replace(/[/.]/g, "\\$&")}"`), `${name} payment route`);
    assert.match(source, new RegExp(`paidHttp\\.post\\("${route.replace(/[/.]/g, "\\$&")}"`), `${name} HTTP handler`);
    assert.match(source, new RegExp(`this\\.server\\.paidTool\\(\\n\\s+"${name}"`), `${name} MCP tool`);
    assert.ok(source.includes(`${name}: \`\${SERVICE.origin}${route}\``), `${name} service info`);
    assert.ok(x402PlainSource.includes(`\`\${SERVICE.origin}${route}\``), `${name} x402 resource`);
    assert.match(source, new RegExp(`withReceiptEnvelope\\("${name}"[\\s\\S]{0,180}${builder}`), `${name} MCP receipt envelope`);
    assert.match(source, new RegExp(`withReceiptEnvelope\\("${name}", body, ${builder}\\(body\\)\\)`), `${name} HTTP receipt envelope`);
  }

  assert.match(source, /name: "MCP Trust"[\s\S]{0,160}"mcp_safety_brief","mcp_approval_pack"/, "MCP Trust category");
  assert.match(source, /"x402_seller_readiness_audit"/, "x402 readiness category");
  assert.match(source, /version: "0\.13\.0"/, "service version");
  assert.match(source, /optional reference URL; not fetched/, "static URL behavior is explicit");
});
