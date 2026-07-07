import { queryRegulatoryPulse } from "../osint-products";
export async function fetchRegulatoryPulse(opts={}){
  const data = await queryRegulatoryPulse(opts as any);
  return [data];
}
