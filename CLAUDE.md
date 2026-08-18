# AMFIMGA — project guide

A dashboard that tracks how India's mutual funds buy and sell stocks, month by
month. Every month, mutual funds publicly disclose which stocks they hold and how
many shares; by comparing one month to the next across the whole market (all fund
houses, all stocks) we can see where the "smart money" is quietly moving in or
out. Data originates from each fund house's official monthly disclosure. Two
sources feed us: **AdvisorKhoj** links ~23 houses' `.xlsx` directly (our
`scripts/ingest.ts` scraper), but the other ~26 (incl. HDFC, ICICI Prudential,
Aditya Birla, DSP, Mirae, UTI) route through walled/JS site pages it can't reach.
For full ~50-house coverage we import the already-parsed holdings from the sibling
project **AMFIBEAS** (`github.com/techmuns/amfibeas`), which resolves every house's
official disclosure with **no secret keys**; we merge its data into our months
(see "Data ingestion"). AMFIBEAS is the primary, automated source.

This file is the contract for the whole project. Read it before every step and
keep changes consistent with it.

## The five rules (must always hold)

1. **Data loads from separate files at runtime — never bake data into the code.**
   The monthly data changes; the code must not need rebuilding for that. Holdings
   live in static JSON under `public/data/` and are fetched at runtime (see
   `src/lib/data.ts`). Do not `import` data files into components/bundles.

2. **Never show a fake or zero number for something unknown. Show a dash "—".**
   Unknown/undisclosed values are `null` in the data and render as `—` (see
   `DASH` in `src/lib/format.ts`). A `0` must mean a real, disclosed zero — never
   "missing". In the ingestion, guard against `Number("") === 0`.

3. **Store money as plain rupees (whole numbers).** Never pre-divide into
   lakhs/crores in the data. Field names carry the unit, e.g. `marketValueInr`.
   The source files are in **lakhs** → multiply by 100000 on ingest. Convert to
   "₹x.xx Cr / L" only at display time (`formatInr` in `src/lib/format.ts`).

4. **Identify every stock by its ISIN** (e.g. `INE040A01034`), never by name.
   Names are written inconsistently across sources and must be treated as
   display-only labels (`stockName`). ISIN is the join key everywhere. On ingest,
   keep only rows whose ISIN matches `INE` + 9 chars.

5. **Ingested data is sacred: a bad fetch must never overwrite good data.**
   The data is produced only by `scripts/ingest.ts` from official disclosures —
   never hand-edited. If a download is missing, walled, tiny, or not a real
   workbook, that fund house is recorded as a gap (`coverage` in the month file),
   the previously-good data for it is retained, and a run where nothing succeeded
   writes nothing. (The site itself is public — no login; the holdings are public
   disclosure.)

## Data shape

For each **month**, one file lists every **fund** (scheme) across all fund
houses, and for each fund a list of **holdings**. Each holding is one stock
position. TypeScript types in `src/types/holdings.ts` are the source of truth;
the on-disk format is documented in `docs/data-format.md`.

Per holding:

| Field              | Type             | Notes                                                        |
| ------------------ | ---------------- | ------------------------------------------------------------ |
| `isin`             | `string`         | Canonical stock ID (Rule 4). e.g. `INE040A01034`.            |
| `stockName`        | `string`         | Display only; never an identifier.                           |
| `shares`           | `number \| null` | Whole share count. `null` = not disclosed → shows `—`.       |
| `marketValueInr`   | `number \| null` | **Plain whole rupees** (Rule 3), not lakhs/crores.           |
| `portfolioPercent` | `number \| null` | Share of the fund's portfolio, 0–100.                        |
| `sector`           | `string \| null` | Sector/industry. `null` = not disclosed.                     |

Each fund carries `fundId` (stable id, `"<AMC-Slug>:<schemeCode>"`), `fundName`,
and `fundHouse` (the AMC), so holdings can be rolled up by fund house.

**Two tiers of data:**

- **Raw months (NOT served)** — `data/months/<YYYY-MM>.json.gz` (gzipped): the full holdings,
  `{ month, source, generatedAt?, coverage?, funds: [...] }`. `coverage` records
  each fund house's ingestion outcome (Rule 5). These are big; the browser never
  loads them. They live outside `public/` on purpose.
