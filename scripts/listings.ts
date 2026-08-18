/**
 * Fetch NSE's official "List of equities" (EQUITY_L.csv) and write an
 * ISIN → listing-date map to data/listings.json (an input to derive, not served).
 * Run with `npm run listings`.
 *
 * Why: the "Brand-new entries" idea list is meant to surface stocks mutual funds
 * are buying for the FIRST time. Left alone it fills up with recent IPOs (a fund
 * "entering" a stock that only just listed is not a discovery). A stock's listing
 * date lets us tell a genuine "old company, newly bought" from "brand-new IPO",
 * so the UI can filter the IPO noise out.
 *
 * The list is matched to our stocks by ISIN, so nothing is guessed (Rule 4).
 * Stocks not on NSE (BSE-only, delisted) simply get no date → their age is
 * UNKNOWN (`null`) and they are never wrongly labelled "recent" or "established"
 * (Rule 2).
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ProxyAgent, setGlobalDispatcher } from "undici";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT = resolve(ROOT, "data/listings.json");
// NSE's archive host serves this static CSV without the cookie handshake the main
// site needs. Columns: SYMBOL, NAME OF COMPANY, SERIES, DATE OF LISTING, …, ISIN NUMBER, …
const URL = "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

configureProxy();

const norm = (v: unknown): string => String(v ?? "").replace(/\s+/g, " ").trim().toLowerCase();

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};
/** "06-OCT-2008" → "2008-10-06". Returns null if it doesn't parse (never guess). */
function toIso(d: string): string | null {
  const m = String(d).trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const mm = MONTHS[m[2].toLowerCase()];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[1].padStart(2, "0")}`;
}

async function getText(url: string): Promise<string> {
  // `accept-encoding: identity` — ask for the file uncompressed. Through the agent
  // proxy a gzip response comes back truncated (only a handful of rows survive);
  // requesting no compression returns the full CSV.
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/csv,*/*", "accept-encoding": "identity" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.text();
}

/**
 * Minimal RFC-4180 CSV parser. We parse the text ourselves (rather than via a
 * spreadsheet lib) so the "DATE OF LISTING" cells stay the RAW strings
 * "06-OCT-2008" — a spreadsheet parser silently coerces most of them to date
 * serials, which then fail our format check. Handles quoted fields with commas.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function main() {
  console.log(`Fetching NSE equity list: ${URL}`);
  const rows = parseCsv(await getText(URL));

  const header = (rows[0] || []).map(norm);
  const isinCol = header.findIndex((c) => c.includes("isin"));
  const dateCol = header.findIndex((c) => c.includes("date of listing"));
  if (isinCol < 0 || dateCol < 0) throw new Error("Could not find ISIN / DATE OF LISTING columns");

  const listings: Record<string, string> = {};
  let seen = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const isin = String(row[isinCol] ?? "").trim().toUpperCase();
    if (!/^INE[A-Z0-9]{9}$/.test(isin)) continue; // real equity ISINs only (Rule 4)
    const iso = toIso(String(row[dateCol] ?? ""));
    if (!iso) continue;
    seen++;
    // A company has one ISIN across series (EQ/BE/SME); keep the EARLIEST listing date.
    if (!listings[isin] || iso < listings[isin]) listings[isin] = iso;
  }
  if (Object.keys(listings).length === 0) throw new Error("Parsed 0 listing dates — format changed?");

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      { source: "NSE — EQUITY_L (list of equities)", url: URL, generatedAt: new Date().toISOString(), count: Object.keys(listings).length, listings },
      null,
      0,
    ) + "\n",
  );
  console.log(`Wrote ${OUT}: ${Object.keys(listings).length} ISIN → listing-date entries (from ${seen} rows).`);
}

function configureProxy(): void {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxy) return;
  const caPath = "/root/.ccr/ca-bundle.crt";
  const ca = existsSync(caPath) ? readFileSync(caPath, "utf8") : undefined;
  setGlobalDispatcher(new ProxyAgent({ uri: proxy, requestTls: ca ? { ca } : undefined }));
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
