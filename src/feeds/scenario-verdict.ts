import { queryScenarioVerdict } from "../osint-products";
export async function fetchScenarioVerdict(opts={ seed_text:"seed", market_question:"Will it happen?" }){
  const data = await queryScenarioVerdict(opts as any);
  return [data];
}