- **Derived summaries (served, small)** — `public/data/…`: what the browser loads.
  Produced from the raw months by `scripts/derive.ts`.

Adding a month = `npm run ingest:amfibeas` (imports AMFIBEAS's full-coverage
holdings → `data/months/…`) then `npm run derive` (rebuilds the summaries); the
AdvisorKhoj scraper `npm run ingest` is the on-demand alternative for the ~23
directly-linked houses. Either way, no app code change (Rule 1).

## Data ingestion

`scripts/ingest.ts` (run with `npm run ingest -- <args>`) downloads the official
disclosures and writes month files:

- Reads the live "Select AMC" dropdown on AdvisorKhoj for the fund-house list
  (never hardcoded) and each house's "Monthly Portfolio Disclosure" `.xlsx`
  links. Prefers the full month-end file over an "Adhoc" partial.
- Downloads each `.xlsx` — plain fetch for openly-reachable houses; **scrape.do**
  (`SCRAPEDO_API_KEY`) for houses behind a bot-wall (Akamai). Without a key, the
  open houses still ingest and the rest are recorded as gaps (never zeros).
- Parses each workbook (one sheet per scheme) by **locating the header row via the
  "ISIN" column** and reading the other columns off that row (positions vary by
  sheet). Values are in lakhs → ×100000; `% to Net Assets` is an Excel fraction
  → ×100.
- Args: `--latest` (default), `--month YYYY-MM`, `--year YYYY`, `--backfill`
  (2023–2026), `--amc <slug>`, `--concurrency N`, `--dry-run`.

`scripts/ingest-amfibeas.ts` (`npm run ingest:amfibeas`) is the **primary,
full-coverage** source. It fetches AMFIBEAS's published per-house holdings
(`public/amc-holdings/*.json` — all ~50 houses, no secret keys; a `--dir` points
at a local checkout instead of GitHub), maps each house to our canonical
AdvisorKhoj slug (so a house keeps ONE `amcSlug` across months **and** sources —
derive groups coverage by that slug), converts values from ₹ crore to plain
rupees (Rule 3), keeps only INE ISINs (Rule 4), and **merges per house** into
`data/months/…`, never wiping a previously-good house (Rule 5). It clamps
imported months to a sane window (AMFIBEAS's "as on" dates occasionally misparse).
AMFIBEAS's history is shallow, so the newest month has the most houses (incl. the
giants) and older months keep our deeper AdvisorKhoj history.

Workflows (both use proxy-aware `undici` locally, direct egress in CI):
- `.github/workflows/sync-amfibeas.yml` — the scheduled monthly job (10th–15th,
  just after AMFIBEAS refreshes): import → `marketcap` → `listings` → `derive` → commit. Needs
  **no secrets**. Also `workflow_dispatch` + a `repository_dispatch`
  (`amfibeas-updated`) hook so AMFIBEAS can trigger a near-real-time sync.
- `.github/workflows/ingest.yml` — the AdvisorKhoj + scrape.do scraper, kept as an
  on-demand independent source (`workflow_dispatch` only).

## Derived summaries

`scripts/derive.ts` (`npm run derive`) turns the raw months into the small files
the browser loads. Pure recomputation, no network. Served files (`public/data`):

- `summary.json` — months + coverage counts (`housesPresent`/`housesTotal`).
- `stocks.json` — compact all-stocks table: per stock, per month, its total
  shares, total value (rupees), fund count, and net share change.
