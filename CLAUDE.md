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
  just after AMFIBEAS refreshes): import → `marketcap` → `derive` → commit. Needs
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
  (Git-ignored — bulky and reproducible; regenerated on deploy.)

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
scripts/derive.ts          Derive: raw months → small summaries in public/data
.github/workflows/sync-amfibeas.yml  Monthly AMFIBEAS sync + derive (primary; no secrets)
.github/workflows/ingest.yml  AdvisorKhoj ingest + derive (on-demand)
data/months/               Raw month files (NOT served; input to derive)
  <YYYY-MM>.json.gz        One month, all fund houses (gzipped; produced by ingestion)
src/
  main.tsx                 React entry
  App.tsx                  Home page: top net buys/sells + coverage
  index.css                Tailwind entry + base styles
  types/holdings.ts        Data types (raw + derived; the format contract)
  lib/data.ts              Runtime loaders: loadSummary/loadStocks/loadSectors/loadStockDetail
  lib/format.ts            Display helpers: DASH, formatInr, formatPercent, formatCount, formatSignedCount
public/
  favicon.svg
  data/                    SERVED summaries only (small)
    summary.json           Months + coverage counts
    stocks.json            Compact all-stocks table
    sectors.json           Net share-change by sector
    stocks/<ISIN>.json     Per-stock detail (git-ignored; regenerated on deploy)
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
npm run data:amfibeas         # ingest:amfibeas, then marketcap, then derive
npm run ingest -- --latest    # AdvisorKhoj scraper (on-demand): latest full month → data/months/
npm run derive                # rebuild the browser summaries from data/months/
npm run data                  # ingest --latest, then derive
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

Build this project one step at a time. Steps 1–5 (setup, ingestion, derived
signals, main dashboard, stock detail page) are done. Everything is EQUITY only
(derive keeps ISINs whose security-type is "01"). The UI follows a fixed design
system (tokens in `src/index.css`: one font, standardized sizes, the palette,
sector colours, chart-mark rules) — use it exactly; never invent colours or
fonts. Client routing is path-based (`/` dashboard, `/stock/<ISIN>` detail,
`/ideas` idea lists). Steps 1–6 are done (setup → ingestion → derived signals →
dashboard → detail → ideas). When in doubt, keep the five rules, the data shape,
and the design system intact.
