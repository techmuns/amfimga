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
import { gunzipSync } from "node:zlib";
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
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

// --- Part A: granular NSE industries → ~12 broad AMFI-style macro sectors ---
const MACRO_GROUPS: Record<string, string[]> = {
  "Financial Services": ["banks", "finance", "capital markets", "insurance", "financial technology (fintech)"],
  "Information Technology": ["it - software", "it - services", "it - hardware"],
  "Healthcare": ["pharmaceuticals & biotechnology", "healthcare services", "healthcare equipment & supplies"],
  "Energy": ["oil", "gas", "petroleum products", "consumable fuels"],
  "Consumer Discretionary": ["automobiles", "auto components", "consumer durables", "retailing", "leisure services", "realty", "textiles & apparels", "other consumer services", "agricultural, commercial & construction vehicles"],
  "Consumer Staples": ["diversified fmcg", "food products", "beverages", "personal products", "household products", "agricultural food & other products", "cigarettes & tobacco products"],
  "Industrials": ["industrial products", "electrical equipment", "construction", "industrial manufacturing", "aerospace & defense", "commercial services & supplies", "transport services", "transport infrastructure"],
  "Materials": ["chemicals & petrochemicals", "fertilizers & agrochemicals", "ferrous metals", "non - ferrous metals", "diversified metals", "minerals & mining", "metals & minerals trading", "paper, forest & jute products", "cement & cement products", "other construction materials"],
  "Utilities": ["power", "other utilities"],
  "Communication": ["telecom - services", "telecom - equipment & accessories", "media", "entertainment"],
  "Diversified": ["diversified"],
};
const normIndustry = (s: string): string =>
  s.toLowerCase().replace(/\s+and\s+/g, " & ").replace(/\s+/g, " ").trim();
const INDUSTRY_TO_MACRO = new Map<string, string>();
for (const [macro, inds] of Object.entries(MACRO_GROUPS)) {
  for (const ind of inds) INDUSTRY_TO_MACRO.set(normIndustry(ind), macro);
}
/** Map a granular industry to its macro sector; unmapped/unknown → null (never guess). */
function macroOf(sector: string | null): string | null {
  if (!sector) return null;
  return INDUSTRY_TO_MACRO.get(normIndustry(sector)) ?? "Other";
}

// --- Part B: AMFI large/mid/small cap map (ISIN → cap), produced by scripts/marketcap.ts ---
type Cap = "large" | "mid" | "small";
function loadCaps(): Record<string, Cap> {
  const p = resolve(ROOT, "data/marketcap.json");
  if (!existsSync(p)) return {};
  try {
    return (JSON.parse(readFileSync(p, "utf8")) as { caps?: Record<string, Cap> }).caps ?? {};
  } catch {
    return {};
  }
}

