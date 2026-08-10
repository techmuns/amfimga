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
