import assert from "node:assert/strict";
import { test } from "node:test";
import { buildX402MarketRadar } from "../../src/x402-market-radar";
import { X402_MARKET_RADAR_SUCCESS_SCHEMA } from "../../src/x402-market-radar-schema";

const BAZAAR_RESOURCES = {
  pagination: { total: 1200 },
  x402Version: 2,
  items: [
    {
      resource: "https://agenttoll.dev/paid/x402/market-radar",
      description: "radar",
      accepts: [{ amount: "50000", network: "eip155:8453", payTo: "0x62a0D3d9DF0dE8804983009949c714EaeAFd87F1" }],
    },
  ],
};

const BAZAAR_SEARCH = {
  resources: [],
  partialResults: false,
  searchMethod: "keyword",
};

function mockFetcher(input: string | URL | Request) {
  const url = new URL(typeof input === "string" ? input : input instanceof Request ? input.url : input);
  const path = `${url.pathname}${url.search}`;
  if (path.includes("/merchant")) {
    return Promise.resolve(new Response(JSON.stringify({ resources: BAZAAR_RESOURCES.items }), { status: 200 }));
  }
  if (path.includes("/search")) {
    return Promise.resolve(new Response(JSON.stringify(BAZAAR_SEARCH), { status: 200 }));
  }
  if (path.includes("/resources")) {
    return Promise.resolve(new Response(JSON.stringify(BAZAAR_RESOURCES), { status: 200 }));
  }
  return Promise.resolve(new Response("not found", { status: 404 }));
}

test("market radar success schema requires handler-owned top-level fields", () => {
  assert.deepEqual(X402_MARKET_RADAR_SUCCESS_SCHEMA.required, [
    "product",
    "service",
    "generated_at",
    "catalog",
    "agenttoll",
  ]);
});

test("buildX402MarketRadar returns fields guaranteed by the success schema", async () => {
  const result = await buildX402MarketRadar({
    fetcher: mockFetcher as typeof fetch,
    baselineTotal: 1000,
    queries: ["agenttoll.dev"],
    queryLimit: 5,
  });

  for (const key of X402_MARKET_RADAR_SUCCESS_SCHEMA.required) {
    assert.ok(key in result, `missing ${key}`);
  }
  assert.equal(result.product, "x402 Market Radar");
  assert.equal(result.service, "agenttoll.dev");
  assert.equal(typeof result.generated_at, "string");
  assert.equal(typeof result.catalog, "object");
  assert.equal(typeof result.agenttoll, "object");
});
