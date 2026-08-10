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
   * lakhs or crores (Rule 3). `null` when not disclosed.
   */
  marketValueInr: number | null;
  /** Share of the fund's portfolio this position represents, 0–100. `null` if unknown. */
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
