/**
 * Parse an AIF/PMS monthly fact sheet into our per-provider holdings file
 * `data/aif-pms/<slug>.json`, which then feeds `npm run derive:aifpms`.
 *
 *   npm run factsheet -- <factsheet.pdf | holdings.txt> --provider "Marcellus CCP" \
 *     --type PMS [--slug marcellus-ccp] [--month 2026-07] [--dry-run]
 *
 * TWO input modes:
 *  - .pdf  — best-effort text extraction. Works for clean, table-style monthly
 *            fact sheets; marketing decks (charts, images) often won't linearise,
 *            so if few holdings match, copy the holdings table into a .txt instead.
 *  - .txt/.csv — the reliable path: paste the holdings table ("Name  9.8%" per
 *            line, or "Name,9.8"). Works no matter how the PDF is built.
 *
 * The hard part isn't reading the file — it's that fact sheets list holdings by
 * NAME + %, while our pipeline keys on ISIN (Rule 4). So we build a name → ISIN
 * resolver from the data we already have (NSE's official names in
 * data/listings.json + the MF stock names in public/data/stocks.json) and match
 * each holding to it. Names that don't resolve are REPORTED, never guessed.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFParse } from "pdf-parse";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT_DIR = resolve(ROOT, "data/aif-pms");

// ---- name → ISIN resolver -------------------------------------------------
const STOPWORDS = /\b(limited|ltd|the|company|co|corporation|corp|india|indian)\b/g;
function norm(s: string): string {
  return s.toLowerCase().replace(/&/g, " and ").replace(/[.,'()\-/]/g, " ").replace(STOPWORDS, " ").replace(/\s+/g, " ").trim();
}
// A few abbreviations fact sheets use that normalisation alone won't bridge.
const ALIASES: Record<string, string> = {
  "l and t": "larsen and toubro", "lt": "larsen and toubro",
  "tcs": "tata consultancy services", "sbi": "state bank of",
  "m and m": "mahindra and mahindra", "hul": "hindustan unilever",
  "hdfc": "hdfc bank", "bajaj fin": "bajaj finance", "l and t finance": "l and t finance",
  "kotak bank": "kotak mahindra bank", "icici": "icici bank",
};

function buildResolver(): (raw: string) => string | null {
  const byName = new Map<string, string>();     // exact normalised name → ISIN
  const byTokens: { tokens: Set<string>; isin: string }[] = [];
  const add = (name: string, isin: string) => {
    const n = norm(name);
    if (!n) return;
    if (!byName.has(n)) byName.set(n, isin);
    byTokens.push({ tokens: new Set(n.split(" ")), isin });
  };
  // NSE official names first (cleanest), then MF stock names for anything missing.
  const lp = resolve(ROOT, "data/listings.json");
  if (existsSync(lp)) {
    const names = (JSON.parse(readFileSync(lp, "utf8")) as { names?: Record<string, string> }).names ?? {};
    for (const [isin, name] of Object.entries(names)) add(name, isin);
  }
  const sp = resolve(ROOT, "public/data/stocks.json");
  if (existsSync(sp)) {
    const stocks = (JSON.parse(readFileSync(sp, "utf8")) as { stocks: { isin: string; name: string }[] }).stocks;
    for (const s of stocks) add(s.name, s.isin);
  }

  return (raw: string): string | null => {
    let n = norm(raw);
    if (!n) return null;
    if (byName.has(n)) return byName.get(n)!;
    if (ALIASES[n]) { n = norm(ALIASES[n]); if (byName.has(n)) return byName.get(n)!; }
    // Token-subset: a candidate whose name contains ALL the query's tokens, uniquely.
    const q = new Set(n.split(" ").filter(Boolean));
    if (q.size === 0) return null;
    const hits = new Set<string>();
    let firstIsin: string | null = null;
    for (const c of byTokens) {
      let all = true;
      for (const t of q) if (!c.tokens.has(t)) { all = false; break; }
      if (all) { hits.add(c.isin); firstIsin = c.isin; if (hits.size > 1) break; }
    }
    return hits.size === 1 ? firstIsin : null;
  };
}

// ---- fact-sheet text → holdings ------------------------------------------
interface Holding { isin: string; name: string; percent: number }

// Common fact-sheet row labels that are NOT stocks — never treat these as holdings.
const NON_STOCK = /\b(cash|cash equivalents?|total|sub ?total|grand total|others?|net current assets?|treasury|t[\s-]?bills?|money market|liquid|receivables?|payables?|net ?worth|nav|aum|debt|equity total|portfolio)\b/i;

/** Pull "<stock name> <weight%>" rows from arbitrary fact-sheet text. */
function extractHoldings(text: string, resolve: (s: string) => string | null): { holdings: Holding[]; unresolved: string[] } {
  const byIsin = new Map<string, Holding>();
  const unresolved = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.replace(/\s+/g, " ").trim();
    if (!t) continue;
    // A trailing percentage/number is the weight; a plausible single-stock weight is 0.1–40%.
    const m = t.match(/^(.*?)[\s.:]+(\d{1,2}(?:\.\d{1,2})?)\s*%?$/);
    if (!m) continue;
    const pct = Number(m[2]);
    if (!(pct >= 0.1 && pct <= 40)) continue;
    // Name candidate: strip a leading rank ("1", "1.", "#1") off the left side.
    const nameRaw = m[1].replace(/^#?\d{1,2}[.)]?\s+/, "").trim();
    if (nameRaw.length < 3 || NON_STOCK.test(nameRaw)) continue; // skip cash/total/etc.
    const isin = resolve(nameRaw);
    if (!isin) { if (/[a-z]/i.test(nameRaw) && nameRaw.split(" ").length <= 6) unresolved.add(`${nameRaw} (${pct}%)`); continue; }
    const prev = byIsin.get(isin);
    if (!prev || pct > prev.percent) byIsin.set(isin, { isin, name: nameRaw, percent: pct });
  }
  const holdings = [...byIsin.values()].sort((a, b) => b.percent - a.percent).slice(0, 20);
  return { holdings, unresolved: [...unresolved] };
}

