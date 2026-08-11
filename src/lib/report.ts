/**
 * Report model (Step: polish + export).
 *
 * A pure, presentation-only aggregation of the SMALL derived summaries the app
 * already loads (summary.json + stocks.json + sectors.json). It does NOT change
 * any data or analysis — it only picks/sorts/sums existing coverage-aware numbers
 * for display, and is shared by the Overview tab, the Excel export and the PDF
 * report so all three agree.
 */
import type { MarketCap, SectorSummary, StockRow, StocksSummary, SummaryMeta } from "../types/holdings";

export interface Move {
  isin: string;
  name: string;
  macroSector: string | null;
  marketCap: MarketCap | null;
  net: number | null;
  fundCount: number | null;
  fundsBuying: number | null;
  fundsSelling: number | null;
}

export interface ReportModel {
  month: string;
  monthLabel: string;
  firstMonthLabel: string;
  housesPresent: number;
  housesTotal: number;
  stockCount: number;
  fundCount: number;
  /** Coverage-aware biggest net buys / sells this month, largest first. */
  topBuys: Move[];
  topSells: Move[];
  /** Net share change by macro sector, largest magnitude first. */
  sectors: { sector: string; net: number }[];
  /** Net share change by market-cap band. */
  capFlows: { cap: MarketCap; net: number }[];
  /** Market breadth: how many stocks funds net-bought vs net-sold this month. */
  breadth: { bought: number; sold: number; flat: number; measured: number };
  biggestBuy: Move | null;
  biggestSell: Move | null;
  leadingSector: { sector: string; net: number } | null;
  /** Idea lists. */
  newEntries: Move[];
  turnedAround: (Move & { prevNet: number | null })[];
  heldByFew: (Move & { topHolder: StockRow["topHolder"] })[];
}

const CAP_ORDER: MarketCap[] = ["large", "mid", "small"];

const toMove = (s: StockRow, L: number): Move => ({
  isin: s.isin,
  name: s.name,
  macroSector: s.macroSector,
  marketCap: s.marketCap,
  net: s.netShareChange[L] ?? null,
  fundCount: s.fundCount[L] ?? null,
  fundsBuying: s.fundsBuying ?? null,
  fundsSelling: s.fundsSelling ?? null,
});

export function buildReport(summary: SummaryMeta, stocks: StocksSummary, sectors: SectorSummary): ReportModel {
  const L = stocks.months.length - 1;
  const meta = summary.months[summary.months.length - 1];
  const rows = stocks.stocks;

  const withNet = rows.map((s) => ({ s, net: s.netShareChange[L] })).filter((x): x is { s: StockRow; net: number } => x.net != null && x.net !== 0);
  const topBuys = [...withNet].filter((x) => x.net > 0).sort((a, b) => b.net - a.net).map((x) => toMove(x.s, L));
  const topSells = [...withNet].filter((x) => x.net < 0).sort((a, b) => a.net - b.net).map((x) => toMove(x.s, L));

  const sectorRows = sectors.sectors
    .map((r) => ({ sector: r.sector, net: r.netShareChange[sectors.months.length - 1] }))
    .filter((x): x is { sector: string; net: number } => x.net != null && x.net !== 0)
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

  const capSum = new Map<MarketCap, number>();
  for (const s of rows) {
    const n = s.netShareChange[L];
    if (s.marketCap && n != null) capSum.set(s.marketCap, (capSum.get(s.marketCap) ?? 0) + n);
  }
  const capFlows = CAP_ORDER.filter((c) => capSum.has(c)).map((cap) => ({ cap, net: capSum.get(cap)! }));

  let bought = 0, sold = 0, flat = 0;
  for (const s of rows) {
    const n = s.netShareChange[L];
    if (n == null) continue;
    if (n > 0) bought++; else if (n < 0) sold++; else flat++;
  }

  const leadingSector = [...sectorRows].filter((x) => x.net > 0).sort((a, b) => b.net - a.net)[0] ?? null;

  const newEntries = rows.filter((s) => s.newEntry).map((s) => toMove(s, L)).sort((a, b) => (b.net ?? 0) - (a.net ?? 0));
  const turnedAround = rows
    .filter((s) => {
      const a = s.netShareChange[L - 1], b = s.netShareChange[L];
      return a != null && b != null && a !== 0 && b !== 0 && Math.sign(a) !== Math.sign(b);
    })
    .map((s) => ({ ...toMove(s, L), prevNet: s.netShareChange[L - 1] ?? null }))
    .sort((a, b) => (b.net ?? 0) - (a.net ?? 0));
  const heldByFew = rows
    .filter((s) => (s.fundCount[L] != null && s.fundCount[L]! <= 3) || (s.topHolder != null && s.topHolder.sharePct >= 70))
    .map((s) => ({ ...toMove(s, L), topHolder: s.topHolder }))
    .sort((a, b) => (a.fundCount ?? 99) - (b.fundCount ?? 99));

  return {
    month: meta.month,
    monthLabel: meta.label,
    firstMonthLabel: stocks.monthLabels[0],
    housesPresent: meta.housesPresent,
    housesTotal: meta.housesTotal,
    stockCount: meta.stockCount,
    fundCount: meta.fundCount,
    topBuys,
    topSells,
    sectors: sectorRows,
    capFlows,
    breadth: { bought, sold, flat, measured: bought + sold + flat },
    biggestBuy: topBuys[0] ?? null,
    biggestSell: topSells[0] ?? null,
    leadingSector,
    newEntries,
    turnedAround,
    heldByFew,
  };
}

export const CAP_LABEL: Record<MarketCap, string> = { large: "Large cap", mid: "Mid cap", small: "Small cap" };
