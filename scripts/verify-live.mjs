#!/usr/bin/env node
import { Buffer } from "node:buffer";

const origin = process.env.X402_ORIGIN ?? "https://agenttoll.dev";
const mcpUrl = new URL("/mcp", origin).toString();
const wellKnownUrl = new URL("/.well-known/x402", origin).toString();
const infoUrl = new URL("/api/info", origin).toString();
const paidUrl = new URL("/paid/polymarket/trending", origin).toString();

async function readJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { response, text, data };
}

function decodeHeaderMaybe(value) {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    return JSON.parse(decoded);
  } catch {
    try {
      const decoded = Buffer.from(value, "base64").toString("utf8");
      return JSON.parse(decoded);
    } catch {
      return null;
    }
  }
}

const failures = [];

const wellKnown = await readJson(wellKnownUrl);
if (!wellKnown.response.ok) failures.push(`/.well-known/x402 returned ${wellKnown.response.status}`);
const resources = wellKnown.data?.resources ?? [];
const tools = wellKnown.data?.tools ?? [];
console.log(`x402 discovery: ${wellKnown.response.status} resources=${resources.length} tools=${tools.length} version=${wellKnown.data?.x402Version ?? "?"}`);
if (wellKnown.data?.x402Version !== 2) failures.push("/.well-known/x402 does not advertise x402Version=2");
if (resources.length < 100) failures.push(`expected at least 100 resources, got ${resources.length}`);

const info = await readJson(infoUrl);
console.log(`service info: ${info.response.status} tools=${info.data?.tools?.length ?? info.data?.data?.tools?.length ?? "?"}`);
if (!info.response.ok) failures.push(`/api/info returned ${info.response.status}`);

const mcp = await fetch(mcpUrl, { headers: { accept: "application/json" } });
console.log(`mcp accept guard: ${mcp.status}`);
if (mcp.status !== 406) failures.push(`/mcp accept guard expected 406, got ${mcp.status}`);

const paid = await fetch(paidUrl, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify({ limit: 5 }),
});
const paymentRequired = paid.headers.get("payment-required") ?? paid.headers.get("PAYMENT-REQUIRED");
const decoded = decodeHeaderMaybe(paymentRequired);
console.log(`paid route challenge: ${paid.status} payment-required=${paymentRequired ? "yes" : "no"}`);
if (paid.status !== 402) failures.push(`paid route expected 402, got ${paid.status}`);
if (!paymentRequired) failures.push("paid route did not return PAYMENT-REQUIRED header");
if (decoded) {
  const accepts = decoded.accepts ?? decoded.paymentRequirements?.accepts ?? [];
  console.log(`payment challenge decoded: accepts=${Array.isArray(accepts) ? accepts.length : "?"} network=${accepts?.[0]?.network ?? "?"}`);
}

if (failures.length) {
  console.error("verify-live FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("verify-live PASS");
