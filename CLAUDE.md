# AMFIMGA — project guide

A dashboard that tracks how India's mutual funds buy and sell stocks, month by
month. Every month, mutual funds publicly disclose which stocks they hold and how
many shares; by comparing one month to the next across the whole market (all fund
houses, all stocks) we can see where the "smart money" is quietly moving in or
out. Data originates from **AdvisorKhoj**, which links each fund house's official
monthly holdings file (an `.xlsx` on the fund house's own site).

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
and `fundHouse` (the AMC), so later steps can roll holdings up by fund house.

Files (served from the site root at runtime):

- `public/data/index.json` — `{ schemaVersion, months: [{ month, label, file }] }`,
  sorted oldest → newest. The app reads this first to learn which months exist.
- `public/data/<YYYY-MM>.json` — `{ month, source, generatedAt?, coverage?,
  funds: [{ fundId, fundName, fundHouse, holdings: [...] }] }`. `coverage` records
  each fund house's ingestion outcome for that month (Rule 5).

Adding a month = run the ingestion (it drops a new `public/data/<YYYY-MM>.json`
and rebuilds `index.json`). No app code change (Rule 1).

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

`.github/workflows/ingest.yml` runs `--latest` monthly (16th) and commits the
result. Uses proxy-aware fetch locally (`undici`) and direct internet in CI.

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
scripts/ingest.ts          Data ingestion (download + parse + write month files)
.github/workflows/ingest.yml  Monthly automated ingestion
src/
  main.tsx                 React entry
  App.tsx                  The single home page (loads the index, shows months loaded)
  index.css                Tailwind entry + base styles
  types/holdings.ts        Data types (the format contract)
  lib/data.ts              Runtime loaders: loadIndex(), loadMonth() — fetch, no imports
  lib/format.ts            Display helpers: DASH, formatInr, formatPercent, formatCount
public/
  favicon.svg
  data/
    index.json             Which months exist
    <YYYY-MM>.json         One month, all fund houses (produced by ingestion)
docs/data-format.md        On-disk data format, in prose
wrangler.jsonc             Worker + assets config
```

## Commands

```bash
npm run dev       # Vite dev server + Worker (Miniflare)
npm run build     # tsc -b (type-check) + vite build → dist/
npm run preview   # Serve the production build through the Worker locally
npm run deploy    # build, then wrangler deploy
npm run ingest -- --latest    # download + parse the latest full month
```

## Ingestion secrets

- `SCRAPEDO_API_KEY` — unlocks fund houses behind a bot-wall. Optional locally
  (copy `.env.example` → `.env`); set as a repo secret for the CI workflow.
- `FIRECRAWL_API_KEY` — optional fallback. Without any key, only open houses
  ingest and the rest are recorded as gaps.

## Scope discipline

Build this project one step at a time. Steps 1–2 (setup, ingestion) are done. Do
not build the analysis math or the dashboard screens until the step that calls
for them. When in doubt, keep the five rules and the data shape above intact.
