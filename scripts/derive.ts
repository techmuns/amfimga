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
  FundHoldings,
  SummaryMeta,
  StocksSummary,
  StockRow,
  StockDetail,
  FundTrend,
  SectorSummary,
  MarketCap,
  FundsIndex,
  FundIndexEntry,
  FundDetail,
  FundHoldingTrend,
  TrendsetterEntry,
  ConsensusEntry,
} from "../src/types/holdings.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const MONTHS_DIR = resolve(ROOT, "data/months");
const OUT_DIR = resolve(ROOT, "public/data");
const DETAIL_DIR = resolve(OUT_DIR, "stocks");
const FUNDS_DIR = resolve(OUT_DIR, "funds");
const SCHEMA = 1;

/** URL-/file-safe key for a fund or house detail file. Mirrored in src/lib/funds.ts. */
const fundFileKey = (kind: "fund" | "house", id: string): string =>
  `${kind}__${id}`.replace(/[^A-Za-z0-9._-]/g, "_");

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

// --- Part C: passive / index / ETF funds — EXCLUDED from every aggregate (#2) ---
// Index funds and ETFs mechanically mirror whatever their benchmark holds, so
// their "buying" is not an active-conviction signal — including them just adds
// noise (every large cap looks universally owned, every rebalance looks like a
// flow). We drop them from all derived numbers: stock totals, month-over-month
// flows, fund counts, sector flows and trendsetters. A house still counts as
// "present" for coverage if it disclosed anything (active OR passive), so the
// "X of Y houses" headline is unaffected.
//
// Calibrated against the live fund list: this catches the ~470 index/ETF schemes
// with no false positives. It deliberately does NOT match actively-managed
// "... Active Momentum" funds, nor "... Liquid" (money-market/debt) funds.
const PASSIVE_NAME = /\b(ETF|EXCHANGE[\s-]?TRADED|INDEX|BEES|NIFTY|SENSEX|BSE\s*\d)\b/i;
function isPassiveFund(name: string): boolean {
  return PASSIVE_NAME.test(name);
}

// --- Part D: stock listing dates (ISIN → "YYYY-MM-DD"), produced by scripts/listings.ts ---
// Used to tell a genuine "old company, newly bought" from a brand-new IPO in the
// "Brand-new entries" idea list (#1). Missing = age unknown (never guessed).
const IPO_RECENT_MONTHS = 12; // listed within a year of the latest data month ⇒ "recent IPO"
function loadListings(): Record<string, string> {
  const p = resolve(ROOT, "data/listings.json");
  if (!existsSync(p)) return {};
  try {
    return (JSON.parse(readFileSync(p, "utf8")) as { listings?: Record<string, string> }).listings ?? {};
  } catch {
    return {};
  }
}
/** Whole months between a "YYYY-MM-DD" listing date and a "YYYY-MM" reference month; null if unparseable. */
function monthsSince(listedOn: string | undefined, refMonth: string): number | null {
  if (!listedOn) return null;
  const m = listedOn.match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  const [ry, rm] = refMonth.split("-").map(Number);
  return (ry - Number(m[1])) * 12 + (rm - Number(m[2]));
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
  funds: Map<string, MonthFund>; // fundId → fund (ACTIVE funds only; passive excluded)
  houses: Set<string>; // amcSlugs present (have data)
  holders: Map<string, string[]>; // isin → fundIds holding it
  housesTotal: number; // houses AdvisorKhoj listed (attempted)
  passive: number; // index/ETF schemes dropped this month (for logging)
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

/** Normalise a scheme name to a stable key fragment (for de-collapsing, below). */
const normName = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

function indexMonth(data: MonthData): MonthIndex {
  const funds = new Map<string, MonthFund>();
  const houses = new Set<string>();
  const holders = new Map<string, string[]>();

  // A few AdvisorKhoj months collapsed several DISTINCT schemes onto one fundId
  // (the scraper read the wrong cell as the scheme code, e.g. every Motilal Oswal
  // scheme became ":Back to Index"). Where one fundId carries multiple distinct
  // scheme names, split them back apart by name so per-fund views and fund COUNTS
  // stay honest. Stock/house TOTALS are unaffected — a house's schemes sum the
  // same either way. The fundId PREFIX (the AMC slug) is preserved, and the newest
  // month (AMFIBEAS) has no collisions, so fund URLs/identities are unchanged there.
  const namesById = new Map<string, Set<string>>();
  for (const f of data.funds) {
    let set = namesById.get(f.fundId);
    if (!set) namesById.set(f.fundId, (set = new Set()));
    set.add(f.fundName);
  }
  const keyOf = (f: FundHoldings): string =>
    (namesById.get(f.fundId)?.size ?? 0) > 1 ? `${f.fundId}::${normName(f.fundName)}` : f.fundId;

  let passive = 0;
  for (const f of data.funds) {
    const amcSlug = amcSlugOf(f.fundId);
    houses.add(amcSlug); // a house counts as present if it disclosed anything (active OR passive)
    if (isPassiveFund(f.fundName)) { passive++; continue; } // #2: index/ETF add no active signal — drop
    const fundKey = keyOf(f);
    let mf = funds.get(fundKey);
    if (!mf) {
      mf = { amcSlug, fundName: f.fundName, fundHouse: f.fundHouse, holds: new Map() };
      funds.set(fundKey, mf);
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
        list.push(fundKey);
      }
    }
  }
  const housesTotal = data.coverage?.length ?? houses.size;
  return { funds, houses, holders, housesTotal, passive };
}

