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
  /** Stable slug identifying the fund across months, e.g. "example-bluechip-fund". */
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

export interface StockRow {
  isin: string;
  name: string;
  sector: string | null;
  /** Large/mid/small — left null until the AMFI list is added in a later step. */
  marketCap: null;
  /** Per-month total shares across all present funds. `null` = not held / unknown. */
  totalShares: (number | null)[];
  /** Per-month total market value in plain rupees. `null` = not held / unknown. */
  totalValueInr: (number | null)[];
  /** Per-month count of funds holding it. `null` = not held that month. */
  fundCount: (number | null)[];
  /** Per-month net share change vs the previous month. `null` = no prior month or a coverage gap. */
  netShareChange: (number | null)[];
}

/** `public/data/stocks/<ISIN>.json` — per-stock detail, loaded on demand. */
export interface StockDetail {
  schemaVersion: number;
  isin: string;
  name: string;
  sector: string | null;
  marketCap: null;
  months: string[];
  monthLabels: string[];
  totalShares: (number | null)[];
  totalValueInr: (number | null)[];
  fundCount: (number | null)[];
  netShareChange: (number | null)[];
  /** The funds that hold (or held) this stock, with each fund's own trend. */
  funds: FundTrend[];
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
