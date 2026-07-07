import { queryAttentionMomentum } from "../osint-products";
export async function fetchAttentionMomentum(opts={}){
  const data = await queryAttentionMomentum(opts as any);
  return [data];
}
