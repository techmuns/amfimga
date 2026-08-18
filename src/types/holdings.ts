/**
 * Data shapes for the monthly fund-holdings files.
 *
 * These types are the single source of truth for the on-disk JSON format
 * (see docs/data-format.md). Three rules are encoded directly here:
 *
 *   Rule 2 — Unknown values are `null`, never 0 or a guess. The UI renders a
 *            dash "—" for every `null`.
 *   Rule 3 — Money is stored as plain whole rupees (e.g. 15_23_40_000), never
 *            pre-divided into lakhs/crores. Formatting happens only at display.
 *   Rule 4 — Stocks are identified by ISIN, never by name. `stockName` is for
 *            humans only and must not be used as a key.
 */

/** A single stock position held by one fund in one month. */
export interface Holding {
  /** ISIN — the canonical stock identifier (Rule 4), e.g. "INE040A01034". */
  isin: string;
  /** Human-readable stock name. Display only; inconsistent across sources. */
  stockName: string;
  /** Number of shares held (whole number). `null` when not disclosed. */
  shares: number | null;
  /**
   * Market value of the position in plain Indian rupees — a whole number, NOT
   * lakhs or crores (Rule 3). `null` when not disclosed. Can be negative for
   * short/derivative hedge legs (e.g. in arbitrage schemes).
   */
  marketValueInr: number | null;
  /**
   * Share of the fund's portfolio this position represents. Normally 0–100, but
   * can be slightly negative for short/derivative positions. `null` if unknown.
   */
  portfolioPercent: number | null;
  /** Sector / industry classification. `null` when not disclosed. */
  sector: string | null;
}

/** Everything one fund reported for one month. */
export interface FundHoldings {
  /** Stable id identifying the fund across months, "<AMC-Slug>:<schemeCode>" e.g. "Axis-Mutual-Fund:AXIS500". */
  fundId: string;
  /** Display name of the fund/scheme. */
  fundName: string;
  /** The AMC / fund house that runs the fund. */
  fundHouse: string;
  /** The stock positions held by this fund in this month. */
  holdings: Holding[];
}

/** One month's data file: every fund's holdings for that month. */
export interface MonthData {
  /** The month covered, as "YYYY-MM", e.g. "2026-05". */
  month: string;
  /** Provenance — where the numbers came from. */
  source: string;
  /** The funds reported for this month. */
  funds: FundHoldings[];
  /** ISO timestamp of the ingestion run that produced this file. Optional. */
  generatedAt?: string;
  /**
   * Per-fund-house ingestion outcome for this month, so gaps are recorded
   * honestly rather than shown as zeros (Rule 2). Optional; written by the
   * ingestion script, ignored by the app.
   */
  coverage?: AmcCoverage[];
}

/** Ingestion outcome for one fund house (AMC) in one month. */
export interface AmcCoverage {
  /** Fund house display name, e.g. "Axis Mutual Fund". */
  fundHouse: string;
  /** URL slug used on AdvisorKhoj, e.g. "Axis-Mutual-Fund". */
  amcSlug: string;
  /**
   * - `ok`       — downloaded and parsed this run.
   * - `walled`   — blocked by a bot-wall; needs a scrape.do key (data is a gap).
   * - `failed`   — link found but download/parse failed (data is a gap).
   * - `missing`  — no disclosure link listed for this month (data is a gap).
   * - `retained` — this run couldn't fetch it, so previously-good data was kept.
   */
  status: "ok" | "walled" | "failed" | "missing" | "retained";
  /** Number of schemes parsed (when `ok`/`retained`). */
  schemes: number;
  /** Number of holdings parsed (when `ok`/`retained`). */
  holdings: number;
  /** Short human reason when not `ok`. */
  reason?: string;
}

/** One entry in the index file. */
export interface MonthIndexEntry {
  /** "YYYY-MM". */
  month: string;
  /** Human label, e.g. "May 2026". */
  label: string;
  /** Path to the month's data file, relative to the site root. */
  file: string;
}

/** The index file listing every month available at runtime. */
export interface DataIndex {
  /** Bumped when the on-disk format changes, so future steps can migrate safely. */
  schemaVersion: number;
  /** Available months, sorted oldest → newest. */
  months: MonthIndexEntry[];
}

// ===========================================================================
// Derived summaries (Step 3)
//
// These are the SMALL files the browser actually loads. They are computed from
// the raw month files by `scripts/derive.ts`. The raw months are NOT served.
//
// Coverage-awareness (the core rule): a change is only computed from funds/
// houses present in BOTH months compared. A missing house is a gap → the change
// is `null` (unknown), never treated as a sell-to-zero.
// ===========================================================================

