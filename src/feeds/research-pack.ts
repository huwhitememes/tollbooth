import { queryResearchPack } from "../osint-products";
export async function fetchResearchPack(opts={ topic: "ai" }){
  const data = await queryResearchPack(opts as any);
  const rows = (data as any).rows ?? [data];
  return rows;
}
