import { queryWeatherBias } from "../osint-products";
export async function fetchWeatherBias(opts={ city:"NYC" }){
  const data = await queryWeatherBias(opts as any);
  return [data];
}
