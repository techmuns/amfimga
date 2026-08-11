/**
 * AMFIMGA data ingestion.
 *
 * Downloads the official monthly mutual-fund portfolio disclosures that
 * AdvisorKhoj links to (one .xlsx per fund house per month, hosted on each fund
 * house's own site), parses them, and writes one file per month in the project's
 * MonthData format (see src/types/holdings.ts). No app code changes are needed
 * to add a month — this script drops a raw file into data/months, then
 * `npm run derive` rebuilds the small browser summaries in public/data (Rule 1).
 *
 * Usage (via `npm run ingest -- <args>`):
 *   --latest            Ingest the most recent FULL (non-adhoc) month. Default.
 *   --month 2026-05     Ingest a specific month.
 *   --year 2026         Ingest every month in a year.
 *   --backfill          Ingest every month of 2023–2026 (seed history).
 *   --amc <slug|name>   Restrict to one fund house (repeatable; for testing).
 *   --concurrency N     Parallel downloads (default 4).
 *   --dry-run           Fetch + parse + report, but do not write files.
 *
 * Secrets (env or .env): SCRAPEDO_API_KEY unlocks fund houses behind a bot-wall.
 * Without it, only the openly-reachable houses are fetched; the rest are recorded
 * as a gap (never invented as zeros).
 */

import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { execSync } from "node:child_process";
import * as XLSX from "xlsx";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import type {
  MonthData,
  FundHoldings,
  Holding,
  AmcCoverage,
} from "../src/types/holdings.ts";

// ---------------------------------------------------------------------------
// Environment: proxy-aware fetch (this sandbox routes HTTPS through a proxy;
// CI has direct internet). Also load a simple .env if present.
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
// Raw month files live OUTSIDE public/ so they are NOT served to the browser.
// The derive step (scripts/derive.ts) turns them into small summaries in public/data.
const MONTHS_DIR = resolve(ROOT, "data/months");

loadDotEnv();
configureProxy();

const SCRAPEDO_KEY = process.env.SCRAPEDO_API_KEY?.trim() || "";
const FIRECRAWL_KEY = process.env.FIRECRAWL_API_KEY?.trim() || "";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0 Safari/537.36";

const AK_BASE =
  "https://www.advisorkhoj.com/mutual-funds-research/mutual-fund-portfolio";
const SEED_AMCS = ["Axis-Mutual-Fund", "HDFC-Mutual-Fund", "SBI-Mutual-Fund"];
const YEARS = [2023, 2024, 2025, 2026];

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// ---------------------------------------------------------------------------
// Types used internally
// ---------------------------------------------------------------------------

interface Amc {
  name: string; // "Axis Mutual Fund"
  slug: string; // "Axis-Mutual-Fund"
}

interface DisclosureLink {
  month: string; // "YYYY-MM"
  url: string;
  adhoc: boolean;
}

interface DownloadResult {
  ok: boolean;
  buffer?: Buffer;
  via?: "direct" | "scrape.do" | "firecrawl";
  error?: string;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function httpGet(
  url: string,
  opts: { binary?: boolean; timeoutMs?: number } = {},
): Promise<{ status: number; text?: string; buffer?: Buffer; contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": UA,
        accept: opts.binary
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream,*/*"
          : "text/html,application/xhtml+xml,*/*",
      },
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (opts.binary) {
      const buffer = Buffer.from(await res.arrayBuffer());
      return { status: res.status, buffer, contentType };
    }
    return { status: res.status, text: await res.text(), contentType };
  } finally {
    clearTimeout(timer);
  }
}

/** A real .xlsx is a ZIP: it must start with "PK" and be more than a few KB. */
function looksLikeWorkbook(buf: Buffer | undefined): boolean {
  return !!buf && buf.length > 5_000 && buf[0] === 0x50 && buf[1] === 0x4b; // 'P''K'
}

