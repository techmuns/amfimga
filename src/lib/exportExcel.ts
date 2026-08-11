/**
 * Excel export (lazy-loaded). Builds a formatted .xlsx from the CURRENTLY loaded
 * summaries and downloads it. exceljs is dynamically imported so it never lands
 * in the main bundle. Values are real numbers (crore, 1-decimal via number
 * format; percentages 0.0; counts integer), headers frozen + filtered, borders
 * everywhere, net change coloured green/red.
 */
import type { FundsIndex, SectorSummary, StockRow, StocksSummary, SummaryMeta } from "../types/holdings";
import { buildReport, CAP_LABEL, type Move } from "./report";

const CR = 1e7;
const toCr = (v: number | null | undefined): number | null => (v == null || !Number.isFinite(v) ? null : v / CR);
const capName = (c: StockRow["marketCap"]): string => (c ? CAP_LABEL[c].replace(" cap", "") : "—");
const pctOf = (part: number | null | undefined, whole: number | null | undefined): number | null =>
  part == null || whole == null || whole === 0 ? null : (part / whole) * 100;

// exceljs-ish types are loaded dynamically; keep this module light with `any`.
/* eslint-disable @typescript-eslint/no-explicit-any */

const INK = "FF1A1A17";
const HEAD = "FF20558A"; // deep editorial blue
const CREAM = "FFF6F1E6";
const BUY = "FF0C8A0C";
const SELL = "FFC0392B";
const BORDER = { style: "thin" as const, color: { argb: "FFCBC7BB" } };
const allBorders = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };

export async function exportExcel(
  summary: SummaryMeta,
  stocks: StocksSummary,
  sectors: SectorSummary,
  funds: FundsIndex | null,
): Promise<void> {
  const ExcelJS = (await import("exceljs")).default;
  const r = buildReport(summary, stocks, sectors);
  const wb = new ExcelJS.Workbook();
  wb.creator = "AMFIMGA";

  const titleRow = (ws: any, cols: number, sub: string) => {
    ws.mergeCells(1, 1, 1, cols);
    const c = ws.getCell(1, 1);
    c.value = "Mutual Fund Ownership Insights";
    c.font = { name: "Calibri", size: 15, bold: true, color: { argb: INK } };
    c.alignment = { vertical: "middle" };
    ws.getRow(1).height = 24;
    ws.mergeCells(2, 1, 2, cols);
    const s = ws.getCell(2, 1);
    s.value = `${sub}  ·  as of ${r.monthLabel}  ·  based on ${r.housesPresent} of ${r.housesTotal} fund houses`;
    s.font = { name: "Calibri", size: 10, italic: true, color: { argb: "FF6A675F" } };
  };

  const headerRow = (ws: any, headers: string[], rowIdx: number, fill = HEAD) => {
    const row = ws.getRow(rowIdx);
    headers.forEach((h, i) => {
      const c = row.getCell(i + 1);
      c.value = h;
      c.font = { name: "Calibri", bold: true, color: { argb: "FFFFFFFF" } };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
      c.alignment = { vertical: "middle", horizontal: i === 0 ? "left" : "right", wrapText: true };
      c.border = allBorders;
    });
    row.height = 26;
  };

  // column spec: {h, w, num?, get}
  const dataSheet = (name: string, spec: { h: string; w: number; num?: string; buysell?: boolean; get: (m: any) => any }[], rows: any[], sub: string) => {
    const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 3 }] });
    titleRow(ws, spec.length, sub);
    headerRow(ws, spec.map((s) => s.h), 3);
    rows.forEach((m, ri) => {
      const row = ws.getRow(4 + ri);
      spec.forEach((s, ci) => {
        const c = row.getCell(ci + 1);
        const v = s.get(m);
        c.value = v;
        c.border = allBorders;
        c.alignment = { horizontal: ci === 0 ? "left" : "right", vertical: "middle", wrapText: ci === 0 };
        if (s.num && typeof v === "number") c.numFmt = s.num;
        if (s.buysell && typeof v === "number") c.font = { color: { argb: v >= 0 ? BUY : SELL } };
        if ((4 + ri) % 2 === 0) c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CREAM } };
      });
    });
    spec.forEach((s, ci) => (ws.getColumn(ci + 1).width = s.w));
    ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: spec.length } };
    return ws;
  };

  const SIGNED = '+0.0;−0.0;0.0';

  // ---- Summary ----
  {
    const ws = wb.addWorksheet("Summary", { views: [{ state: "frozen", ySplit: 2 }] });
    titleRow(ws, 4, "Market summary");
    ws.getColumn(1).width = 26; ws.getColumn(2).width = 16; ws.getColumn(3).width = 26; ws.getColumn(4).width = 16;
    let row = 4;
    const kv = (label: string, val: any, num?: string) => {
      const a = ws.getCell(row, 1); a.value = label; a.font = { bold: true, color: { argb: INK } }; a.border = allBorders;
      const b = ws.getCell(row, 2); b.value = val; b.alignment = { horizontal: "right" }; b.border = allBorders; if (num && typeof val === "number") b.numFmt = num;
      row++;
    };
    kv("As of", r.monthLabel);
    kv("Coverage (houses)", `${r.housesPresent} of ${r.housesTotal}`);
    kv("Stocks tracked", r.stockCount, "#,##0");
    kv("Funds (schemes)", r.fundCount, "#,##0");
    kv("Stocks net-bought", r.breadth.bought, "#,##0");
    kv("Stocks net-sold", r.breadth.sold, "#,##0");
    kv("Biggest net buy", r.biggestBuy ? `${r.biggestBuy.name}` : "—");
    kv("Biggest net sell", r.biggestSell ? `${r.biggestSell.name}` : "—");
    kv("Leading sector", r.leadingSector ? r.leadingSector.sector : "—");
    row += 1;
    const hdr = ws.getRow(row); ["Top buys (Cr shares)", "Δ", "Top sells (Cr shares)", "Δ"].forEach((h, i) => {
      const c = hdr.getCell(i + 1); c.value = h; c.font = { bold: true, color: { argb: "FFFFFFFF" } };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEAD } }; c.border = allBorders;
      c.alignment = { horizontal: i % 2 === 0 ? "left" : "right" };
    });
    row++;
    const n = Math.max(Math.min(r.topBuys.length, 5), Math.min(r.topSells.length, 5));
    for (let i = 0; i < n; i++) {
      const b = r.topBuys[i], s = r.topSells[i];
      const cell = (col: number, val: any, num?: string, color?: string) => {
        const c = ws.getCell(row, col); c.value = val; c.border = allBorders;
        c.alignment = { horizontal: col % 2 === 1 ? "left" : "right" };
        if (num && typeof val === "number") c.numFmt = num; if (color && typeof val === "number") c.font = { color: { argb: color } };
      };
      cell(1, b ? b.name : ""); cell(2, b ? toCr(b.net) : "", SIGNED, BUY);
      cell(3, s ? s.name : ""); cell(4, s ? toCr(s.net) : "", SIGNED, SELL);
      row++;
    }
  }

  // ---- All stocks ----
  dataSheet("All stocks", [
    { h: "Stock", w: 34, get: (m: StockRow) => m.name },
    { h: "ISIN", w: 15, get: (m: StockRow) => m.isin },
    { h: "Macro sector", w: 20, get: (m: StockRow) => m.macroSector ?? "—" },
    { h: "Cap", w: 8, get: (m: StockRow) => capName(m.marketCap) },
    { h: "Total shares (Cr)", w: 15, num: "#,##0.0", get: (m: StockRow) => toCr(m.totalShares[stocks.months.length - 1]) },
    { h: "Net change (Cr)", w: 14, num: SIGNED, buysell: true, get: (m: StockRow) => toCr(m.netShareChange[stocks.months.length - 1]) },
    { h: "Funds", w: 8, num: "#,##0", get: (m: StockRow) => m.fundCount[stocks.months.length - 1] ?? null },
    { h: "% buying", w: 10, num: "0.0", get: (m: StockRow) => pctOf(m.fundsBuying, m.fundCount[stocks.months.length - 1]) },
    { h: "% selling", w: 10, num: "0.0", get: (m: StockRow) => pctOf(m.fundsSelling, m.fundCount[stocks.months.length - 1]) },
  ], [...stocks.stocks].sort((a, b) => (b.netShareChange[stocks.months.length - 1] ?? -Infinity) - (a.netShareChange[stocks.months.length - 1] ?? -Infinity)), "All stocks");

  // ---- Flows ----
  const flowSpec = [
    { h: "Rank", w: 7, num: "#,##0", get: (m: any) => m._rank },
    { h: "Stock", w: 34, get: (m: Move) => m.name },
    { h: "Macro sector", w: 20, get: (m: Move) => m.macroSector ?? "—" },
    { h: "Cap", w: 8, get: (m: Move) => capName(m.marketCap) },
    { h: "Net change (Cr)", w: 15, num: SIGNED, buysell: true, get: (m: Move) => toCr(m.net) },
    { h: "Funds", w: 8, num: "#,##0", get: (m: Move) => m.fundCount },
  ];
  const rank = (arr: Move[]) => arr.slice(0, 25).map((m, i) => ({ ...m, _rank: i + 1 }));
  dataSheet("Flows — buys", flowSpec, rank(r.topBuys), "Biggest net buys");
  dataSheet("Flows — sells", flowSpec, rank(r.topSells), "Biggest net sells");

  // ---- Ideas ----
  dataSheet("Ideas — new entries", [
    { h: "Stock", w: 34, get: (m: Move) => m.name },
    { h: "Macro sector", w: 20, get: (m: Move) => m.macroSector ?? "—" },
    { h: "Cap", w: 8, get: (m: Move) => capName(m.marketCap) },
    { h: "Funds now", w: 10, num: "#,##0", get: (m: Move) => m.fundCount },
    { h: "Net change (Cr)", w: 15, num: SIGNED, buysell: true, get: (m: Move) => toCr(m.net) },
  ], r.newEntries, "Brand-new to mutual funds");
  dataSheet("Ideas — turned around", [
    { h: "Stock", w: 34, get: (m: any) => m.name },
    { h: "Macro sector", w: 20, get: (m: any) => m.macroSector ?? "—" },
    { h: "Last month (Cr)", w: 15, num: SIGNED, buysell: true, get: (m: any) => toCr(m.prevNet) },
    { h: "This month (Cr)", w: 15, num: SIGNED, buysell: true, get: (m: any) => toCr(m.net) },
  ], r.turnedAround, "Flow flipped direction");
  dataSheet("Ideas — held by few", [
    { h: "Stock", w: 34, get: (m: any) => m.name },
    { h: "Macro sector", w: 20, get: (m: any) => m.macroSector ?? "—" },
    { h: "Funds", w: 8, num: "#,##0", get: (m: any) => m.fundCount },
    { h: "Top holder", w: 26, get: (m: any) => (m.topHolder ? `${Math.round(m.topHolder.sharePct)}% ${m.topHolder.fundHouse}` : "—") },
  ], r.heldByFew, "Held by only a few funds");

  // ---- Sectors ----
  dataSheet("Sectors", [
    { h: "Macro sector", w: 26, get: (m: any) => m.sector },
    { h: "Net change (Cr shares)", w: 20, num: SIGNED, buysell: true, get: (m: any) => toCr(m.net) },
  ], r.sectors, "Net flow by macro sector");

  // ---- Funds ----
  if (funds) {
    dataSheet("Funds", [
      { h: "Name", w: 40, get: (m: any) => m.name },
      { h: "Type", w: 10, get: (m: any) => (m.kind === "house" ? "House" : "Scheme") },
      { h: "Fund house", w: 26, get: (m: any) => m.house },
      { h: "Stocks held", w: 12, num: "#,##0", get: (m: any) => m.stockCount },
      { h: "Equity value (₹ Cr)", w: 18, num: "#,##0.0", get: (m: any) => toCr(m.valueInr) },
    ], funds.entries, "Funds & fund houses");
  }

  const buf = await wb.xlsx.writeBuffer();
  download(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `AMFIMGA-${r.month}.xlsx`);
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