/** A stock position as seen in one fund in one month. */
interface Held {
  shares: number | null;
  value: number | null;
  percent: number | null;
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

// Raw months are gzip-compressed (<YYYY-MM>.json.gz); a plain .json is still read
// if present (migration). Newest last (sorted ascending).
function loadMonths(): { month: string; data: MonthData }[] {
  if (!existsSync(MONTHS_DIR)) return [];
  const months = new Set<string>();
  for (const f of readdirSync(MONTHS_DIR)) {
    const m = f.match(/^(\d{4}-\d{2})\.json(\.gz)?$/);
    if (m) months.add(m[1]);
  }
  return [...months].sort().map((month) => {
    const gz = resolve(MONTHS_DIR, `${month}.json.gz`);
    const raw = existsSync(gz)
      ? gunzipSync(readFileSync(gz)).toString("utf8")
      : readFileSync(resolve(MONTHS_DIR, `${month}.json`), "utf8");
    return { month, data: JSON.parse(raw) as MonthData };
  });
}

// Ordinary equity shares only (a decision from the start). In an Indian ISIN the
// two characters after the 4-char company code (positions 8-9) encode the security
// type: "01" = ordinary equity; bonds/debentures use 07/08/09/0A… Verified against
// real ISINs (HDFC INE040A01034 → "01"; every 07/08 in our data is a bond).
const RATING_AGENCY = /\b(crisil|icra|care|fitch|brickwork|bwr|india ratings)\b/i;
const RATING_GRADE = /\b(aaa|aa|a1|a2|a3|a4|bbb|bb)\b/i;
const GOV_DEBT = /\b(sovereign|treasury bills?|t-bills?|g-sec|gilts?|state development loans?|government securit\w*)\b/i;

function isEquity(isin: string, sector: string | null): boolean {
  if (isin.length !== 12 || isin.slice(7, 9) !== "01") return false;
  // Backstop: drop anything mislabelled with a credit rating or a govt-security
  // "sector" (defensive — no equity ISIN in the data currently trips this).
  if (sector && ((RATING_AGENCY.test(sector) && RATING_GRADE.test(sector)) || GOV_DEBT.test(sector))) {
    return false;
  }
  return true;
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
      if (!isEquity(h.isin, h.sector)) continue; // equity shares only — drop bonds/debt
      const prev = mf.holds.get(h.isin);
      if (prev) {
        // Same ISIN listed on more than one line in a scheme → combine.
        prev.shares = addKnown(prev.shares, h.shares);
        prev.value = addKnown(prev.value, h.marketValueInr);
        prev.percent = addKnown(prev.percent, h.portfolioPercent);
        if (!prev.sector && h.sector) prev.sector = h.sector;
      } else {
        mf.holds.set(h.isin, {
          shares: h.shares, value: h.marketValueInr, percent: h.portfolioPercent,
          sector: h.sector, name: h.stockName,
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

interface Flow {
  net: number | null; // coverage-aware net share change
  buying: number | null; // funds that added (incl. new positions)
  selling: number | null; // funds that trimmed (incl. exits)
}

/**
 * Coverage-aware flow for one stock between month t-1 and t. Only funds whose
 * house is present in BOTH months count. All null when there is no prior month
 * or nothing comparable is known.
 */
function flowDetail(prev: MonthIndex, cur: MonthIndex, isin: string): Flow {
  const comparable = new Set([...cur.houses].filter((h) => prev.houses.has(h)));
  if (comparable.size === 0) return { net: null, buying: null, selling: null };

  const fundIds = new Set<string>();
  for (const id of cur.holders.get(isin) ?? []) if (comparable.has(amcSlugOf(id))) fundIds.add(id);
  for (const id of prev.holders.get(isin) ?? []) if (comparable.has(amcSlugOf(id))) fundIds.add(id);

  let net = 0;
  let known = false;
  let buying = 0;
  let selling = 0;
  for (const id of fundIds) {
    const sPrev = sharesOf(prev, id, isin);
    const sCur = sharesOf(cur, id, isin);
    if (sPrev == null || sCur == null) continue; // undisclosed shares → unknown
    const d = sCur - sPrev;
    net += d;
    known = true;
    if (d > 0) buying++;
    else if (d < 0) selling++;
  }
  return known ? { net, buying, selling } : { net: null, buying: null, selling: null };
}

const netChange = (prev: MonthIndex, cur: MonthIndex, isin: string): number | null =>
  flowDetail(prev, cur, isin).net;

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
  const caps = loadCaps();
  let capMatched = 0;

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
    const macroSector = macroOf(sector);
    const marketCap = caps[isin] ?? null;
    if (marketCap) capMatched++;

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

    // This month's flow detail (funds adding vs trimming), coverage-aware.
    const flow = L >= 1 ? flowDetail(idx[L - 1], idx[L], isin) : { net: null, buying: null, selling: null };

    // Brand-new to funds this month: never held in any earlier month, and held
    // now by a house that was ALSO present last month (so it's a real new entry,
    // not just a fund house joining the dataset).
    let newEntry = false;
    if (L >= 1) {
      const heldBefore = idx.slice(0, L).some((mi) => (mi.holders.get(isin)?.length ?? 0) > 0);
      const comparable = new Set([...idx[L].houses].filter((h) => idx[L - 1].houses.has(h)));
      const heldNowComparable = (idx[L].holders.get(isin) ?? []).some((id) => comparable.has(amcSlugOf(id)));
      newEntry = !heldBefore && heldNowComparable;
    }

    // Dominant holder this month (which fund owns the biggest slice of the
    // mutual-fund-held shares) — for the "held by only a few funds" ideas.
    let topHolder: StockRow["topHolder"];
    {
      const holderIds = idx[L].holders.get(isin) ?? [];
      let topId: string | null = null;
      let topShares = -1;
      let sum = 0;
      for (const id of holderIds) {
        const s = idx[L].funds.get(id)!.holds.get(isin)!.shares;
        if (s != null) {
          sum += s;
          if (s > topShares) { topShares = s; topId = id; }
        }
      }
      if (topId && sum > 0) {
        const mf = idx[L].funds.get(topId)!;
        topHolder = { fundName: mf.fundName, fundHouse: mf.fundHouse, sharePct: round4((topShares / sum) * 100) };
      }
    }

    stocks.push({
      isin, name, sector, macroSector, marketCap,
      totalShares, totalValueInr, fundCount, netShareChange: nsc, coverageAffected,
      fundsBuying: flow.buying, fundsSelling: flow.selling, newEntry, topHolder,
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
      const percent: (number | null)[] = [];
      const present: boolean[] = [];

      for (let t = 0; t < T; t++) {
        const mf = idx[t].funds.get(fundId);
        if (mf) { fundName = mf.fundName; fundHouse = mf.fundHouse; }
        const housePresent = idx[t].houses.has(amcSlug);
        present.push(housePresent);
        const held = housePresent ? mf?.holds.get(isin) : undefined;
        const s = !housePresent ? null : held ? held.shares : 0;
        shares.push(s);
        percent.push(!housePresent ? null : held ? held.percent : 0);

        const sp = t === 0 ? null : shares[t - 1];
        if (t === 0 || s == null || sp == null) {
          change.push(null);
          event.push(null);
        } else {
          change.push(s - sp);
          event.push(sp === 0 && s > 0 ? "new" : sp > 0 && s === 0 ? "exit" : null);
        }
      }
      funds.push({ fundId, fundName, fundHouse, shares, change, event, percent, present });
    }
    // Biggest current positions first (nulls last).
    funds.sort((a, b) => (b.shares[T - 1] ?? -1) - (a.shares[T - 1] ?? -1));

    details.push({
      schemaVersion: SCHEMA, isin, name, sector, macroSector, marketCap,
      months: monthKeys, monthLabels: labels,
      totalShares, totalValueInr, fundCount, netShareChange: nsc, funds,
    });

    // Sector roll-up by MACRO sector (skip stocks with no sector — never invent one).
    if (macroSector) {
      let row = sectorTotals.get(macroSector);
      if (!row) sectorTotals.set(macroSector, (row = new Array(T).fill(null)));
      for (let t = 1; t < T; t++) {
        if (nsc[t] != null) row[t] = (row[t] ?? 0) + (nsc[t] as number);
      }
    }
  }

  // ---- write outputs ----
  mkdirSync(OUT_DIR, { recursive: true });
  rmSync(DETAIL_DIR, { recursive: true, force: true });
  mkdirSync(DETAIL_DIR, { recursive: true });

  // Macro-sector colour order — the 8 biggest macro sectors by latest value get a
  // colour; stored so every page colours sectors identically. Rest fold to "Other".
  const sectorValue = new Map<string, number>();
  for (const s of stocks) {
    if (!s.macroSector || s.macroSector === "Other") continue;
    sectorValue.set(s.macroSector, (sectorValue.get(s.macroSector) ?? 0) + (s.totalValueInr[L] ?? 0));
  }
  const topSectors = [...sectorValue.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s]) => s);

  const summary: SummaryMeta = {
    schemaVersion: SCHEMA,
    generatedAt: new Date().toISOString(),
    topSectors,
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
      `(${sectorsOut.sectors.length} macro sectors), and ${details.length} per-stock detail files.`,
  );
  console.log(
    `Market cap: ${capMatched}/${stocks.length} stocks tagged (${((100 * capMatched) / stocks.length).toFixed(1)}%)` +
      (Object.keys(caps).length === 0 ? " — no data/marketcap.json (run `npm run marketcap`)" : ""),
  );
  for (const m of summary.months) {
    console.log(`  ${m.label}: ${m.housesPresent}/${m.housesTotal} houses, ${m.fundCount} funds, ${m.stockCount} stocks`);
  }
}

main();