interface Flow {
  net: number | null; // coverage-aware net share change
  buying: number | null; // funds that added (incl. new positions)
  selling: number | null; // funds that trimmed (incl. exits)
  /** Set when the month's share jump is a bonus/split, not fund buying: the rough ratio (~2 for a 1:1 bonus). */
  action?: number;
}

/**
 * Coverage-aware flow for one stock between month t-1 and t. Only funds whose
 * house is present in BOTH months count. All null when there is no prior month
 * or nothing comparable is known.
 *
 * Bonus/split guard (#3): if the continuing holders' shares jumped sharply while
 * their combined market value stayed ~flat, the change is a corporate action, not
 * a trade. We report the whole month as unknown (net/buying/selling = null) and
 * flag the ratio — so a split never masquerades as buying in the totals, the
 * buy/sell streaks, the sector flows or the Overview.
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
  // For split detection: sum shares & value of funds that held in BOTH months.
  let sPrev = 0, sCur = 0, vPrev = 0, vCur = 0, bothHeld = 0;
  for (const id of fundIds) {
    // House is comparable (present both months), so a fund not holding it = a real 0.
    const hp = prev.funds.get(id)?.holds.get(isin);
    const hc = cur.funds.get(id)?.holds.get(isin);
    const sp = hp ? hp.shares : 0;
    const sc = hc ? hc.shares : 0;
    if (sp == null || sc == null) continue; // undisclosed shares → unknown
    const d = sc - sp;
    net += d;
    known = true;
    if (d > 0) buying++;
    else if (d < 0) selling++;
    if (sp > 0 && sc > 0) {
      sPrev += sp; sCur += sc; bothHeld++;
      if (hp?.value != null) vPrev += hp.value;
      if (hc?.value != null) vCur += hc.value;
    }
  }
  if (!known) return { net: null, buying: null, selling: null };

  // Split/bonus: shares up ≥1.7× while combined market value held ~flat (a split
  // scales price down as it scales shares up, so value barely moves). Real buying
  // would lift value too, so this won't fire on genuine flow.
  if (bothHeld > 0 && sPrev > 0 && sCur / sPrev >= 1.7 && vPrev > 0 && vCur > 0) {
    const vr = vCur / vPrev;
    if (vr >= 0.7 && vr <= 1.4) {
      return { net: null, buying: null, selling: null, action: Math.round((sCur / sPrev) * 10) / 10 };
    }
  }
  return { net, buying, selling };
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
  const caps = loadCaps();
  const listings = loadListings();
  let capMatched = 0;
  let listedMatched = 0;

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
  // isin → months where a bonus/split was detected (so per-fund change is nulled there too).
  const splitMonths = new Map<string, Set<number>>();

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

    // Listing age (#1): recent-IPO vs long-established, or unknown when unlisted on NSE.
    const listedOn = listings[isin] ?? null;
    if (listedOn) listedMatched++;
    const ageMonths = monthsSince(listings[isin], monthKeys[L]);
    const recentIpo = ageMonths == null ? undefined : ageMonths < IPO_RECENT_MONTHS;

    const totalShares: (number | null)[] = [];
    const totalValueInr: (number | null)[] = [];
    const fundCount: (number | null)[] = [];
    const nsc: (number | null)[] = [];
    const splitSet = new Set<number>(); // months this stock had a bonus/split
    const corporateActions: { index: number; ratio: number }[] = [];
    let flow: Flow = { net: null, buying: null, selling: null }; // latest-month flow (set in the loop)

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
      if (t === 0) {
        nsc.push(null);
      } else {
        const f = flowDetail(idx[t - 1], idx[t], isin);
        nsc.push(f.net);
        if (f.action) { splitSet.add(t); corporateActions.push({ index: t, ratio: f.action }); }
        if (t === L) flow = f;
      }
    }
    if (splitSet.size) splitMonths.set(isin, splitSet);

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

    // This month's flow detail (funds adding vs trimming) was captured as `flow`
    // in the loop above — already coverage-aware and split-neutralised.

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
      listedOn, recentIpo,
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
          // A bonus/split month's jump is a corporate action, not a trade → change unknown.
          change.push(splitSet.has(t) ? null : s - sp);
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
      listedOn, corporateActions: corporateActions.length ? corporateActions : undefined,
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

  // ---- Per-fund & per-house details (Step 9) ----
  // The flip side of the stock page. Coverage-aware: a holding's monthly change
  // is only computed when the fund/house is present in BOTH months.
  const fundIndex: FundIndexEntry[] = [];
  const fundDetails: FundDetail[] = [];

  const buildEntity = (
    kind: "fund" | "house",
    id: string,
    amcSlug: string,
    name: string,
    house: string,
  ): FundDetail => {
    // Per-month aggregated holdings for this entity (a fund = one scheme; a house
    // = the sum across all its schemes), plus whether it was present each month.
    const perMonth: Map<string, { shares: number | null; value: number | null; percent: number | null }>[] = [];
    const present: boolean[] = [];
    for (let t = 0; t < T; t++) {
      const m = new Map<string, { shares: number | null; value: number | null; percent: number | null }>();
      let p: boolean;
      if (kind === "fund") {
        p = idx[t].funds.has(id);
        const mf = idx[t].funds.get(id);
        if (mf) for (const [isin, h] of mf.holds) m.set(isin, { shares: h.shares, value: h.value, percent: h.percent });
      } else {
        p = idx[t].houses.has(amcSlug);
        for (const mf of idx[t].funds.values()) {
          if (mf.amcSlug !== amcSlug) continue;
          for (const [isin, h] of mf.holds) {
            const cur = m.get(isin) ?? { shares: null, value: null, percent: null };
            if (h.shares != null) cur.shares = (cur.shares ?? 0) + h.shares;
            if (h.value != null) cur.value = (cur.value ?? 0) + h.value;
            m.set(isin, cur);
          }
        }
      }
      present.push(p);
      perMonth.push(m);
    }

    // For a house, % of portfolio = a holding's value share of the house's equity.
    const houseTotal: number[] = perMonth.map((m) => {
      let s = 0;
      for (const v of m.values()) if (v.value != null) s += v.value;
      return s;
    });

    const isins = new Set<string>();
    for (const m of perMonth) for (const k of m.keys()) isins.add(k);

    const holdings: FundHoldingTrend[] = [];
    for (const isin of isins) {
      const shares: (number | null)[] = [];
      const percent: (number | null)[] = [];
      const valueInr: (number | null)[] = [];
      const change: (number | null)[] = [];
      const event: (("new" | "exit") | null)[] = [];
      for (let t = 0; t < T; t++) {
        const held = perMonth[t].get(isin);
        let s: number | null, v: number | null, pc: number | null;
        if (!present[t]) { s = null; v = null; pc = null; }
        else if (!held) { s = 0; v = 0; pc = 0; }
        else {
          s = held.shares; v = held.value;
          pc = kind === "fund"
            ? held.percent
            : held.value != null && houseTotal[t] > 0 ? round4((held.value / houseTotal[t]) * 100) : null;
        }
        shares.push(s); valueInr.push(v); percent.push(pc);
        const sp = t === 0 ? null : shares[t - 1];
        if (t === 0 || !present[t] || !present[t - 1] || s == null || sp == null) {
          change.push(null); event.push(null);
        } else {
          // Bonus/split month → the jump isn't a trade (#3).
          change.push(splitMonths.get(isin)?.has(t) ? null : s - sp);
          event.push(sp === 0 && s > 0 ? "new" : sp > 0 && s === 0 ? "exit" : null);
        }
      }
      holdings.push({
        isin,
        name: nameOf.get(isin) ?? isin,
        sector: sectorOf.get(isin) ?? null,
        macroSector: macroOf(sectorOf.get(isin) ?? null),
        marketCap: (caps[isin] ?? null) as MarketCap | null,
        shares, percent, valueInr, change, event,
      });
    }
    // Biggest current positions first (nulls last).
    holdings.sort((a, b) => (b.shares[L] ?? -1) - (a.shares[L] ?? -1));

    const alloc = new Map<string, number>();
    for (const h of holdings) {
      const v = h.valueInr[L];
      if (v != null && v > 0) {
        const key = h.macroSector ?? "Unknown";
        alloc.set(key, (alloc.get(key) ?? 0) + v);
      }
    }
    const sectorAllocation = [...alloc.entries()]
      .map(([sector, valueInr]) => ({ sector, valueInr }))
      .sort((a, b) => b.valueInr - a.valueInr);

    return {
      schemaVersion: SCHEMA, kind, id, name, house, amcSlug,
      months: monthKeys, monthLabels: labels, present,
      comparableLatest: present[L] && L >= 1 && present[L - 1],
      holdings, sectorAllocation,
    };
  };

  // Build a detail for every fund AND every house present in the latest month.
  const entities: { kind: "fund" | "house"; id: string; amcSlug: string; name: string; house: string }[] = [];
  for (const [fundId, mf] of idx[L].funds) {
    entities.push({ kind: "fund", id: fundId, amcSlug: mf.amcSlug, name: mf.fundName, house: mf.fundHouse });
  }
  for (const slug of idx[L].houses) {
    const nm = houseName.get(slug) ?? slug;
    entities.push({ kind: "house", id: slug, amcSlug: slug, name: nm, house: nm });
  }
  for (const e of entities) {
    const detail = buildEntity(e.kind, e.id, e.amcSlug, e.name, e.house);
    fundDetails.push(detail);
    let stockCount = 0;
    let valueInr: number | null = null;
    for (const h of detail.holdings) {
      const s = h.shares[L], v = h.valueInr[L];
      if ((s != null && s > 0) || (v != null && v > 0)) stockCount++;
      if (v != null) valueInr = (valueInr ?? 0) + v;
    }
    fundIndex.push({
      kind: e.kind, id: e.id, file: fundFileKey(e.kind, e.id),
      name: e.name, house: e.house, stockCount, valueInr,
    });
  }
  // Houses first, then funds; each alphabetical — a tidy default for the picker.
  fundIndex.sort((a, b) =>
    a.kind !== b.kind ? (a.kind === "house" ? -1 : 1) : a.name.localeCompare(b.name));

  // ---- Trendsetter funds: who tends to buy a stock BEFORE the crowd ----
  // For each stock, at each month a fund newly enters it (from a small, uncrowded
  // base), check whether many more funds pile in over the next 1–3 months —
  // counting ONLY funds whose house was already present at entry, so the big
  // AMFIBEAS onboarding month can't masquerade as "the crowd following".
  const tsScore = new Map<string, number>();
  const tsEval = new Map<string, number>();
  const tsEx = new Map<string, string[]>();
  for (const isin of isins) {
    for (let t = 1; t <= L - 1; t++) {
      const holdersAtT = idx[t].holders.get(isin) ?? [];
      const baseCount = holdersAtT.length;
      if (baseCount === 0 || baseCount > 20) continue; // must be an early, uncrowded name
      const housesAtT = idx[t].houses;
      let maxLater = baseCount;
      const kmax = Math.min(3, L - t);
      for (let k = 1; k <= kmax; k++) {
        let later = 0;
        for (const id of idx[t + k].holders.get(isin) ?? []) if (housesAtT.has(amcSlugOf(id))) later++;
        if (later > maxLater) maxLater = later;
      }
      const followed = maxLater - baseCount >= 5; // crowd grew ≥5 funds (stable universe)
      const prevSet = new Set(idx[t - 1].holders.get(isin) ?? []);
      for (const id of holdersAtT) {
        if (!idx[t - 1].houses.has(amcSlugOf(id))) continue; // house comparable at entry
        if (prevSet.has(id)) continue; // already held → not a new entry
        if (!idx[L].funds.has(id)) continue; // must still exist (has a detail page)
        tsEval.set(id, (tsEval.get(id) ?? 0) + 1);
        if (followed) {
          tsScore.set(id, (tsScore.get(id) ?? 0) + 1);
          const ex = tsEx.get(id) ?? [];
          if (ex.length < 3) { ex.push(nameOf.get(isin) ?? isin); tsEx.set(id, ex); }
        }
      }
    }
  }
  const trendsetters: TrendsetterEntry[] = [...tsScore.entries()]
    // ≥2 correct early calls, and a real hit rate (≥15%) so mechanical index funds
    // — early on everything but rarely by conviction — don't dominate.
    .filter(([id, sc]) => sc >= 2 && sc / (tsEval.get(id) ?? sc) >= 0.15)
    .map(([id, sc]) => {
      const mf = idx[L].funds.get(id)!;
      return { file: fundFileKey("fund", id), name: mf.fundName, house: mf.fundHouse, score: sc, evaluated: tsEval.get(id) ?? sc, examples: tsEx.get(id) ?? [] };
    })
    .sort((a, b) => b.score - a.score || b.score / b.evaluated - a.score / a.evaluated)
    .slice(0, 25);

  // ---- write outputs ----
  mkdirSync(OUT_DIR, { recursive: true });
  rmSync(DETAIL_DIR, { recursive: true, force: true });
  mkdirSync(DETAIL_DIR, { recursive: true });
  rmSync(FUNDS_DIR, { recursive: true, force: true });
  mkdirSync(FUNDS_DIR, { recursive: true });

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

  // ---- Conviction consensus: what the BIGGEST active funds commonly own ----
  // The flip side of churn. Take the top-N active funds by latest equity value,
  // then rank stocks by how many of them hold it this month — and how many are
  // still net-ADDING it over the last few months (sustained conviction, not a
  // one-month dip in and out). Coverage-aware: "adding" only counts a fund that
  // was present at both ends of the window.
  const CONSENSUS_N = 20;
  const CONSENSUS_LOOKBACK = Math.min(3, L);
  const topFundIds = fundIndex
    .filter((e) => e.kind === "fund")
    .sort((a, b) => (b.valueInr ?? 0) - (a.valueInr ?? 0))
    .slice(0, CONSENSUS_N)
    .map((e) => e.id);
  const heldByTop = new Map<string, number>();
  const addingTop = new Map<string, number>();
  for (const fid of topFundIds) {
    const mfL = idx[L].funds.get(fid);
    if (!mfL) continue;
    const past = CONSENSUS_LOOKBACK >= 1 ? idx[L - CONSENSUS_LOOKBACK].funds.get(fid) : undefined;
    const pastComparable = CONSENSUS_LOOKBACK >= 1 && idx[L - CONSENSUS_LOOKBACK].funds.has(fid);
    for (const [isin, h] of mfL.holds) {
      if (h.shares == null || h.shares <= 0) continue; // must actually hold it now
      heldByTop.set(isin, (heldByTop.get(isin) ?? 0) + 1);
      if (pastComparable) {
        const pastShares = past?.holds.get(isin)?.shares ?? 0; // present then, not holding = 0
        if (pastShares != null && h.shares > pastShares) addingTop.set(isin, (addingTop.get(isin) ?? 0) + 1);
      }
    }
  }
  const consensus: ConsensusEntry[] = [...heldByTop.entries()]
    .map(([isin, held]) => ({
      isin,
      name: nameOf.get(isin) ?? isin,
      sector: macroOf(sectorOf.get(isin) ?? null),
      heldBy: held,
      adding: addingTop.get(isin) ?? 0,
    }))
    .sort((a, b) => b.heldBy - a.heldBy || b.adding - a.adding || a.name.localeCompare(b.name))
    .slice(0, 15);

  const latestMeta = summary.months[summary.months.length - 1];
  const fundsIndexOut: FundsIndex = {
    schemaVersion: SCHEMA, month: latestMeta.month, monthLabel: latestMeta.label, entries: fundIndex, trendsetters,
    consensus, consensusOf: topFundIds.length,
  };
  writeFileSync(resolve(OUT_DIR, "funds.json"), JSON.stringify(fundsIndexOut)); // minified — machine-loaded
  for (const f of fundDetails) {
    writeFileSync(resolve(FUNDS_DIR, `${fundFileKey(f.kind, f.id)}.json`), JSON.stringify(f)); // minified
  }

  console.log(
    `Wrote summary.json, stocks.json (${stocks.length} stocks), sectors.json ` +
      `(${sectorsOut.sectors.length} macro sectors), ${details.length} per-stock detail files, ` +
      `funds.json (${fundIndex.length} funds+houses), and ${fundDetails.length} per-fund detail files.`,
  );
  console.log(
    `Market cap: ${capMatched}/${stocks.length} stocks tagged (${((100 * capMatched) / stocks.length).toFixed(1)}%)` +
      (Object.keys(caps).length === 0 ? " — no data/marketcap.json (run `npm run marketcap`)" : ""),
  );
  const recentCount = stocks.filter((s) => s.recentIpo === true).length;
  console.log(
    `Listing dates: ${listedMatched}/${stocks.length} stocks matched (${((100 * listedMatched) / stocks.length).toFixed(1)}%)` +
      `, ${recentCount} tagged recent-IPO (< ${IPO_RECENT_MONTHS} mo)` +
      (Object.keys(listings).length === 0 ? " — no data/listings.json (run `npm run listings`)" : ""),
  );
  const totalPassive = idx.reduce((a, mi) => a + mi.passive, 0);
  console.log(`Passive/index/ETF schemes excluded (#2): ${totalPassive} across ${T} months (${idx[L].passive} in the latest).`);
  for (let t = 0; t < T; t++) {
    const m = summary.months[t];
    console.log(`  ${m.label}: ${m.housesPresent}/${m.housesTotal} houses, ${m.fundCount} active funds (${idx[t].passive} passive excl.), ${m.stockCount} stocks`);
  }
}

main();
