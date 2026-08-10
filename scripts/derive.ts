/**
 * AMFIMGA derive step.
 *
 * Turns the raw monthly holdings in `data/months/` into the SMALL summary files
 * the browser loads from `public/data/`. Pure recomputation — no network.
 * Run with `npm run derive`.
 *
 * THE CORE RULE — coverage-awareness. A month-over-month change is only computed
 * from funds whose fund HOUSE is present in BOTH months compared. If a house is
 * a coverage gap in either month, its funds' change is UNKNOWN (`null`) — a
 * missing house is never treated as having sold to zero. Every month also
 * records how many houses it is based on ("X of Y"), so the UI can be honest.
 *
 * Outputs (all in public/data):
 *   summary.json          which months exist + coverage counts
 *   stocks.json           compact all-stocks table (per stock, per month)
 *   sectors.json          net share-change by sector, per month
 *   stocks/<ISIN>.json    per-stock fund-by-fund detail (loaded on demand)
 */

import {
  readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, existsSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  MonthData,
  SummaryMeta,
  StocksSummary,
  StockRow,
  StockDetail,
  FundTrend,
  SectorSummary,
} from "../src/types/holdings.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const MONTHS_DIR = resolve(ROOT, "data/months");
const OUT_DIR = resolve(ROOT, "public/data");
const DETAIL_DIR = resolve(OUT_DIR, "stocks");
const SCHEMA = 1;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const monthLabel = (m: string): string => {
  const [y, mm] = m.split("-");
  return `${MONTH_NAMES[Number(mm) - 1]} ${y}`;
};
const amcSlugOf = (fundId: string): string => fundId.split(":")[0];

/** A stock position as seen in one fund in one month. */
interface Held {
  shares: number | null;
  value: number | null;
  sector: string | null;
  name: string;
}
/** One fund's holdings in one month, keyed by ISIN. */
interface MonthFund {
  amcSlug: string;
  fundName: string;
  fundHouse: string;
  holds: Map<string, Held>;
}
/** Everything we index for one month. */
interface MonthIndex {
  funds: Map<string, MonthFund>; // fundId → fund
  houses: Set<string>; // amcSlugs present (have data)
  holders: Map<string, string[]>; // isin → fundIds holding it
  housesTotal: number; // houses AdvisorKhoj listed (attempted)
}

/** Add two possibly-null numbers, treating null as "nothing to add" (not 0). */
function addKnown(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

function loadMonths(): { month: string; data: MonthData }[] {
  if (!existsSync(MONTHS_DIR)) return [];
  return readdirSync(MONTHS_DIR)
    .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ""))
    .sort()
    .map((month) => ({
      month,
      data: JSON.parse(readFileSync(resolve(MONTHS_DIR, `${month}.json`), "utf8")) as MonthData,
    }));
}

function indexMonth(data: MonthData): MonthIndex {
  const funds = new Map<string, MonthFund>();
  const houses = new Set<string>();
  const holders = new Map<string, string[]>();

  for (const f of data.funds) {
    const amcSlug = amcSlugOf(f.fundId);
    houses.add(amcSlug);
    let mf = funds.get(f.fundId);
    if (!mf) {
      mf = { amcSlug, fundName: f.fundName, fundHouse: f.fundHouse, holds: new Map() };
      funds.set(f.fundId, mf);
    }
    for (const h of f.holdings) {
      const prev = mf.holds.get(h.isin);
      if (prev) {
        // Same ISIN listed on more than one line in a scheme → combine.
        prev.shares = addKnown(prev.shares, h.shares);
        prev.value = addKnown(prev.value, h.marketValueInr);
        if (!prev.sector && h.sector) prev.sector = h.sector;
      } else {
        mf.holds.set(h.isin, {
          shares: h.shares, value: h.marketValueInr, sector: h.sector, name: h.stockName,
        });
        let list = holders.get(h.isin);
        if (!list) holders.set(h.isin, (list = []));
        list.push(f.fundId);
      }
    }
  }
  const housesTotal = data.coverage?.length ?? houses.size;
  return { funds, houses, holders, housesTotal };
}

/** Shares of one fund's position in one month. Assumes the house is present. */
function sharesOf(mi: MonthIndex, fundId: string, isin: string): number | null {
  const held = mi.funds.get(fundId)?.holds.get(isin);
  // House present but this fund doesn't hold it → a genuine zero (Rule 2 ok).
  if (!held) return 0;
  return held.shares; // may be null (held but share count undisclosed)
}

