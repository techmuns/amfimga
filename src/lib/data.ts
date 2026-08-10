import type { DataIndex, MonthData } from "../types/holdings";

/**
 * Runtime data loading (Rule 1).
 *
 * The site NEVER bundles holdings data into the JS. Everything is fetched at
 * runtime from static files under /data, so the monthly data can be replaced
 * by dropping in new files — no rebuild, no redeploy of code.
 */

const INDEX_URL = "/data/index.json";

/** Load the index of available months. */
export async function loadIndex(): Promise<DataIndex> {
  const res = await fetch(INDEX_URL, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Could not load the data index (HTTP ${res.status}).`);
  }
  return (await res.json()) as DataIndex;
}

/** Load a single month's data file, given its path from the index. */
export async function loadMonth(file: string): Promise<MonthData> {
  const res = await fetch(file, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Could not load month file "${file}" (HTTP ${res.status}).`);
  }
  return (await res.json()) as MonthData;
}
