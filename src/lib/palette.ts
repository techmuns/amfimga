/**
 * Sector → colour mapping. The 8 fixed sector colours are handed out in the
 * order given by `topSectors` (the 8 biggest sectors by value, computed once in
 * derive and shared via summary.json so every page colours sectors identically).
 * The 9th sector onward folds into grey "Other". Colours never cycle.
 */
export interface SectorScale {
  top: string[];
  colorOf: (sector: string | null) => string;
  isOther: (sector: string | null) => boolean;
}

export function makeSectorScale(topSectors: string[]): SectorScale {
  const color = new Map(topSectors.slice(0, 8).map((sector, i) => [sector, `var(--sector-${i + 1})`]));
  return {
    top: topSectors.slice(0, 8),
    colorOf: (sector) => (sector && color.get(sector)) || "var(--sector-other)",
    isOther: (sector) => !sector || !color.has(sector),
  };
}
