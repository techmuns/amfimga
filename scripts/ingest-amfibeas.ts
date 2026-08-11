/**
 * AMFIMGA ingestion — from the AMFIBEAS holdings dataset.
 *
 * Our own AdvisorKhoj ingestion (scripts/ingest.ts) can only reach the ~23 fund
 * houses that AdvisorKhoj links directly to an .xlsx. The other ~26 (HDFC, ICICI
 * Prudential, Aditya Birla, DSP, Mirae, UTI, …) are only reachable by resolving
 * each house's own site — which the sibling project **AMFIBEAS**
 * (github.com/techmuns/amfibeas) already does, with NO secret keys, for all ~50
 * houses. Rather than re-implement 50 site scrapers, we reuse AMFIBEAS's parsed
 * output: it publishes `public/amc-holdings/<slug>.json` per house (latest month
 * + a shallow history), each holding carrying exactly what we need.
 *
 * This script transforms that into our raw month files (data/months/<YYYY-MM>.json.gz,
 * the MonthData shape in src/types/holdings.ts), MERGING per fund house so it fills
 * the gaps our AdvisorKhoj history left without wiping any previously-good data
 * (Rule 5). Then `npm run derive` rebuilds the browser summaries (Rule 1).
 *
 * Source of truth for a house's identity is its display name: AMFIBEAS's slug
 * ("hdfc") is mapped to our canonical AdvisorKhoj slug ("HDFC-Mutual-Fund") so a
 * house keeps ONE amcSlug across months and sources — derive groups coverage by
 * that slug, so a stable slug is what keeps month-over-month honest.
 *
 * Usage (via `npm run ingest:amfibeas -- <args>`):
 *   (default)           Fetch AMFIBEAS's amc-holdings from GitHub, transform, merge.
 *   --dir <path>        Read amc-holdings from a local checkout instead of GitHub.
 *   --commit            git add/commit/push data/months after writing (for CI).
 *   --dry-run           Report what would be written, write nothing.
 *
 * Units: AMFIBEAS stores market value in ₹ crore (2 dp). We store plain whole
 * rupees (Rule 3), so value = round(crore × 1e7) — accurate to the nearest lakh
 * (AMFIBEAS's own rounding); share counts and percentages are carried as-is.
 * Only INE######### ISINs are kept (Rule 4); derive then keeps equity only.
 */

import {
  readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, rmSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { execSync } from "node:child_process";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import type {
  MonthData, FundHoldings, Holding, AmcCoverage,
} from "../src/types/holdings.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const MONTHS_DIR = resolve(ROOT, "data/months");

// AMFIBEAS publishes its parsed holdings here (public repo, no auth).
const GH_BASE =
  "https://raw.githubusercontent.com/techmuns/amfibeas/main/public/amc-holdings";

// Clamp imported months to a sane window: AMFIBEAS's history is shallow (a few
// months) and its "as on" dates occasionally misparse to junk years (1973, 2030).
// Anything outside [MIN_MONTH, current month] is dropped rather than trusted.
const MIN_MONTH = "2025-01";
const nowUTC = new Date();
const MAX_MONTH = `${nowUTC.getUTCFullYear()}-${String(nowUTC.getUTCMonth() + 1).padStart(2, "0")}`;

// A few houses have an upstream parser bug where the scheme "as on" date is read
// from the wrong cell (e.g. a bond's maturity date), so EVERY snapshot date is
// junk and the sanity-clamp would drop the whole house. They are large, real
// houses that disclose monthly, and AMFIBEAS fetched them in the current cycle —
// so we recover their single latest snapshot to the newest disclosure month
// rather than lose it. Guarded: this list only, primary snapshot only, and only
// when the date is otherwise unusable (AMFIBEAS slugs).
const RECOVER_TO_LATEST = new Set(["uti", "zerodha", "jm-financial"]);

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const monthLabel = (m: string): string => {
  const [y, mm] = m.split("-");
  return `${MONTH_NAMES[Number(mm) - 1]} ${y}`;
};
const amcSlugOf = (fundId: string): string => fundId.split(":")[0];

// ---------------------------------------------------------------------------
// AMFIBEAS shapes (only the fields we read)
// ---------------------------------------------------------------------------

interface AbHolding {
  isin?: string; name?: string; industry?: string | null;
  quantity?: number | null; marketValueCr?: number | null; pctToNav?: number | null;
}
interface AbScheme { schemeCode?: string; schemeName?: string; asOf?: string; holdings?: AbHolding[] }
interface AbSnapshot { asOfMonth?: string; asOf?: string; schemes?: AbScheme[] }
interface AbHouse extends AbSnapshot { amc?: string; amcSlug?: string; sourceUrl?: string; history?: AbSnapshot[] }
interface AbIndex { amcs?: { slug: string; file?: string }[] }

// ---------------------------------------------------------------------------
// Proxy-aware fetch (this sandbox routes HTTPS through a proxy; CI is direct)
// ---------------------------------------------------------------------------

function configureProxy(): void {
  const proxy =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxy) return;
  const caPath = "/root/.ccr/ca-bundle.crt";
  const ca = existsSync(caPath) ? readFileSync(caPath, "utf8") : undefined;
  setGlobalDispatcher(new ProxyAgent({ uri: proxy, requestTls: ca ? { ca } : undefined }));
}

