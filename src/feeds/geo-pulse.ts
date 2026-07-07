import { queryGeoPulse } from "../osint-products";
export async function fetchGeoPulse(opts={}){
  const rows = await queryGeoPulse(opts as any);
  // normalized -> cache pattern handled by caller
  return Array.isArray((rows as any).signals) ? (rows as any).signals : [rows];
}