/**
 * Coverage-aware net share change for one stock between month t-1 and t.
 * Only funds whose house is present in BOTH months count. Returns null when
 * there is no prior month or nothing comparable is known.
 */
function netChange(
  prev: MonthIndex,
  cur: MonthIndex,
  isin: string,
): number | null {
  const comparable = new Set([...cur.houses].filter((h) => prev.houses.has(h)));
  if (comparable.size === 0) return null;

  const fundIds = new Set<string>();
  for (const id of cur.holders.get(isin) ?? []) if (comparable.has(amcSlugOf(id))) fundIds.add(id);
  for (const id of prev.holders.get(isin) ?? []) if (comparable.has(amcSlugOf(id))) fundIds.add(id);

  let net = 0;
  let known = false;
  for (const id of fundIds) {
    const sPrev = sharesOf(prev, id, isin);
    const sCur = sharesOf(cur, id, isin);
    if (sPrev == null || sCur == null) continue; // undisclosed shares → unknown
    net += sCur - sPrev;
    known = true;
  }
  return known ? net : null;
}

function main(): void {
  const months = loadMonths();
  if (months.length === 0) {
    console.error("No raw months found in data/months/. Run `npm run ingest` first.");
    process.exit(1);
  }
  const monthKeys = months.map((m) => m.month);
  const labels = monthKeys.map(monthLabel);
  const T = months.length;
  const idx = months.map((m) => indexMonth(m.data));

  console.log(`Deriving from ${T} months: ${monthKeys.join(", ")}`);

  // Every stock we have ever seen, with a canonical name + latest-known sector.
  const isins = new Set<string>();
  const nameOf = new Map<string, string>();
  const sectorOf = new Map<string, string | null>();
  for (let t = 0; t < T; t++) {
    for (const mf of idx[t].funds.values()) {
      for (const [isin, h] of mf.holds) {
        isins.add(isin);
        if (h.name) nameOf.set(isin, h.name); // latest wins
        if (h.sector) sectorOf.set(isin, h.sector);
        else if (!sectorOf.has(isin)) sectorOf.set(isin, null);
      }
    }
  }

  const stocks: StockRow[] = [];
  const details: StockDetail[] = [];
  // sector → per-month running totals (null until a known value lands).
  const sectorTotals = new Map<string, (number | null)[]>();

  // Latest transition: which houses entered / left the data (for the coverage hover).
  const houseName = new Map<string, string>();
  for (const mi of idx) for (const mf of mi.funds.values()) houseName.set(mf.amcSlug, mf.fundHouse);
  const L = T - 1;
  const enteredLatest = new Set<string>();
  const leftLatest = new Set<string>();
  if (T >= 2) {
    for (const h of idx[L].houses) if (!idx[L - 1].houses.has(h)) enteredLatest.add(h);
    for (const h of idx[L - 1].houses) if (!idx[L].houses.has(h)) leftLatest.add(h);
  }

  for (const isin of isins) {
    const name = nameOf.get(isin) ?? isin;
    const sector = sectorOf.get(isin) ?? null;

    const totalShares: (number | null)[] = [];
    const totalValueInr: (number | null)[] = [];
    const fundCount: (number | null)[] = [];
    const nsc: (number | null)[] = [];

    for (let t = 0; t < T; t++) {
      const holderIds = idx[t].holders.get(isin) ?? [];
      if (holderIds.length === 0) {
        totalShares.push(null);
        totalValueInr.push(null);
        fundCount.push(null);
      } else {
        let s: number | null = null;
        let v: number | null = null;
        for (const id of holderIds) {
          const h = idx[t].funds.get(id)!.holds.get(isin)!;
          if (h.shares != null) s = (s ?? 0) + h.shares;
          if (h.value != null) v = (v ?? 0) + h.value;
        }
        totalShares.push(s);
        totalValueInr.push(v);
        fundCount.push(holderIds.length);
      }
      nsc.push(t === 0 ? null : netChange(idx[t - 1], idx[t], isin));
    }

    // Coverage note: entered/left houses that actually hold this stock.
    let coverageAffected: StockRow["coverageAffected"];
    if (enteredLatest.size || leftLatest.size) {
      const aff = new Map<string, "entered" | "left">();
      for (const id of idx[L].holders.get(isin) ?? []) {
        const s = amcSlugOf(id);
        if (enteredLatest.has(s)) aff.set(s, "entered");
      }
      if (L >= 1) {
        for (const id of idx[L - 1].holders.get(isin) ?? []) {
          const s = amcSlugOf(id);
          if (leftLatest.has(s)) aff.set(s, "left");
        }
      }
      if (aff.size) {
        coverageAffected = [...aff].map(([slug, direction]) => ({
          house: houseName.get(slug) ?? slug,
          direction,
        }));
      }
    }

    stocks.push({
      isin, name, sector, marketCap: null,
      totalShares, totalValueInr, fundCount, netShareChange: nsc, coverageAffected,
    });

    // Fund-by-fund detail.
    const fundIdsEver = new Set<string>();
    for (let t = 0; t < T; t++) for (const id of idx[t].holders.get(isin) ?? []) fundIdsEver.add(id);

    const funds: FundTrend[] = [];
    for (const fundId of fundIdsEver) {
      const amcSlug = amcSlugOf(fundId);
      let fundName = fundId;
      let fundHouse = amcSlug;
      const shares: (number | null)[] = [];
      const change: (number | null)[] = [];
      const event: (("new" | "exit") | null)[] = [];

      for (let t = 0; t < T; t++) {
        const mf = idx[t].funds.get(fundId);
        if (mf) { fundName = mf.fundName; fundHouse = mf.fundHouse; }
        const housePresent = idx[t].houses.has(amcSlug);
        const s = !housePresent ? null : mf?.holds.has(isin) ? mf.holds.get(isin)!.shares : 0;
        shares.push(s);

        const sp = t === 0 ? null : shares[t - 1];
        if (t === 0 || s == null || sp == null) {
          change.push(null);
          event.push(null);
        } else {
          change.push(s - sp);
          event.push(sp === 0 && s > 0 ? "new" : sp > 0 && s === 0 ? "exit" : null);
        }
      }
      funds.push({ fundId, fundName, fundHouse, shares, change, event });
    }
    // Biggest current positions first (nulls last).
    funds.sort((a, b) => (b.shares[T - 1] ?? -1) - (a.shares[T - 1] ?? -1));

    details.push({
      schemaVersion: SCHEMA, isin, name, sector, marketCap: null,
      months: monthKeys, monthLabels: labels,
      totalShares, totalValueInr, fundCount, netShareChange: nsc, funds,
    });

    // Sector roll-up (skip stocks with no disclosed sector — never invent one).
    if (sector) {
      let row = sectorTotals.get(sector);
      if (!row) sectorTotals.set(sector, (row = new Array(T).fill(null)));
      for (let t = 1; t < T; t++) {
        if (nsc[t] != null) row[t] = (row[t] ?? 0) + (nsc[t] as number);
      }
    }
  }

  // ---- write outputs ----
  mkdirSync(OUT_DIR, { recursive: true });
  rmSync(DETAIL_DIR, { recursive: true, force: true });
  mkdirSync(DETAIL_DIR, { recursive: true });

  const summary: SummaryMeta = {
    schemaVersion: SCHEMA,
    generatedAt: new Date().toISOString(),
    months: months.map((m, t) => ({
      month: m.month,
      label: labels[t],
      housesPresent: idx[t].houses.size,
      housesTotal: idx[t].housesTotal,
      fundCount: idx[t].funds.size,
      stockCount: idx[t].holders.size,
    })),
  };
  writeFileSync(resolve(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2) + "\n");

  stocks.sort((a, b) => a.isin.localeCompare(b.isin));
  const stocksOut: StocksSummary = { schemaVersion: SCHEMA, months: monthKeys, monthLabels: labels, stocks };
  writeFileSync(resolve(OUT_DIR, "stocks.json"), JSON.stringify(stocksOut)); // minified — machine-loaded

  const sectorsOut: SectorSummary = {
    schemaVersion: SCHEMA, months: monthKeys, monthLabels: labels,
    sectors: [...sectorTotals.entries()]
      .map(([sector, netShareChange]) => ({ sector, netShareChange }))
      .sort((a, b) => a.sector.localeCompare(b.sector)),
  };
  writeFileSync(resolve(OUT_DIR, "sectors.json"), JSON.stringify(sectorsOut, null, 2) + "\n");

  for (const d of details) {
    writeFileSync(resolve(DETAIL_DIR, `${d.isin}.json`), JSON.stringify(d)); // minified
  }

  console.log(
    `Wrote summary.json, stocks.json (${stocks.length} stocks), sectors.json ` +
      `(${sectorsOut.sectors.length} sectors), and ${details.length} per-stock detail files.`,
  );
  for (const m of summary.months) {
    console.log(`  ${m.label}: ${m.housesPresent}/${m.housesTotal} houses, ${m.fundCount} funds, ${m.stockCount} stocks`);
  }
}

main();