async function getJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Raw month I/O (gzipped) — same on-disk contract as scripts/ingest.ts
// ---------------------------------------------------------------------------

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
  rmSync(resolve(MONTHS_DIR, `${month}.json`), { force: true });
}

// ---------------------------------------------------------------------------
// Canonical fund-house identity: AMFIBEAS display name → our AdvisorKhoj slug
// ---------------------------------------------------------------------------

/** Collapse a fund-house name to a comparison key ("HDFC Mutual Fund" → "hdfc"). */
const normHouse = (s: string): string =>
  s.toLowerCase()
    .replace(/mutual fund|asset management|amc|limited|ltd|company|india|\(.*?\)/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

interface Canon { slug: string; name: string }

/** Build the canonical house universe from the coverage arrays we already have. */
function loadCanonicalUniverse(): { byNorm: Map<string, Canon>; all: Canon[] } {
  const byNorm = new Map<string, Canon>();
  if (existsSync(MONTHS_DIR)) {
    const months = new Set<string>();
    for (const f of readdirSync(MONTHS_DIR)) {
      const m = f.match(/^(\d{4}-\d{2})\.json(\.gz)?$/);
      if (m) months.add(m[1]);
    }
    for (const month of [...months].sort()) {
      const data = readMonth(month);
      for (const c of data?.coverage ?? []) {
        const key = normHouse(c.fundHouse);
        if (key && !byNorm.has(key)) byNorm.set(key, { slug: c.amcSlug, name: c.fundHouse });
      }
    }
  }
  return { byNorm, all: [...byNorm.values()] };
}

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

/** Map one AMFIBEAS holding to our Holding, or null if the ISIN isn't INE-equity-shaped. */
function mapHolding(h: AbHolding): Holding | null {
  const isin = String(h.isin ?? "").trim().toUpperCase();
  if (!/^INE[A-Z0-9]{9}$/.test(isin)) return null; // Rule 4; derive keeps equity only
  const qty = typeof h.quantity === "number" && Number.isFinite(h.quantity) ? Math.round(h.quantity) : null;
  const cr = typeof h.marketValueCr === "number" && Number.isFinite(h.marketValueCr) ? h.marketValueCr : null;
  const pct = typeof h.pctToNav === "number" && Number.isFinite(h.pctToNav) ? h.pctToNav : null;
  const name = (h.name && String(h.name).trim()) || isin;
  const sector = (h.industry && String(h.industry).trim()) || null;
  return {
    isin,
    stockName: name,
    shares: qty,
    marketValueInr: cr == null ? null : Math.round(cr * 1e7), // ₹ crore → plain rupees (Rule 3)
    portfolioPercent: pct == null ? null : Math.round(pct * 1e4) / 1e4,
    sector,
  };
}

/**
 * The month a snapshot belongs to = the modal (most common) scheme "as on" month.
 * The mode is taken over ALL parseable months, then accepted only if it lands in
 * our window — so a snapshot whose dates mostly misparse to a junk year (1973,
 * 2030) is dropped WHOLE rather than leaking its few in-window schemes elsewhere.
 */
function snapshotMonth(snap: AbSnapshot): string | null {
  const counts = new Map<string, number>();
  for (const sc of snap.schemes ?? []) {
    const m = String(sc.asOf ?? "").slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(m)) counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [m, n] of counts) if (n > bestN) { bestN = n; best = m; }
  return best && best >= MIN_MONTH && best <= MAX_MONTH ? best : null;
}

/** Turn a snapshot's schemes into our FundHoldings[], for one house (canonical slug/name). */
function snapshotFunds(snap: AbSnapshot, canon: Canon): FundHoldings[] {
  const out: FundHoldings[] = [];
  for (const sc of snap.schemes ?? []) {
    const holdings = (sc.holdings ?? []).map(mapHolding).filter((h): h is Holding => h != null);
    if (holdings.length === 0) continue;
    const code = (sc.schemeCode && String(sc.schemeCode).trim()) || (sc.schemeName && String(sc.schemeName).trim()) || "scheme";
    out.push({
      fundId: `${canon.slug}:${code}`,
      fundName: (sc.schemeName && String(sc.schemeName).trim()) || code,
      fundHouse: canon.name,
      holdings,
    });
  }
  return out;
}

