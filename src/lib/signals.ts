/**
 * Derived signals computed at display time from the small served summaries.
 *
 * These are PRESENTATION-only readings of data we already ship (shares, value,
 * fund counts, net change per month) — no new ingestion, no change to the stored
 * numbers. Keeping the maths here means every page reads a signal the same way
 * (no duplicated, drifting logic).
 *
 * Coverage-awareness still holds: these operate on already coverage-aware arrays
 * (a `null` month is unknown and breaks a streak — never treated as a zero).
 */

import type { StockRow } from "../types/holdings";

/**
 * Implied price per share = market value ÷ shares, month by month. This is the
 * price the funds' own disclosures imply — no external price feed. `null` where
 * either side is missing or shares are 0 (Rule 2). All ~hundreds of funds report
 * the same month-end price, so the aggregate is stable.
 */
export function impliedPrice(valueInr: (number | null)[], shares: (number | null)[]): (number | null)[] {
  return valueInr.map((v, i) => {
    const s = shares[i];
    if (v == null || s == null || s === 0) return null;
    return v / s;
  });
}

/** Month-over-month difference of a series (for the value/price line's tooltip). `null` where either end is unknown. */
export function monthDiff(series: (number | null)[]): (number | null)[] {
  return series.map((v, i) => (i === 0 || v == null || series[i - 1] == null ? null : v - (series[i - 1] as number)));
}

/**
 * How many of the MOST-RECENT months this stock was net-bought in an unbroken
 * run (coverage-aware). A `null` month (unknown) or a non-positive month ends the
 * run — so a streak means genuine, sustained accumulation, not a coverage artefact.
 */
export function buyStreak(net: (number | null)[]): number {
  let n = 0;
  for (let i = net.length - 1; i >= 0; i--) {
    const v = net[i];
    if (v == null || v <= 0) break;
    n++;
  }
  return n;
}

/**
 * Net share change accumulated over the last `months` entries — the "adding over
 * a period of time" read that cuts through one-month churn. Nulls (coverage gaps /
 * corporate actions) are skipped, so it stays coverage-aware; returns `null` only
 * when no month in the window is known.
 */
export function recentAccumulation(change: (number | null)[], months: number): number | null {
  let sum = 0;
  let known = false;
  for (let i = Math.max(0, change.length - months); i < change.length; i++) {
    const v = change[i];
    if (v != null) { sum += v; known = true; }
  }
  return known ? sum : null;
}

/** The mirror of {@link buyStreak}: unbroken run of most-recent net-selling months. */
export function sellStreak(net: (number | null)[]): number {
  let n = 0;
  for (let i = net.length - 1; i >= 0; i--) {
    const v = net[i];
    if (v == null || v >= 0) break;
    n++;
  }
  return n;
}

/**
 * "Battleground" intensity: funds are split on this stock this month. The score
 * is how many funds are on the SMALLER side (min of buyers/sellers) — a high
 * value means lots of funds buying AND lots selling the same name. `null` if the
 * split isn't known (coverage gap).
 */
export function battleground(r: StockRow): number | null {
  const b = r.fundsBuying, s = r.fundsSelling;
  if (b == null || s == null) return null;
  return Math.min(b, s);
}

/**
 * Detect a likely bonus/split: shares jump up sharply while the implied price
 * falls by close to the inverse ratio (value roughly unchanged). Returns the
 * month index and the rough ratio (e.g. ~2 for a 1:1 bonus), or null. Purely a
 * data-hygiene / corporate-action hint — never alters stored data.
 */
export function detectSplit(
  shares: (number | null)[],
  price: (number | null)[],
): { index: number; ratio: number } | null {
  for (let i = 1; i < shares.length; i++) {
    const s0 = shares[i - 1], s1 = shares[i], p0 = price[i - 1], p1 = price[i];
    if (s0 == null || s1 == null || p0 == null || p1 == null || s0 === 0 || p1 === 0) continue;
    const shareRatio = s1 / s0;
    const priceRatio = p0 / p1;
    // Shares up ≥1.7×, price down by a matching factor (within 20%) → corporate action, not flow.
    if (shareRatio >= 1.7 && Math.abs(shareRatio - priceRatio) / shareRatio < 0.2) {
      return { index: i, ratio: Math.round(shareRatio * 10) / 10 };
    }
  }
  return null;
}

/** Count, per month, how many funds newly ENTERED and how many fully EXITED this stock (coverage-aware). */
export function entryExitCounts(
  funds: { event: (("new" | "exit") | null)[] }[],
  months: number,
): { entered: number[]; exited: number[] } {
  const entered = new Array(months).fill(0);
  const exited = new Array(months).fill(0);
  for (const f of funds) {
    for (let t = 0; t < months; t++) {
      if (f.event[t] === "new") entered[t]++;
      else if (f.event[t] === "exit") exited[t]++;
    }
  }
  return { entered, exited };
}
