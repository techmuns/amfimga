import type { StockRow } from "../types/holdings";

/**
 * Sector → colour mapping. The 8 fixed sector colours are handed out in a stable
 * order (biggest sectors by market value first). The 9th sector onward folds into
 * grey "Other". Colours never cycle and never recolour between renders.
 */
export interface SectorScale {
  /** The (up to) 8 sectors that get a distinct colour, biggest first. */
  top: string[];
  /** CSS colour for a sector (a `var(--sector-*)`), grey for the rest. */
  colorOf: (sector: string | null) => string;
  /** True if the sector folds into "Other". */
  isOther: (sector: string | null) => boolean;
}

export function buildSectorScale(stocks: StockRow[], monthIdx: number): SectorScale {
  const byValue = new Map<string, number>();
  for (const s of stocks) {
    if (!s.sector) continue;
    byValue.set(s.sector, (byValue.get(s.sector) ?? 0) + (s.totalValueInr[monthIdx] ?? 0));
  }
  const top = [...byValue.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([sector]) => sector);
  const color = new Map(top.map((sector, i) => [sector, `var(--sector-${i + 1})`]));
  return {
    top,
    colorOf: (sector) => (sector && color.get(sector)) || "var(--sector-other)",
    isOther: (sector) => !sector || !color.has(sector),
  };
}
