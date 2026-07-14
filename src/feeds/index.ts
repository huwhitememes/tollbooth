// AUTO LANE — pure public-API feeds (no browser), ship Tollbooth auto
// MANUAL LANE: registry.yaml method: manual-capture status: needs-capture — needs browser-use hu-x -> manual-capture --stealth --url
export { fetchGeoPulse } from "./geo-pulse";
export { fetchFlightIntel } from "./flight-intel";
export { fetchResearchPack } from "./research-pack";
export { fetchScenarioVerdict } from "./scenario-verdict";
export { fetchWeatherBias } from "./weather-bias";
export { fetchSupplyStress } from "./supply-stress";
export { fetchRegulatoryPulse } from "./regulatory-pulse";
export { fetchAttentionMomentum } from "./attention-momentum";
export { fetchTreasuryDts, fetchTodayAuto, fetchTreasuryDtsTodayAuto, fetchTodayAutoFeed, type TreasuryDtsRow } from "./today-auto";
export type { TodayAutoRow } from "./today-auto";
export { fetchSec8kVelocity, type Sec8kRow } from "./sec-8k-velocity";
export { fetchFredSurprises, type FredRow } from "./fred-surprises";
export { fetchGithubTrending } from "./github-trending";
export { fetchHnFrontpage } from "./hn-frontpage";
export { fetchUsgsQuakes } from "./usgs-quake";
export { fetchOpenAq } from "./openaq-air";

// Shared infra — TokenBucket + fetchWithRetry + keyRotator
export { fetchWithRetry, keyRotator, TokenBucket } from "./rate-limit";

// Lane markers
export const AUTO_LANE = ["geo-pulse","flight-intel","research-pack","scenario-verdict","weather-bias","supply-stress","regulatory-pulse","attention-momentum","treasury-dts","sec-8k-velocity","fred-surprises","github-trending","hn-frontpage","usgs-quake","openaq-air","openrouter-model-usage"] as const;
export const MANUAL_LANE_NEEDS_CAPTURE = ["freight-sonar-leak","tiktok-sound-chart","walmart-target-api"] as const;