/**
 * Merge fresh funds with the existing month, per fund house: a house present in
 * `fresh` replaces its old funds; houses only in the existing file are retained
 * (never wiped — Rule 5). Returns the merged funds and the retained slugs.
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
    if (!freshSlugs.has(slug)) { kept.push(f); retainedSlugs.add(slug); }
  }
  const funds = [...fresh, ...kept].sort(
    (a, b) => a.fundHouse.localeCompare(b.fundHouse) || a.fundName.localeCompare(b.fundName),
  );
  return { funds, retainedSlugs };
}

/** Rebuild the coverage array over the full canonical universe for one month. */
function buildCoverage(
  universe: Canon[],
  funds: FundHoldings[],
  prior: AmcCoverage[] | undefined,
): AmcCoverage[] {
  const priorBySlug = new Map((prior ?? []).map((c) => [c.amcSlug, c]));
  const bySlug = new Map<string, FundHoldings[]>();
  for (const f of funds) {
    const s = amcSlugOf(f.fundId);
    (bySlug.get(s) ?? bySlug.set(s, []).get(s)!).push(f);
  }
  const rows: AmcCoverage[] = [];
  for (const c of universe) {
    const houseFunds = bySlug.get(c.slug);
    if (houseFunds && houseFunds.length) {
      rows.push({
        fundHouse: c.name, amcSlug: c.slug, status: "ok",
        schemes: houseFunds.length,
        holdings: houseFunds.reduce((n, f) => n + f.holdings.length, 0),
      });
    } else {
      const p = priorBySlug.get(c.slug);
      rows.push(p ?? {
        fundHouse: c.name, amcSlug: c.slug, status: "missing",
        schemes: 0, holdings: 0, reason: "no data this month",
      });
    }
  }
  return rows.sort((a, b) => a.fundHouse.localeCompare(b.fundHouse));
}

// ---------------------------------------------------------------------------
// Loading AMFIBEAS's amc-holdings (local dir or GitHub)
// ---------------------------------------------------------------------------

async function loadAmfibeasHouses(localDir: string | null): Promise<AbHouse[]> {
  if (localDir) {
    const houses: AbHouse[] = [];
    for (const f of readdirSync(localDir)) {
      if (f === "index.json" || !f.endsWith(".json")) continue;
      houses.push(JSON.parse(readFileSync(resolve(localDir, f), "utf8")) as AbHouse);
    }
    return houses;
  }
  // GitHub: read the index, then each house file.
  const index = (await getJson(`${GH_BASE}/index.json`)) as AbIndex;
  const files = (index.amcs ?? []).map((a) => a.file || `${a.slug}.json`);
  const houses: AbHouse[] = [];
  for (const file of files) {
    try {
      houses.push((await getJson(`${GH_BASE}/${file}`)) as AbHouse);
    } catch (err) {
      console.log(`  ! could not fetch ${file}: ${(err as Error).message}`);
    }
  }
  return houses;
}

// ---------------------------------------------------------------------------
// git commit (for CI) — same retry/backoff shape as scripts/ingest.ts
// ---------------------------------------------------------------------------

