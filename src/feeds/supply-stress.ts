import { querySupplyStress } from "../osint-products";
export async function fetchSupplyStress(opts={}){
  const data = await querySupplyStress(opts as any);
  return [data];
}