/** Best-effort "as on" month detection: "31 July 2026", "July 2026", "31/07/2026", "31.07.2026". */
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function detectMonth(text: string): string | null {
  const t = text.toLowerCase();
  let best: string | null = null;
  const set = (y: string, m: string) => { const k = `${y}-${m}`; if (!best || k > best) best = k; };
  for (const mm of t.matchAll(/\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](20\d{2})\b/g)) set(mm[3], mm[2].padStart(2, "0"));
  for (const mm of t.matchAll(/\b([a-z]{3,9})[\s,'-]+(20\d{2})\b/g)) {
    const i = MONTHS.findIndex((n) => mm[1].startsWith(n));
    if (i >= 0) set(mm[2], String(i + 1).padStart(2, "0"));
  }
  return best;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);

async function readInput(path: string): Promise<string> {
  if (path.toLowerCase().endsWith(".pdf")) {
    const parser = new PDFParse({ data: new Uint8Array(readFileSync(path)) });
    return (await parser.getText()).text;
  }
  return readFileSync(path, "utf8"); // .txt / .csv — pasted holdings table
}

async function main() {
  const filePath = process.argv.slice(2).find((a) => !a.startsWith("--") && /\.(pdf|txt|csv)$/i.test(a));
  const provider = arg("provider");
  const type = arg("type") === "AIF" ? "AIF" : "PMS";
  if (!filePath || !provider) {
    console.error('Usage: npm run factsheet -- <factsheet.pdf | holdings.txt> --provider "Name" --type PMS|AIF [--slug s] [--month YYYY-MM] [--dry-run]');
    process.exit(1);
  }
  if (!existsSync(filePath)) { console.error(`No such file: ${filePath}`); process.exit(1); }

  const text = await readInput(filePath);
  const resolver = buildResolver();
  const { holdings, unresolved } = extractHoldings(text, resolver);
  const month = arg("month") || detectMonth(text);
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    console.error(`Could not detect the fact-sheet month — pass --month YYYY-MM. (detected: ${month ?? "none"})`);
    process.exit(1);
  }

  console.log(`\n${provider} (${type}) — ${month}: matched ${holdings.length} holdings`);
  for (const h of holdings) console.log(`  ${h.percent.toFixed(1).padStart(5)}%  ${h.isin}  ${h.name}`);
  if (unresolved.length) {
    console.log(`\n  ${unresolved.length} rows looked like holdings but didn't resolve to an ISIN (add an alias, or ignore if not a stock):`);
    for (const u of unresolved.slice(0, 20)) console.log(`    · ${u}`);
  }
  if (holdings.length === 0) {
    console.error(
      "\nNo holdings matched. If this was a PDF, its holdings are likely in charts/images that don't extract as text —" +
      "\ncopy the holdings table into a .txt (one \"Name  9.8%\" per line) and re-run with that file.",
    );
    process.exit(1);
  }
  if (filePath.toLowerCase().endsWith(".pdf") && holdings.length < 5) {
    console.warn("\nNote: only a few holdings matched from this PDF — it may be chart/image-based. For a full list, paste the holdings table into a .txt and re-run.");
  }

  const slug = arg("slug") || slugify(provider);
  const outPath = resolve(OUT_DIR, `${slug}.json`);
  const existing = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : { name: provider, type, disclosure: "partial", months: {} };
  existing.name = provider; existing.type = type;
  existing.months = existing.months ?? {};
  existing.months[month] = holdings.map((h) => ({ isin: h.isin, name: h.name, percent: h.percent }));

  if (arg("dry-run") !== undefined || process.argv.includes("--dry-run")) {
    console.log(`\n[dry-run] would write ${outPath} (month ${month}, ${holdings.length} holdings).`);
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(outPath, JSON.stringify(existing, null, 2) + "\n");
  console.log(`\nWrote ${outPath} (month ${month}). Run \`npm run derive:aifpms\` to update the dashboard.`);
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