async function downloadWorkbook(url: string): Promise<DownloadResult> {
  // 1) Plain fetch — works for the openly-reachable fund houses.
  try {
    const r = await httpGet(url, { binary: true, timeoutMs: 90_000 });
    if (r.status === 200 && looksLikeWorkbook(r.buffer)) {
      return { ok: true, buffer: r.buffer, via: "direct" };
    }
  } catch {
    /* fall through to proxies */
  }

  // 2) scrape.do — real browser / residential IP, carries the binary file.
  if (SCRAPEDO_KEY) {
    try {
      const api =
        `https://api.scrape.do/?token=${encodeURIComponent(SCRAPEDO_KEY)}` +
        `&url=${encodeURIComponent(url)}&super=true`;
      const r = await httpGet(api, { binary: true, timeoutMs: 120_000 });
      if (r.status === 200 && looksLikeWorkbook(r.buffer)) {
        return { ok: true, buffer: r.buffer, via: "scrape.do" };
      }
    } catch {
      /* fall through */
    }
  }

  // 3) firecrawl — optional fallback.
  if (FIRECRAWL_KEY) {
    try {
      const api =
        `https://api.firecrawl.dev/v1/scrape?url=${encodeURIComponent(url)}`;
      const r = await httpGet(api, { binary: true, timeoutMs: 120_000 });
      if (r.status === 200 && looksLikeWorkbook(r.buffer)) {
        return { ok: true, buffer: r.buffer, via: "firecrawl" };
      }
    } catch {
      /* fall through */
    }
  }

  return {
    ok: false,
    error: SCRAPEDO_KEY ? "download failed / not a workbook" : "walled (no scrape.do key)",
  };
}

// ---------------------------------------------------------------------------
// AdvisorKhoj scraping
// ---------------------------------------------------------------------------

/** Read the "Select AMC" dropdown from a live page — never hardcode the list. */
async function getAmcList(year: number): Promise<Amc[]> {
  let html = "";
  for (const seed of SEED_AMCS) {
    try {
      const r = await httpGet(`${AK_BASE}/${seed}/${year}`, { timeoutMs: 45_000 });
      if (r.status === 200 && r.text && r.text.includes("sel_amc")) {
        html = r.text;
        break;
      }
    } catch {
      /* try next seed */
    }
  }
  if (!html) throw new Error("Could not load any AdvisorKhoj seed page");

  const block = html.match(/<select id="sel_amc"[\s\S]*?<\/select>/)?.[0] ?? "";
  const amcs: Amc[] = [];
  const seen = new Set<string>();
  for (const m of block.matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)</g)) {
    const name = (m[1] || m[2]).trim();
    if (!name || /select amc/i.test(name)) continue;
    const slug = name.replace(/\s+/g, "-");
    if (seen.has(slug)) continue;
    seen.add(slug);
    amcs.push({ name, slug });
  }
  return amcs;
}

