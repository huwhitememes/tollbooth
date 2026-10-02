/** JSON Schema for successful `POST /paid/x402/market-radar` responses. */
export const X402_MARKET_RADAR_SUCCESS_SCHEMA = {
  type: "object",
  required: ["product", "service", "generated_at", "catalog", "agenttoll"],
  properties: {
    product: { type: "string" },
    service: { type: "string" },
    generated_at: { type: "string", format: "date-time" },
    cost_note: { type: "string" },
    network: { type: "string" },
    catalog: { type: "object" },
    agenttoll: { type: "object" },
    verticals: { type: "object" },
    read: { type: "object" },
    provenance: { type: "object" },
  },
  additionalProperties: true,
} as const;

export const X402_MARKET_RADAR_OUTPUT_EXAMPLE = {
  product: "x402 Market Radar",
  service: "agenttoll.dev",
  generated_at: "2026-09-02T00:00:00.000Z",
  catalog: { current_total: 14238, net_change_from_baseline: -10696 },
  agenttoll: { merchant_count: 6, missing_rank_queries: ["x402 market radar"] },
} as const;
