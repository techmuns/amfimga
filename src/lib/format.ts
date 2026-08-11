/**
 * Display formatting helpers that encode Rules 2 and 3.
 *
 * Keep these the ONLY place values get turned into user-facing strings, so the
 * "unknown → dash, never a fake 0" and "store rupees, format on display" rules
 * are applied consistently everywhere.
 */

/** The em dash shown wherever a value is unknown (Rule 2). Never show 0 or a guess. */
export const DASH = "—";

/**
 * Format plain whole rupees (Rule 3) into a compact Indian string using
 * lakh/crore grouping, e.g. 152340000 → "₹15.23 Cr". The stored value stays in
 * plain rupees; this is display only. Returns {@link DASH} for null/unknown.
 */
export function formatInr(rupees: number | null | undefined): string {
  if (rupees == null || !Number.isFinite(rupees)) return DASH;
  const sign = rupees < 0 ? "-" : "";
  const abs = Math.abs(rupees);
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)} L`;
  return `${sign}₹${abs.toLocaleString("en-IN")}`;
}

/** Format a percentage, e.g. 8.42 → "8.42%". Returns {@link DASH} for null/unknown. */
export function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  return `${value.toFixed(2)}%`;
}

/** Format a whole-number count with grouping, e.g. 1200000 → "12,00,000". Dash if unknown. */
export function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  return value.toLocaleString("en-IN");
}

/** Compact whole-number count for axis labels, e.g. 51405000 → "5.1 Cr". Dash if unknown. */
export function formatCountShort(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(1)} Cr`;
  if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(1)} L`;
  return `${sign}${abs.toLocaleString("en-IN")}`;
}

/**
 * Format a signed share-change, e.g. 1200000 → "+12,00,000", -34500 → "−34,500".
 * Returns {@link DASH} for null/unknown — a coverage gap is never shown as 0.
 */
export function formatSignedCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toLocaleString("en-IN")}`;
}
