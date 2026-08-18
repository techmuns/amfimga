/**
 * AIF / PMS early signals — a SEPARATE, complementary pipeline to the mutual-fund
 * dashboard. Reads the per-provider fact-sheet files in `data/aif-pms/*.json` and
 * writes the small `public/data/aif-pms.json` the browser loads. Run with
 * `npm run derive:aifpms` (after `npm run derive`, which produces stocks.json).
 *
 * WHY IT'S DIFFERENT FROM THE MF PIPELINE:
 *  - AIF/PMS fact sheets are PARTIAL (usually top-10 only). So this is ENTRY-ONLY:
 *    a name appearing is a signal; a name leaving a top-10 is NOT a sell (it may
 *    just have slipped below #10). We never compute a sell, exit, or net change.
 *  - It never touches the MF aggregates. It only CROSS-REFERENCES the MF data
 *    (public/data/stocks.json) to flag stocks an AIF/PMS holds that NO mutual fund
 *    holds yet — the strongest "ahead of the crowd" early signal.
 *  - ISIN is the join key (Rule 4); rows without a real INE ISIN are dropped.
 *
 * If no provider files exist (only the _template), nothing is written and the UI
 * section stays dormant — no fake/empty data on the dashboard (Rule 2/5).
 */

import { readFileSync, readdirSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AifPmsEntry, AifPmsSummary, MarketCap, StocksSummary } from "../src/types/holdings.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const IN_DIR = resolve(ROOT, "data/aif-pms");
const OUT = resolve(ROOT, "public/data/aif-pms.json");
const SCHEMA = 1;

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthLabel = (m: string): string => { const [y, mm] = m.split("-"); return `${MONTH_NAMES[Number(mm) - 1]} ${y}`; };

interface RawHolding { isin?: string; name?: string; percent?: number; value?: number; shares?: number }
interface Provider {
  slug: string;
  name: string;
  type: "AIF" | "PMS";
  disclosure: "partial" | "full";
  /** month → set of ISINs disclosed that month (validated). */
  months: Map<string, Map<string, string>>; // month → (isin → label)
}

function loadProviders(): Provider[] {
  if (!existsSync(IN_DIR)) return [];
  const out: Provider[] = [];
  for (const file of readdirSync(IN_DIR)) {
    if (!file.endsWith(".json") || file.startsWith("_")) continue; // skip the _template
    const slug = file.replace(/\.json$/, "");
    let raw: { name?: string; type?: string; disclosure?: string; months?: Record<string, RawHolding[]> };
    try {
      raw = JSON.parse(readFileSync(resolve(IN_DIR, file), "utf8"));
    } catch {
      console.warn(`  skipped ${file}: not valid JSON`);
      continue;
    }
    const type = raw.type === "AIF" ? "AIF" : "PMS";
    const months = new Map<string, Map<string, string>>();
    for (const [month, rows] of Object.entries(raw.months ?? {})) {
      if (!/^\d{4}-\d{2}$/.test(month) || !Array.isArray(rows)) continue;
      const held = new Map<string, string>();
      for (const r of rows) {
        const isin = String(r.isin ?? "").trim().toUpperCase();
        if (!/^INE[A-Z0-9]{9}$/.test(isin)) continue; // real equity ISINs only (Rule 4)
        if (!held.has(isin)) held.set(isin, String(r.name ?? "").trim());
      }
      if (held.size > 0) months.set(month, held);
    }
    if (months.size === 0) { console.warn(`  skipped ${file}: no valid holdings`); continue; }
    out.push({ slug, name: raw.name?.trim() || slug, type, disclosure: raw.disclosure === "full" ? "full" : "partial", months });
  }
  return out;
}