- `sectors.json` — net share-change summed by sector, per month.
- `stocks/<ISIN>.json` — per-stock fund-by-fund detail, loaded on demand.
- `funds.json` — the fund/house picker index: every scheme + AMC present in the
  latest month, with its stock count and equity value. Plus `trendsetters`: funds
  that repeatedly entered a stock BEFORE the crowd (coverage-guarded lead–lag, so
  the AMFIBEAS onboarding month can't masquerade as "the crowd following"). Plus
  `consensus`: the stocks the biggest active funds commonly own and are still
  net-adding (shared conviction — the flip side of one-month churn; "held by X of
  the top N funds, Y still adding").
- `funds/<key>.json` — per-fund AND per-house holdings over time (the flip side of
  the stock page), loaded on demand. `stocks/` and `funds/` are git-ignored —
  bulky and reproducible; regenerated on deploy.

**De-collapse (a data-hygiene fix in derive).** A few AdvisorKhoj months collapsed
several DISTINCT schemes onto one `fundId` (the scraper mis-read the scheme-code
cell — e.g. every Motilal Oswal scheme became `:Back to Index`). `indexMonth`
splits them back apart by scheme name where one `fundId` carries multiple names,
so per-fund views and fund COUNTS stay honest. Stock/house TOTALS are unaffected
(a house's schemes sum the same either way); the newest month (AMFIBEAS) has no
such collisions. This is retroactive — no re-scrape needed.

**Passive/index funds are excluded (a data-hygiene rule in derive).** Index funds
and ETFs mechanically mirror whatever their benchmark holds, so their "buying" is
noise, not active conviction. `indexMonth` drops every index/ETF scheme
(name-classified — `ETF`/`INDEX`/`NIFTY`/`SENSEX`/`BEES`…, calibrated to skip
actively-managed "Active Momentum" and "Liquid" debt funds) from ALL aggregates:
stock totals, month-over-month flows, fund counts, sector flows, trendsetters. A
house still counts as "present" for coverage if it disclosed anything, so the
"X of Y houses" headline is unaffected; the per-month *active* fund count drops.

**Bonus/split neutralisation (a data-hygiene rule in derive).** A split or bonus
multiplies every holder's share count with no real buying. `flowDetail` detects it
(continuing holders' shares jump ≥1.7× while their combined market value stays
~flat) and reports that month's flow as UNKNOWN (`null`) — so a corporate action
never shows as a buy in the net change, the buy/sell streaks, the sector flows, the
Overview totals or the per-fund change. Detected actions ride on
`StockDetail.corporateActions` so the stock page explains the jump. Stored share
COUNTS are left untouched (Rule 2/5) — only the derived *flow* is neutralised.

**Presentation-only signals (`src/lib/signals.ts`).** Readings computed at display
time from the already-served arrays — no new data, no change to stored numbers:
implied price (value ÷ shares, no external feed), buy/sell streaks (the "quiet
accumulation" list), battleground intensity (funds split), split/bonus detection
(the display hint; derive also neutralises the flow, above), entry/exit counts.
Coverage-aware inputs mean a `null` month breaks a streak.

**Coverage-awareness (the core Step-3 rule).** A month-over-month change is only
computed from funds whose fund HOUSE is present in BOTH months. If a house is a
gap in either month, its funds' change is `null` (unknown) — a missing house is
NEVER treated as a sell-to-zero. Each month records how many houses it is based
on. So the per-month *total* shares can rise while the coverage-aware *net
change* is negative (a house appearing is not buying).

Each stock also carries a broad **macro sector** (`macroSector`, ~12 AMFI-style
groups collapsed from the ~60 granular NSE industries in `derive.ts`) used for
the colour chips, sector filter, and sector chart — the granular `sector` stays
on the detail page. And a **market cap** (`marketCap`: large/mid/small) from
AMFI's half-yearly list, matched by ISIN: `scripts/marketcap.ts` (`npm run
marketcap`) fetches the latest list → `data/marketcap.json` (not served); derive
tags each stock, leaving `null` when not confidently matched (never guessed).

Each stock also carries a **listing date** (`listedOn`) and a `recentIpo` flag from
NSE's official equity list, matched by ISIN: `scripts/listings.ts` (`npm run
listings`) fetches `EQUITY_L.csv` → `data/listings.json` (not served); derive tags
each stock's age (`recentIpo` = listed within a year of the latest month). This
powers the **Brand-new entries** IPO filter — hide the fresh-IPO crop so an
established company mutual funds are buying for the FIRST time stands out. Age is
`null`/unknown when the stock isn't on NSE's list (BSE-only, delisted) — never
guessed, and such names are never wrongly labelled recent or established.

`listings.json` also carries NSE's official **company names** by ISIN, which derive
prefers as the display label — so source noise like "EQ - SWIGGY LTD" reads
"Swiggy Limited" and an ISIN-only row gets a real name. Display only; ISIN stays
the join key (Rule 4).

## AIF / PMS early signals (a separate, complementary tier)

AIFs and PMSes don't publish machine-readable full holdings — they disclose via
monthly/quarterly **fact sheets, usually only their top-10 holdings**. So this data
is PARTIAL, and the rule that keeps it honest is **entry-only**: a name appearing is
a signal; a name *leaving* a top-10 is NEVER a sell (it may just have slipped below
#10), so we never compute a sell, exit, or month-over-month change from it. It is
kept entirely **separate from the mutual-fund aggregates** (never mixed into stock
totals/flows) and clearly labelled.

- Input: `data/aif-pms/<provider-slug>.json`, one per provider, filled from fact
  sheets (see `_template.json`). ISIN is the key; rows without an INE ISIN are dropped.
- `scripts/derive-aif-pms.ts` (`npm run derive:aifpms`) reads those files, cross-
  references the MF `stocks.json`, and writes `public/data/aif-pms.json`: per stock,
  which providers disclose it, who **newly** disclosed it, and whether **no mutual
  fund holds it yet** (`aheadOfMutualFunds` — the strongest early signal).
- UI: an "AIF & PMS — early signals" panel atop `/ideas` (`AifPmsPanel`). It renders
  **nothing** until fact sheets are loaded — no empty/fake section on the live site
  (Rule 2/5). Needs the client's fact-sheet data to go live.

## Tech stack

- **React 19 + TypeScript + Tailwind CSS v4**, built with **Vite**.
- Deployed as a **Cloudflare Worker** serving static assets (a thin pass-through;
  no auth), via `@cloudflare/vite-plugin`.
- Ingestion is a Node script (`tsx`) using `xlsx` (SheetJS) and `undici`.
- Tailwind v4 via `@tailwindcss/vite` (no `tailwind.config.js`, no PostCSS);
  global CSS is `src/index.css` (`@import "tailwindcss";`).

## Layout

```
worker/index.ts            Cloudflare Worker: static-asset pass-through (no auth)
scripts/ingest-amfibeas.ts Primary source: import AMFIBEAS holdings (all ~50 houses) → data/months/…
scripts/ingest.ts          AdvisorKhoj scraper (on-demand): download + parse → data/months/<YYYY-MM>.json.gz
scripts/marketcap.ts       Reference: AMFI large/mid/small-cap list → data/marketcap.json (input to derive)
scripts/listings.ts        Reference: NSE listing dates + official names → data/listings.json (input to derive)
scripts/derive.ts          Derive: raw months → small summaries in public/data (drops passive/ETF; neutralises splits)
scripts/derive-aif-pms.ts  Separate tier: AIF/PMS fact sheets → public/data/aif-pms.json (entry-only early signals)
.github/workflows/sync-amfibeas.yml  Monthly AMFIBEAS sync + derive (primary; no secrets)
.github/workflows/ingest.yml  AdvisorKhoj ingest + derive (on-demand)
data/months/               Raw month files (NOT served; input to derive)
  <YYYY-MM>.json.gz        One month, all fund houses (gzipped; produced by ingestion)
data/aif-pms/              AIF/PMS fact-sheet inputs (one JSON per provider; _template.json documents the format)
src/
  main.tsx                 React entry
  App.tsx                  Home page + client routing: top net buys/sells + coverage
  index.css                Tailwind entry + base styles
  components/FundView.tsx  Per-fund / per-house view (picker, activity, holdings, allocation)
  types/holdings.ts        Data types (raw + derived; the format contract)
  lib/data.ts              Runtime loaders: loadSummary/loadStocks/loadSectors/loadStockDetail/loadFunds*
  lib/format.ts            Display helpers: DASH, formatInr/formatRupee, formatPercent, formatCount, formatSignedCount
  lib/signals.ts           Presentation-only signals: impliedPrice, buy/sellStreak, battleground, detectSplit, entryExitCounts
public/
  favicon.svg
  data/                    SERVED summaries only (small)
    summary.json           Months + coverage counts
    stocks.json            Compact all-stocks table
    sectors.json           Net share-change by sector
    funds.json             Fund/house picker index (+ trendsetters, consensus)
    aif-pms.json           AIF/PMS early signals (only present when fact sheets are loaded)
    stocks/<ISIN>.json     Per-stock detail (git-ignored; regenerated on deploy)
    funds/<key>.json       Per-fund & per-house detail (git-ignored; regenerated on deploy)
docs/data-format.md        On-disk data format, in prose
wrangler.jsonc             Worker + assets config
```

## Commands

```bash
npm run dev       # Vite dev server + Worker (Miniflare)
npm run build     # tsc -b (type-check) + vite build → dist/
npm run preview   # Serve the production build through the Worker locally
npm run deploy    # derive, build, then wrangler deploy
npm run ingest:amfibeas       # PRIMARY: import AMFIBEAS full-coverage holdings → data/months/
npm run data:amfibeas         # ingest:amfibeas, then marketcap, listings, derive
npm run ingest -- --latest    # AdvisorKhoj scraper (on-demand): latest full month → data/months/
npm run marketcap             # refresh AMFI cap list → data/marketcap.json (input to derive)
npm run listings              # refresh NSE listing dates → data/listings.json (input to derive)
npm run derive                # rebuild the browser summaries from data/months/
npm run derive:aifpms         # rebuild AIF/PMS early signals from data/aif-pms/ (dormant until fact sheets added)
npm run data                  # ingest --latest, then marketcap, listings, derive, derive:aifpms
```

## Ingestion secrets

The primary source (`ingest:amfibeas` / `sync-amfibeas.yml`) needs **no secrets** —
AMFIBEAS's holdings are public JSON. The secrets below only apply to the on-demand
AdvisorKhoj scraper (`scripts/ingest.ts` / `ingest.yml`):

- `SCRAPEDO_API_KEY` — unlocks fund houses behind a bot-wall. Optional locally
  (copy `.env.example` → `.env`); set as a repo secret for the CI workflow.
- `FIRECRAWL_API_KEY` — optional fallback. Without any key, only open houses
  ingest and the rest are recorded as gaps.

## Scope discipline

Build this project one step at a time. Everything is EQUITY only (derive keeps
ISINs whose security-type is "01"). The UI follows a fixed design system (tokens
in `src/index.css`: one font, standardized sizes, the palette, sector colours,
chart-mark rules) — use it exactly; never invent colours or fonts. The app is
**tabbed**, path-based: `/` Overview (macro flows only, incl. a **sector-rotation
heatmap**), `/stocks` the table, `/funds` the picker (topped by the **Trendsetters**
strip + a **Consensus** strip — what the biggest active funds commonly own & are
adding), `/ideas` the idea lists (topped by an **AIF/PMS early-signals** panel when
fact sheets are loaded; subtabs: Quiet accumulation · Buying & selling ·
Battleground · Brand-new [recent IPOs hidden by default] · Turned around · Ownership
& crowding · Follow the funds — the biggest-mover leaderboards live ONLY here), plus `/stock/<ISIN>` and
`/fund/<key>` detail pages. The stock page's trend chart toggles **Total** (shares /
value / implied price) vs **By fund** (a picked fund's own shares / % of portfolio),
and carries an **Ownership over time** panel (fund-count trend + entry/exit
timeline) and an **Added (6mo)** column (who's been accumulating over time, not just
this month); the fund page carries an **Investing style** cap-mix trend (the mix
month by month, coverage-aware). Every
sparkline is clickable (chart + real numbers). Numbers use one format everywhere:
crore/lakh and percents to 1 decimal, counts as integers, always a +/− sign and
▲/▼ on changes, "—" for unknown.

**Export** is presentation-only (never touches data/analysis; `src/lib/report.ts`
aggregates the existing summaries): **Excel** (`exportExcel.ts`, `exceljs`
lazy-loaded, formatted multi-sheet .xlsx) and **PDF** (`exportPdf.ts`, an
editorial "report edition" broadsheet — cream paper, self-hosted Playfair Display
+ Source Serif 4 in `public/fonts/`, printed to PDF via `@page`). All steps are
done (setup → ingestion → derived signals → dashboard → detail → ideas →
macro/cap → full ~50-house data via AMFIBEAS → per-fund view → polish + export).
When in doubt, keep the five rules, the data shape, and the design system intact.
