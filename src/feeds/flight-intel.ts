import { queryFlightIntel } from "../osint-products";
export async function fetchFlightIntel(opts={}){
  const data = await queryFlightIntel(opts as any);
  const rows = (data as any).aircraft ?? (data as any).filtered ?? [data];
  return rows;
}
