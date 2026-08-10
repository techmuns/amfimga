import type {
  SummaryMeta,
  StocksSummary,
  StockDetail,
  SectorSummary,
} from "../types/holdings";

/**
 * Runtime data loading (Rule 1).
 *
 * The browser only ever loads the SMALL derived summaries under /data — never
 * the big raw month files (those live outside public/, in data/months/). The
 * summaries are produced by `scripts/derive.ts`.
 */

async function getJson<T>(url: string, what: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Could not load ${what} (HTTP ${res.status}).`);
  return (await res.json()) as T;
}

/** Which months exist and how complete each is ("X of Y houses"). */
export const loadSummary = (): Promise<SummaryMeta> =>
  getJson("/data/summary.json", "the summary");

/** The compact all-stocks table for the main view. */
export const loadStocks = (): Promise<StocksSummary> =>
  getJson("/data/stocks.json", "the stocks table");

/** Net share-change by sector, per month. */
export const loadSectors = (): Promise<SectorSummary> =>
  getJson("/data/sectors.json", "the sector summary");

/** One stock's fund-by-fund detail, loaded on demand. */
export const loadStockDetail = (isin: string): Promise<StockDetail> =>
  getJson(`/data/stocks/${encodeURIComponent(isin)}.json`, `details for ${isin}`);