function commitMonths(message: string): void {
  try {
    execSync("git add data/months", { stdio: "ignore" });
    if (!execSync("git status --porcelain data/months").toString().trim()) return;
    execSync(`git commit -q -m ${JSON.stringify(message)}`, { stdio: "ignore" });
  } catch {
    return;
  }
  for (let attempt = 0, delay = 2000; attempt < 4; attempt++) {
    try { execSync("git push", { stdio: "ignore" }); return; }
    catch { execSync(`sleep ${delay / 1000}`, { stdio: "ignore" }); delay *= 2; }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const commit = argv.includes("--commit");
  const dirIdx = argv.indexOf("--dir");
  const localDir = dirIdx >= 0 ? argv[dirIdx + 1] : null;

  configureProxy();
  console.log(
    `AMFIMGA ingest ← AMFIBEAS — source:${localDir ? `local(${localDir})` : "github"} ` +
      `window:${MIN_MONTH}..${MAX_MONTH}${dryRun ? " [dry-run]" : ""}`,
  );

  const { byNorm, all: universe } = loadCanonicalUniverse();
  if (universe.length === 0) {
    console.error("No existing month coverage to derive the canonical house list from. Run scripts/ingest.ts first.");
    process.exit(1);
  }
  console.log(`Canonical fund houses: ${universe.length}`);

  const houses = await loadAmfibeasHouses(localDir);
  console.log(`AMFIBEAS houses loaded: ${houses.length}`);

  // The newest disclosure month present anywhere — the target for recovering the
  // few houses whose dates are all junk (see RECOVER_TO_LATEST).
  let latestMonth = MIN_MONTH;
  for (const house of houses) {
    for (const snap of [{ schemes: house.schemes }, ...(house.history ?? [])]) {
      const m = snapshotMonth(snap);
      if (m && m > latestMonth) latestMonth = m;
    }
  }

  // Accumulate fresh funds per month (deduped by fundId).
  const perMonth = new Map<string, Map<string, FundHoldings>>();
  const unmatched = new Set<string>();
  const recovered = new Set<string>();
  let droppedSnaps = 0;

  for (const house of houses) {
    const amcName = String(house.amc ?? house.amcSlug ?? "").trim();
    if (!amcName) continue;
    let canon = byNorm.get(normHouse(amcName));
    if (!canon) {
      canon = { slug: amcName.replace(/\s+/g, "-"), name: amcName };
      unmatched.add(amcName);
    }
    const snaps: AbSnapshot[] = [{ asOfMonth: house.asOfMonth, asOf: house.asOf, schemes: house.schemes }, ...(house.history ?? [])];
    for (const [i, snap] of snaps.entries()) {
      let month = snapshotMonth(snap);
      if (!month && i === 0 && RECOVER_TO_LATEST.has(String(house.amcSlug ?? ""))) {
        month = latestMonth; // guarded recovery of a misdated large house
        recovered.add(canon.name);
      }
      if (!month) { droppedSnaps++; continue; }
      const funds = snapshotFunds(snap, canon);
      if (funds.length === 0) continue;
      let bucket = perMonth.get(month);
      if (!bucket) perMonth.set(month, (bucket = new Map()));
      for (const f of funds) {
        const prev = bucket.get(f.fundId);
        // If a house lands twice in one month (misparse), keep the richer scheme.
        if (!prev || f.holdings.length > prev.holdings.length) bucket.set(f.fundId, f);
      }
    }
  }

  if (recovered.size) console.log(`  · recovered ${recovered.size} misdated house(s) → ${latestMonth}: ${[...recovered].join(", ")}`);
  if (unmatched.size) {
    console.log(`  ! ${unmatched.size} AMFIBEAS house(s) had no canonical match (used a derived slug): ${[...unmatched].join(", ")}`);
  }
  if (droppedSnaps) console.log(`  · dropped ${droppedSnaps} snapshot(s) with no in-window "as on" month`);

  const months = [...perMonth.keys()].sort();
  console.log(`Months with AMFIBEAS data: ${months.join(", ") || "(none)"}\n`);

  let wrote = 0;
  for (const month of months) {
    const fresh = [...perMonth.get(month)!.values()];
    const freshHouses = new Set(fresh.map((f) => amcSlugOf(f.fundId)));
    const existing = readMonth(month);
    const { funds, retainedSlugs } = mergeFunds(existing, fresh);
    const coverage = buildCoverage(universe, funds, existing?.coverage);
    const present = new Set(funds.map((f) => amcSlugOf(f.fundId)));
    const hasHouse = (slug: string) => present.has(slug);

    const holdingsTotal = fresh.reduce((n, f) => n + f.holdings.length, 0);
    console.log(
      `  ${month} (${monthLabel(month)}): +${freshHouses.size} AMFIBEAS houses, ` +
        `merged ${present.size}/${universe.length} present, ${funds.length} funds, ` +
        `${holdingsTotal} fresh holdings` +
        (retainedSlugs.size ? `, ${retainedSlugs.size} retained` : "") +
        `  [HDFC:${hasHouse("HDFC-Mutual-Fund") ? "y" : "n"} ICICI:${hasHouse("ICICI-Prudential-Mutual-Fund") ? "y" : "n"}]`,
    );

    if (dryRun) continue;
    const out: MonthData = {
      month,
      source:
        "AMFIBEAS (github.com/techmuns/amfibeas) — official AMC monthly portfolio " +
        "disclosures, re-parsed; merged with AdvisorKhoj data. Market value from ₹ crore.",
      generatedAt: new Date().toISOString(),
      coverage,
      funds,
    };
    writeMonth(month, out);
    wrote++;
  }

  console.log(`\n${dryRun ? "(dry-run) would write" : "Wrote"} ${dryRun ? months.length : wrote} month file(s).`);
  if (!dryRun && commit) {
    commitMonths(`data: import AMFIBEAS holdings (${months.length} months, through ${months[months.length - 1] ?? "?"})`);
  }
  if (!dryRun) console.log("Next: run `npm run derive` to rebuild the browser summaries.");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