/** Extract every "Monthly Portfolio Disclosure - <Month> <Year>" .xlsx link. */
async function getDisclosureLinks(amc: Amc, year: number): Promise<DisclosureLink[]> {
  const r = await httpGet(`${AK_BASE}/${amc.slug}/${year}`, { timeoutMs: 45_000 });
  if (r.status !== 200 || !r.text) return [];
  const out: DisclosureLink[] = [];
  for (const m of r.text.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = m[1].trim();
    const text = m[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (!/monthly portfolio disclosure/i.test(text)) continue;
    if (!/\.xlsx?(\?|$)/i.test(url)) continue;
    const md = text.match(/-\s*([A-Za-z]+)[,\s]+(\d{4})/);
    if (!md) continue;
    const mi = MONTHS.findIndex((n) => n.toLowerCase() === md[1].toLowerCase());
    if (mi < 0 || Number(md[2]) !== year) continue;
    out.push({
      month: `${year}-${String(mi + 1).padStart(2, "0")}`,
      url,
      adhoc: /adhoc/i.test(url) || /adhoc/i.test(text),
    });
  }
  return out;
}

/** For one month, choose the best link (prefer the full month-end over adhoc). */
function pickLink(links: DisclosureLink[], month: string): DisclosureLink | undefined {
  const forMonth = links.filter((l) => l.month === month);
  return forMonth.find((l) => !l.adhoc) ?? forMonth[0];
}

// ---------------------------------------------------------------------------
// Workbook parsing
// ---------------------------------------------------------------------------

const norm = (v: unknown): string =>
  String(v ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** Parse a numeric cell, treating blank / NIL / non-numeric as null (NOT 0). */
function numOrNull(cell: unknown): number | null {
  if (cell == null) return null;
  if (typeof cell === "number") return Number.isFinite(cell) ? cell : null;
  const s = String(cell).trim();
  if (s === "" || /^(nil|na|n\.a\.?|-{1,2}|—)$/i.test(s)) return null; // guard Number("") === 0
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function strOrNull(cell: unknown): string | null {
  if (cell == null) return null;
  const s = String(cell).trim();
  return s === "" ? null : s;
}

const ISIN_RE = /^INE[A-Z0-9]{9}$/;

/** Parse one fund house's workbook into a list of scheme holdings. */
function parseWorkbook(buffer: Buffer, amc: Amc): FundHoldings[] {
  // cellNF keeps each cell's number format, so we can tell a percent-formatted
  // fraction (0.0587) from a plainly-typed percentage (5.87).
  const wb = XLSX.read(buffer, { type: "buffer", cellNF: true });
  const funds: FundHoldings[] = [];

  for (const sheetName of wb.SheetNames) {
    if (/^(index|disclaimer|notes?)$/i.test(sheetName.trim())) continue;
    const ws = wb.Sheets[sheetName];
    if (!ws || !ws["!ref"]) continue;
    const rng = XLSX.utils.decode_range(ws["!ref"]);
    const raw = (r: number, c: number): unknown => {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      return cell ? cell.v : null;
    };

    // Header row = first row (within the top ~25) that has an "ISIN" column.
    let hr = -1;
    for (let r = rng.s.r; r <= Math.min(rng.e.r, rng.s.r + 25) && hr < 0; r++) {
      for (let c = rng.s.c; c <= rng.e.c; c++) {
        if (norm(raw(r, c)).includes("isin")) { hr = r; break; }
      }
    }
    if (hr < 0) continue;

    const findCol = (pred: (h: string) => boolean): number => {
      for (let c = rng.s.c; c <= rng.e.c; c++) if (pred(norm(raw(hr, c)))) return c;
      return -1;
    };
    const isinCol = findCol((h) => h.includes("isin"));
    const nameCol = findCol((h) => h.includes("name of the instrument") || h.includes("name of instrument"));
    const qtyCol = findCol((h) => h.includes("quantity"));
    const valCol = findCol((h) => h.includes("market") && h.includes("value"));
    const pctCol = findCol((h) => h.includes("% to net") || (h.includes("net asset") && h.includes("%")));
    const indCol = findCol((h) => h.includes("industry") || h.includes("sector"));
    if (isinCol < 0 || valCol < 0) continue;

    // Scheme name: the longest real string in the rows above the header.
    let schemeName: string | null = null;
    for (let r = rng.s.r; r < hr; r++) {
      for (let c = rng.s.c; c <= rng.e.c; c++) {
        const s = strOrNull(raw(r, c));
        if (!s || /portfolio statement|as on|as at|monthly portfolio|^\s*note/i.test(s)) continue;
        if (/[A-Za-z]/.test(s) && (!schemeName || s.length > schemeName.length)) schemeName = s;
      }
    }
    const schemeCode = strOrNull(raw(rng.s.r, rng.s.c)) ?? sheetName;

    const holdings: Holding[] = [];
    for (let r = hr + 1; r <= rng.e.r; r++) {
      const isin = String(raw(r, isinCol) ?? "").trim().toUpperCase();
      if (!ISIN_RE.test(isin)) continue; // also skips subtotal/section/total rows
      const valLakhs = numOrNull(raw(r, valCol));
      holdings.push({
        isin,
        stockName: (nameCol >= 0 ? strOrNull(raw(r, nameCol)) : null) ?? isin,
        shares: qtyCol >= 0 ? intOrNull(numOrNull(raw(r, qtyCol))) : null,
        // File is in LAKHS → store plain whole rupees (Rule 3).
        marketValueInr: valLakhs == null ? null : Math.round(valLakhs * 100_000),
        portfolioPercent: pctCol >= 0 ? percentAt(ws, r, pctCol) : null,
        sector: indCol >= 0 ? strOrNull(raw(r, indCol)) : null,
      });
    }

    if (holdings.length > 0) {
      funds.push({
        fundId: `${amc.slug}:${schemeCode}`,
        fundName: schemeName ?? sheetName,
        fundHouse: amc.name,
        holdings,
      });
    }
  }
  return funds;
}

/**
 * Percent of net assets, honouring the cell's number format. SEBI templates vary:
 * some store an Excel fraction (0.0587, formatted "5.87%"), others store the
 * plain number 5.87. Multiply by 100 only when the cell is percent-formatted, so
 * the result always lands in 0–100.
 */
function percentAt(ws: XLSX.WorkSheet, r: number, c: number): number | null {
  const cell = ws[XLSX.utils.encode_cell({ r, c })];
  const value = numOrNull(cell?.v);
  if (value == null) return null;
  const isFraction = String(cell?.z ?? "").includes("%");
  return round4(isFraction ? value * 100 : value);
}

const intOrNull = (n: number | null): number | null => (n == null ? null : Math.round(n));
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

// ---------------------------------------------------------------------------
// Store: write a month file (per-AMC merge) and rebuild the index
// ---------------------------------------------------------------------------

const amcSlugOf = (fundId: string): string => fundId.split(":")[0];
const monthLabel = (month: string): string => {
  const [y, m] = month.split("-");
  return `${MONTHS[Number(m) - 1]} ${y}`;
};

/**
 * Merge this run's funds with any existing month file, per fund house, so a run
 * that couldn't fetch some houses (e.g. no scrape.do key) never wipes their
 * previously-good data. Returns the funds actually written and the retained set.
 */
function mergeFunds(
  existing: MonthData | null,
  fresh: FundHoldings[],
): { funds: FundHoldings[]; retainedSlugs: Set<string> } {
  const freshSlugs = new Set(fresh.map((f) => amcSlugOf(f.fundId)));
  const retainedSlugs = new Set<string>();
  const kept: FundHoldings[] = [];
  for (const f of existing?.funds ?? []) {
    const slug = amcSlugOf(f.fundId);
    if (!freshSlugs.has(slug)) {
      kept.push(f);
      retainedSlugs.add(slug);
    }
  }
  const funds = [...fresh, ...kept].sort(
    (a, b) =>
      a.fundHouse.localeCompare(b.fundHouse) || a.fundName.localeCompare(b.fundName),
  );
  return { funds, retainedSlugs };
}

// Raw months are stored gzip-compressed (data/months/<YYYY-MM>.json.gz) to keep
// the repo lean. A plain .json is still read if present (older files / migration).
function readMonth(month: string): MonthData | null {
  const gz = resolve(MONTHS_DIR, `${month}.json.gz`);
  const plain = resolve(MONTHS_DIR, `${month}.json`);
  try {
    if (existsSync(gz)) return JSON.parse(gunzipSync(readFileSync(gz)).toString("utf8")) as MonthData;
    if (existsSync(plain)) return JSON.parse(readFileSync(plain, "utf8")) as MonthData;
  } catch {
    /* fall through */
  }
  return null;
}

function writeMonth(month: string, out: MonthData): void {
  mkdirSync(MONTHS_DIR, { recursive: true });
  writeFileSync(resolve(MONTHS_DIR, `${month}.json.gz`), gzipSync(JSON.stringify(out) + "\n"));
  rmSync(resolve(MONTHS_DIR, `${month}.json`), { force: true }); // drop any old uncompressed file
}

function listMonths(): string[] {
  const set = new Set<string>();
  for (const f of readdirSync(MONTHS_DIR)) {
    const m = f.match(/^(\d{4}-\d{2})\.json(\.gz)?$/);
    if (m) set.add(m[1]);
  }
  return [...set].sort();
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

interface Args {
  months: string[] | null; // explicit months, or null = derive
  latest: boolean;
  backfill: boolean;
  monthsBack: number | null; // last N months from the latest full month
  year: number | null;
  amcFilter: string[];
  concurrency: number;
  dryRun: boolean;
  skipExisting: boolean; // skip (house, month) pairs already downloaded — resumable
  commitEach: boolean; // git commit + push after each month (incremental progress)
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    months: null, latest: false, backfill: false, monthsBack: null, year: null,
    amcFilter: [], concurrency: 4, dryRun: false, skipExisting: false, commitEach: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--latest") a.latest = true;
    else if (arg === "--backfill") a.backfill = true;
    else if (arg === "--dry-run") a.dryRun = true;
    else if (arg === "--skip-existing") a.skipExisting = true;
    else if (arg === "--commit-each") a.commitEach = true;
    else if (arg === "--month") (a.months ??= []).push(argv[++i]);
    else if (arg === "--months-back") a.monthsBack = Math.max(1, Number(argv[++i]) || 12);
    else if (arg === "--year") a.year = Number(argv[++i]);
    else if (arg === "--amc") a.amcFilter.push(argv[++i]);
    else if (arg === "--concurrency") a.concurrency = Math.max(1, Number(argv[++i]) || 4);
  }
  if (!a.months && !a.backfill && !a.year && !a.monthsBack) a.latest = true;
  return a;
}

/** git add + commit + push the raw months dir, with retry/backoff. No-op if nothing changed. */
function commitMonths(message: string): void {
  try {
    execSync("git add data/months", { stdio: "ignore" });
    const changed = execSync("git status --porcelain data/months").toString().trim();
    if (!changed) return;
    execSync(`git commit -q -m ${JSON.stringify(message)}`, { stdio: "ignore" });
  } catch {
    return; // nothing to commit
  }
  for (let attempt = 0, delay = 2000; attempt < 4; attempt++) {
    try {
      execSync("git push", { stdio: "ignore" });
      return;
    } catch {
      execSync(`sleep ${delay / 1000}`, { stdio: "ignore" });
      delay *= 2;
    }
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Ingest a single month across all (filtered) fund houses. */
async function ingestMonth(month: string, amcs: Amc[], args: Args): Promise<void> {
  const year = Number(month.slice(0, 4));
  const existing = readMonth(month);

  // Resumable: skip (house, month) pairs already downloaded successfully.
  const presentSlugs = new Set((existing?.funds ?? []).map((f) => amcSlugOf(f.fundId)));
  const toFetch = args.skipExisting ? amcs.filter((a) => !presentSlugs.has(a.slug)) : amcs;
  const skipped = amcs.length - toFetch.length;
  console.log(
    `\n=== ${month} (${monthLabel(month)}) — ${amcs.length} houses` +
      (skipped ? `, ${skipped} already present (skipped)` : "") + ` ===`,
  );

  const coverage: AmcCoverage[] = [];
  const freshFunds: FundHoldings[] = [];

  await mapLimit(toFetch, args.concurrency, async (amc) => {
    const base: AmcCoverage = {
      fundHouse: amc.name, amcSlug: amc.slug, status: "failed", schemes: 0, holdings: 0,
    };
    try {
      const links = await getDisclosureLinks(amc, year);
      const link = pickLink(links, month);
      if (!link) {
        coverage.push({ ...base, status: "missing", reason: "no disclosure link listed" });
        return;
      }
      const dl = await downloadWorkbook(link.url);
      if (!dl.ok || !dl.buffer) {
        const walled = /walled/.test(dl.error ?? "");
        coverage.push({ ...base, status: walled ? "walled" : "failed", reason: dl.error });
        return;
      }
      const funds = parseWorkbook(dl.buffer, amc);
      const holdings = funds.reduce((n, f) => n + f.holdings.length, 0);
      if (funds.length === 0 || holdings === 0) {
        coverage.push({ ...base, status: "failed", reason: "parsed 0 holdings" });
        return;
      }
      freshFunds.push(...funds);
      coverage.push({ ...base, status: "ok", schemes: funds.length, holdings });
      console.log(`  ✓ ${amc.name}: ${funds.length} schemes, ${holdings} holdings (${dl.via})`);
    } catch (err) {
      coverage.push({ ...base, status: "failed", reason: (err as Error).message?.slice(0, 120) });
    }
  });

  const okCount = coverage.filter((c) => c.status === "ok").length;
  const holdingsTotal = coverage.reduce((n, c) => n + c.holdings, 0);

  if (toFetch.length === 0) {
    console.log(`  · ${month}: all ${presentSlugs.size} houses already present — nothing to do.`);
    return;
  }
  // Guard: a run that fetched nothing usable never overwrites a good file.
  if (okCount === 0) {
    console.log(`  ! ${month}: 0 new fund houses succeeded — keeping any existing file untouched.`);
    return;
  }

  const { funds, retainedSlugs } = mergeFunds(existing, freshFunds);

  // Mark retained houses in coverage.
  for (const c of coverage) {
    if (retainedSlugs.has(c.amcSlug) && c.status !== "ok") {
      const prev = existing?.funds.filter((f) => amcSlugOf(f.fundId) === c.amcSlug) ?? [];
      c.status = "retained";
      c.schemes = prev.length;
      c.holdings = prev.reduce((n, f) => n + f.holdings.length, 0);
      c.reason = "kept previously-good data";
    }
  }
  coverage.sort((a, b) => a.fundHouse.localeCompare(b.fundHouse));

  const out: MonthData = {
    month,
    source:
      "AdvisorKhoj → fund-house monthly portfolio disclosures (official .xlsx). " +
      "Values converted from lakhs to plain rupees.",
    generatedAt: new Date().toISOString(),
    coverage,
    funds,
  };

  console.log(
    `  → ${month}: ${okCount}/${amcs.length} houses ok, ${funds.length} schemes, ` +
      `${holdingsTotal} holdings this run` +
      (retainedSlugs.size ? `, ${retainedSlugs.size} houses retained` : ""),
  );

  if (args.dryRun) {
    console.log("  (dry-run: not writing)");
    return;
  }
  writeMonth(month, out);
  if (args.commitEach) {
    commitMonths(`data: backfill ${month} (${okCount + retainedSlugs.size}/${amcs.length} houses)`);
    console.log(`  ✓ committed ${month}`);
  }
}

/** Probe seed houses for the newest full (non-adhoc) month available. */
async function latestFullMonth(amcs: Amc[]): Promise<string> {
  const probeYear = YEARS[YEARS.length - 1];
  const all: DisclosureLink[] = [];
  for (const amc of amcs.slice(0, 6)) {
    try {
      all.push(...(await getDisclosureLinks(amc, probeYear)));
    } catch {
      /* ignore */
    }
  }
  const full = all.filter((l) => !l.adhoc).map((l) => l.month).sort();
  const latest = full[full.length - 1];
  if (!latest) throw new Error("Could not determine the latest full month");
  return latest;
}

/** Subtract `n` whole months from a "YYYY-MM". */
function monthsBefore(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const idx = y * 12 + (m - 1) - n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

/** Determine which months to ingest, newest-first for the heavy modes. */
async function resolveMonths(args: Args, amcs: Amc[]): Promise<string[]> {
  if (args.monthsBack) {
    const latest = await latestFullMonth(amcs);
    return Array.from({ length: args.monthsBack }, (_, i) => monthsBefore(latest, i)); // newest first
  }
  if (args.backfill) {
    return YEARS.flatMap((y) => MONTHS.map((_, i) => `${y}-${String(i + 1).padStart(2, "0")}`)).reverse();
  }
  if (args.year) {
    return MONTHS.map((_, i) => `${args.year}-${String(i + 1).padStart(2, "0")}`).reverse();
  }
  if (args.months) return args.months;
  return [await latestFullMonth(amcs)];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `AMFIMGA ingest — scrape.do:${SCRAPEDO_KEY ? "yes" : "no"} ` +
      `firecrawl:${FIRECRAWL_KEY ? "yes" : "no"} concurrency:${args.concurrency}` +
      (args.dryRun ? " [dry-run]" : ""),
  );

  let amcs = await getAmcList(YEARS[YEARS.length - 1]);
  console.log(`Fund houses live on AdvisorKhoj: ${amcs.length}`);
  if (args.amcFilter.length) {
    const want = args.amcFilter.map((s) => s.toLowerCase());
    amcs = amcs.filter(
      (a) => want.includes(a.slug.toLowerCase()) || want.includes(a.name.toLowerCase()),
    );
    console.log(`Filtered to ${amcs.length}: ${amcs.map((a) => a.slug).join(", ")}`);
  }

  const months = await resolveMonths(args, amcs);
  console.log(`Months to ingest: ${months.join(", ")}`);

  for (const month of months) {
    await ingestMonth(month, amcs, args);
  }

  console.log(`\nDone. Raw month files present: ${listMonths().join(", ") || "(none)"}`);
  if (!args.dryRun) console.log("Next: run `npm run derive` to rebuild the browser summaries.");
}

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

function loadDotEnv(): void {
  const p = resolve(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim().replace(/^["']|["']$/g, "");
    if (val && !process.env[key]) process.env[key] = val;
  }
}

function configureProxy(): void {
  const proxy =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxy) return; // CI / direct internet
  const caPath = "/root/.ccr/ca-bundle.crt";
  const ca = existsSync(caPath) ? readFileSync(caPath, "utf8") : undefined;
  setGlobalDispatcher(new ProxyAgent({ uri: proxy, requestTls: ca ? { ca } : undefined }));
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