/** `public/data/summary.json` — which months exist and how complete each is. */
export interface SummaryMeta {
  schemaVersion: number;
  generatedAt: string;
  /** The (up to) 8 biggest sectors by value, in colour order. Rest fold to "Other". */
  topSectors: string[];
  months: MonthMeta[];
}

export interface MonthMeta {
  month: string; // "YYYY-MM"
  label: string; // "May 2026"
  /** Fund houses we actually have data for this month. */
  housesPresent: number;
  /** Fund houses AdvisorKhoj listed (attempted) — the "Y" in "X of Y houses". */
  housesTotal: number;
  /** Schemes (funds) present this month. */
  fundCount: number;
  /** Distinct stocks (ISINs) present this month. */
  stockCount: number;
}

/** `public/data/stocks.json` — the compact all-stocks table. Arrays align to `months`. */
export interface StocksSummary {
  schemaVersion: number;
  months: string[];
  monthLabels: string[];
  stocks: StockRow[];
}

/** Market-cap class from AMFI's half-yearly list (Large 1–100, Mid 101–250, Small 251+). */
export type MarketCap = "large" | "mid" | "small";

export interface StockRow {
  isin: string;
  name: string;
  /** Granular industry (NSE), shown on the detail page. */
  sector: string | null;
  /** Broad macro sector (~12) used for colour chips, filters, and the sector chart. */
  macroSector: string | null;
  /** Large/mid/small from AMFI, matched by ISIN. `null` when not confidently matched. */
  marketCap: MarketCap | null;
  /** Per-month total shares across all present funds. `null` = not held / unknown. */
  totalShares: (number | null)[];
  /** Per-month total market value in plain rupees. `null` = not held / unknown. */
  totalValueInr: (number | null)[];
  /** Per-month count of funds holding it. `null` = not held that month. */
  fundCount: (number | null)[];
  /** Per-month net share change vs the previous month. `null` = no prior month or a coverage gap. */
  netShareChange: (number | null)[];
  /**
   * Fund houses whose entering/leaving the data affected the LATEST month's net
   * change for this stock (so the UI can explain it on hover). Present only when
   * it happened. `entered` = house's shares aren't counted as buying; `left` =
   * its previous shares aren't counted.
   */
  coverageAffected?: { house: string; direction: "entered" | "left" }[];

  // --- Latest-month idea signals (coverage-aware) ---
  /** Funds that added shares this month (incl. new positions). `null` if unknown. */
  fundsBuying?: number | null;
  /** Funds that trimmed shares this month (incl. exits). `null` if unknown. */
  fundsSelling?: number | null;
  /** True if brand-new to funds this month (never held before; a real entry, not a house joining). */
  newEntry?: boolean;
  /** The fund holding the biggest slice of the mutual-fund-owned shares this month. */
  topHolder?: { fundName: string; fundHouse: string; sharePct: number };
  /** Stock's exchange listing date "YYYY-MM-DD" (NSE), matched by ISIN. `null` when not on the list (never guessed). */
  listedOn?: string | null;
  /**
   * Was the stock listed recently (a fresh IPO) relative to the latest data month?
   * `true` = confirmed recent, `false` = confirmed long-established, `undefined` =
   * listing date unknown. Lets "Brand-new entries" filter out IPO noise so an
   * old company mutual funds are buying for the FIRST time stands out.
   */
  recentIpo?: boolean;
}

/** `public/data/stocks/<ISIN>.json` — per-stock detail, loaded on demand. */
export interface StockDetail {
  schemaVersion: number;
  isin: string;
  name: string;
  /** Granular industry (shown on this page). */
  sector: string | null;
  /** Broad macro sector (for the sector colour). */
  macroSector: string | null;
  marketCap: MarketCap | null;
  months: string[];
  monthLabels: string[];
  totalShares: (number | null)[];
  totalValueInr: (number | null)[];
  fundCount: (number | null)[];
  netShareChange: (number | null)[];
  /** The funds that hold (or held) this stock, with each fund's own trend. */
  funds: FundTrend[];
  /** Stock's NSE listing date "YYYY-MM-DD", matched by ISIN. `null` when unknown. */
  listedOn?: string | null;
  /**
   * Detected bonus/split months: shares jumped while market value stayed ~flat,
   * so that month's share change is a corporate action, NOT fund buying. `index`
   * is into `months`; `ratio` is the rough multiple (~2 for a 1:1 bonus). Derive
   * neutralises the flow for these months; the UI shows why instead of a fake buy.
   */
  corporateActions?: { index: number; ratio: number }[];
}