/** MF cross-reference: ISIN → { name, sector, cap, mfFundCount } from the already-derived stocks.json. */
function loadMfIndex(): Map<string, { name: string; sector: string | null; cap: MarketCap | null; mfFundCount: number | null }> {
  const p = resolve(ROOT, "public/data/stocks.json");
  const idx = new Map<string, { name: string; sector: string | null; cap: MarketCap | null; mfFundCount: number | null }>();
  if (!existsSync(p)) return idx;
  const data = JSON.parse(readFileSync(p, "utf8")) as StocksSummary;
  const last = data.months.length - 1;
  for (const s of data.stocks) {
    idx.set(s.isin, { name: s.name, sector: s.macroSector, cap: s.marketCap, mfFundCount: s.fundCount[last] ?? null });
  }
  return idx;
}
function loadNames(): Record<string, string> {
  const p = resolve(ROOT, "data/listings.json");
  if (!existsSync(p)) return {};
  try { return (JSON.parse(readFileSync(p, "utf8")) as { names?: Record<string, string> }).names ?? {}; } catch { return {}; }
}
function loadCaps(): Record<string, MarketCap> {
  const p = resolve(ROOT, "data/marketcap.json");
  if (!existsSync(p)) return {};
  try { return (JSON.parse(readFileSync(p, "utf8")) as { caps?: Record<string, MarketCap> }).caps ?? {}; } catch { return {}; }
}

function main(): void {
  const providers = loadProviders();
  if (providers.length === 0) {
    // Nothing loaded — leave no stale served file, so the UI section stays dormant.
    if (existsSync(OUT)) rmSync(OUT);
    console.log("No AIF/PMS provider files in data/aif-pms/ (only the _template). Nothing written — the dashboard section stays hidden until fact sheets are added.");
    return;
  }

  const mf = loadMfIndex();
  const names = loadNames();
  const caps = loadCaps();

  // Global latest month, and per-provider latest / prior disclosures.
  const allMonths = new Set<string>();
  for (const p of providers) for (const m of p.months.keys()) allMonths.add(m);
  const M = [...allMonths].sort().at(-1)!;

  // isin → { heldBy[], newlyDisclosed[], label }
  const held = new Map<string, { name: string; type: "AIF" | "PMS" }[]>();
  const fresh = new Map<string, { name: string; type: "AIF" | "PMS" }[]>();
  const labelOf = new Map<string, string>();

  for (const p of providers) {
    const sortedMonths = [...p.months.keys()].sort();
    const pLatest = sortedMonths.at(-1)!;
    const pPrev = sortedMonths.at(-2);
    const latestHold = p.months.get(pLatest)!;
    const prevHold = pPrev ? p.months.get(pPrev)! : null;
    for (const [isin, label] of latestHold) {
      let hb = held.get(isin); if (!hb) held.set(isin, (hb = []));
      hb.push({ name: p.name, type: p.type });
      if (label && !labelOf.has(isin)) labelOf.set(isin, label);
      // Newly disclosed = in this provider's latest fact sheet but not its prior one.
      if (prevHold && !prevHold.has(isin)) {
        let fr = fresh.get(isin); if (!fr) fresh.set(isin, (fr = []));
        fr.push({ name: p.name, type: p.type });
      }
    }
  }

  const entries: AifPmsEntry[] = [...held.entries()].map(([isin, heldBy]) => {
    const m = mf.get(isin);
    const name = m?.name || names[isin] || labelOf.get(isin) || isin;
    const mfFundCount = m?.mfFundCount ?? null;
    return {
      isin,
      name,
      sector: m?.sector ?? null,
      marketCap: m?.cap ?? caps[isin] ?? null,
      heldBy,
      newlyDisclosed: fresh.get(isin) ?? [],
      aheadOfMutualFunds: mfFundCount == null || mfFundCount === 0,
      mfFundCount,
    };
  });

  // Early signals first: newly-disclosed on top, then names no mutual fund holds, then breadth.
  entries.sort((a, b) =>
    b.newlyDisclosed.length - a.newlyDisclosed.length ||
    Number(b.aheadOfMutualFunds) - Number(a.aheadOfMutualFunds) ||
    b.heldBy.length - a.heldBy.length ||
    a.name.localeCompare(b.name));

  const summary: AifPmsSummary = {
    schemaVersion: SCHEMA,
    generatedAt: new Date().toISOString(),
    month: M,
    monthLabel: monthLabel(M),
    providers: providers.map((p) => ({ slug: p.slug, name: p.name, type: p.type })),
    entries,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(summary));
  const ahead = entries.filter((e) => e.aheadOfMutualFunds).length;
  const newly = entries.filter((e) => e.newlyDisclosed.length > 0).length;
  console.log(`Wrote ${OUT}: ${providers.length} providers, ${entries.length} disclosed stocks (${newly} newly disclosed, ${ahead} ahead of mutual funds). Latest: ${summary.monthLabel}.`);
}

main();