export interface FundTrend {
  fundId: string;
  fundName: string;
  fundHouse: string;
  /** Per-month shares. `null` = that fund's house wasn't covered that month (unknown), or shares undisclosed. */
  shares: (number | null)[];
  /** Per-month share change vs previous month. `null` = unknown (coverage gap). */
  change: (number | null)[];
  /** Per-month event: a `new` position or an `exit`, else `null`. */
  event: (("new" | "exit") | null)[];
  /** Per-month share of the fund's own portfolio (0–100). `null` when unknown. */
  percent: (number | null)[];
  /** Per-month: was this fund's HOUSE present in the data? Drives the coverage hover. */
  present: boolean[];
}

/** `public/data/sectors.json` — net share-change summed by sector, per month. */
export interface SectorSummary {
  schemaVersion: number;
  months: string[];
  monthLabels: string[];
  sectors: SectorRow[];
}

export interface SectorRow {
  sector: string;
  /** Per-month net share change across the sector. `null` = no prior month / all unknown. */
  netShareChange: (number | null)[];
}

// ===========================================================================
// Per-fund view (Step 9)
//
// The flip side of the stock page: pick a fund (scheme) or a whole fund house
// and see what IT is doing. Same coverage rules — if the fund/house wasn't in
// the prior month's data, this month's change is `null` (shown as "—"), never a
// fake move.
// ===========================================================================

/** `public/data/funds.json` — the searchable fund/house picker index. */
export interface FundsIndex {
  schemaVersion: number;
  /** Latest month key + label the counts below are for. */
  month: string;
  monthLabel: string;
  entries: FundIndexEntry[];
  /** Funds that tend to buy a stock before the crowd piles in (coverage-guarded lead–lag). */
  trendsetters?: TrendsetterEntry[];
  /** What the biggest active funds commonly own — the high-conviction consensus. */
  consensus?: ConsensusEntry[];
  /** How many top funds `consensus` was computed over (the "N" in "held by X of N"). */
  consensusOf?: number;
}

/** A stock the biggest active funds commonly hold — the flip side of churn: shared conviction. */
export interface ConsensusEntry {
  isin: string;
  name: string;
  /** Macro sector (for the colour dot). */
  sector: string | null;
  /** How many of the top-N funds hold it in the latest month. */
  heldBy: number;
  /** How many of those have net-ADDED it over the last few months (still accumulating, not churning out). */
  adding: number;
}

/** A fund that repeatedly entered a stock early, before many other funds followed. */
export interface TrendsetterEntry {
  /** Fund detail file key (for linking). */
  file: string;
  name: string;
  house: string;
  /** Early entries where the crowd then followed (≥5 more funds, among houses present at entry). */
  score: number;
  /** Early entries assessed (the denominator). */
  evaluated: number;
  /** Up to 3 example stocks it was early on. */
  examples: string[];
}

export interface FundIndexEntry {
  kind: "fund" | "house";
  /** fundId (for a fund) or amcSlug (for a house). */
  id: string;
  /** URL-/file-safe key; the detail lives at `/data/funds/<file>.json`. */
  file: string;
  /** Fund/scheme name, or fund-house name. */
  name: string;
  /** The AMC. For a house entry this equals `name`. */
  house: string;
  /** Distinct equity stocks held in the latest month. */
  stockCount: number;
  /** Total equity market value held in the latest month, plain rupees. `null` if unknown. */
  valueInr: number | null;
}

/** `public/data/funds/<file>.json` — one fund's (or house's) holdings over time. */
export interface FundDetail {
  schemaVersion: number;
  kind: "fund" | "house";
  id: string;
  name: string;
  house: string;
  amcSlug: string;
  months: string[];
  monthLabels: string[];
  /** Per-month: was this fund/house present in the data (drives coverage "—"). */
  present: boolean[];
  /** True if the LATEST month can be compared to the prior one (present in both). */
  comparableLatest: boolean;
  holdings: FundHoldingTrend[];
  /** Latest-month allocation by macro sector (plain rupees), biggest first. */
  sectorAllocation: { sector: string; valueInr: number }[];
}

export interface FundHoldingTrend {
  isin: string;
  name: string;
  /** Granular industry. */
  sector: string | null;
  /** Broad macro sector (for the colour dot + allocation bar). */
  macroSector: string | null;
  marketCap: MarketCap | null;
  /** Per-month shares this fund/house held. `null` = not in data that month (unknown). */
  shares: (number | null)[];
  /** Per-month share of the portfolio (0–100). `null` when unknown. */
  percent: (number | null)[];
  /** Per-month market value held, plain rupees. `null` when unknown. */
  valueInr: (number | null)[];
  /** Per-month share change vs previous month. `null` = coverage gap / not comparable. */
  change: (number | null)[];
  /** Per-month event: a `new` position or an `exit`, else `null`. */
  event: (("new" | "exit") | null)[];
}
