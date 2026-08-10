# AMFIMGA — project guide

A private dashboard that tracks how India's mutual funds buy and sell stocks,
month by month. Every month, mutual funds publicly disclose which stocks they
hold and how many shares; by comparing one month to the next across the whole
market (all fund houses, all stocks) we can see where the "smart money" is
quietly moving in or out. Data originates from **AdvisorKhoj**, which links each
fund house's official monthly holdings file.

This file is the contract for the whole project. Read it before every step and
keep changes consistent with it.

## The five rules (must always hold)

1. **Data loads from separate files at runtime — never bake data into the code.**
   The monthly data changes; the code must not need rebuilding for that. Holdings
   live in static JSON under `public/data/` and are fetched at runtime (see
   `src/lib/data.ts`). Do not `import` data files into components/bundles.

2. **Never show a fake or zero number for something unknown. Show a dash "—".**
   Unknown/undisclosed values are `null` in the data and render as `—` (see
   `DASH` in `src/lib/format.ts`), with a short reason where possible. A `0` must
   mean a real, disclosed zero — never "missing".

3. **Store money as plain rupees (whole numbers).** Never pre-divide into
   lakhs/crores in the data. Field names carry the unit, e.g. `marketValueInr`.
   Convert to "₹x.xx Cr / L" only at display time (`formatInr` in
   `src/lib/format.ts`).

4. **Identify every stock by its ISIN** (e.g. `INE040A01034`), never by name.
   Names are written inconsistently across sources and must be treated as
   display-only labels (`stockName`). ISIN is the join key everywhere.

5. **Private tool: the whole site sits behind one password, enforced in the
   Cloudflare Worker.** Because the data is served as static files, the gate
   CANNOT be client-side only. `worker/index.ts` runs before every request
   (`assets.run_worker_first`) and refuses to serve anything — page, script, or
   `/data/*.json` — without a valid signed session cookie.

## Data shape

For each **month**, a file lists each **fund**, and for each fund a list of
**holdings**. Each holding is one stock position. TypeScript types in
`src/types/holdings.ts` are the source of truth; the on-disk format is documented
in `docs/data-format.md`.

Per holding:

| Field              | Type             | Notes                                                        |
| ------------------ | ---------------- | ------------------------------------------------------------ |
| `isin`             | `string`         | Canonical stock ID (Rule 4). e.g. `INE040A01034`.            |
| `stockName`        | `string`         | Display only; never an identifier.                           |
| `shares`           | `number \| null` | Whole share count. `null` = not disclosed → shows `—`.       |
| `marketValueInr`   | `number \| null` | **Plain whole rupees** (Rule 3), not lakhs/crores.           |
| `portfolioPercent` | `number \| null` | Share of the fund's portfolio, 0–100.                        |
| `sector`           | `string \| null` | Sector/industry. `null` = not disclosed.                     |

Files (served from the site root at runtime):

- `public/data/index.json` — `{ schemaVersion, months: [{ month, label, file }] }`,
  sorted oldest → newest. The app reads this first to learn which months exist.
- `public/data/<YYYY-MM>.json` — `{ month, source, funds: [{ fundId, fundName,
  fundHouse, holdings: [...] }] }` for that month.

Adding a month later = drop a new `public/data/<YYYY-MM>.json` and add its entry
to `index.json`. No code change (Rule 1).

## Tech stack

- **React 19 + TypeScript + Tailwind CSS v4**, built with **Vite**.
- Deployed as a **Cloudflare Worker** serving static assets, via
  `@cloudflare/vite-plugin`. The Worker also implements the password gate.
- Tailwind v4 is configured through `@tailwindcss/vite` (no `tailwind.config.js`,
  no PostCSS config); global CSS is `src/index.css` (`@import "tailwindcss";`).

## Layout

```
worker/index.ts        Cloudflare Worker: password gate + static-asset serving
src/
  main.tsx             React entry
  App.tsx              The single home page (loads the index, shows months loaded)
  index.css            Tailwind entry + base styles
  types/holdings.ts    Data types (the format contract)
  lib/data.ts          Runtime loaders: loadIndex(), loadMonth() — fetch, no imports
  lib/format.ts        Display helpers: DASH, formatInr, formatPercent, formatCount
public/
  favicon.svg
  data/
    index.json         Which months exist
    2026-05.json       Example month (made-up numbers)
    2026-06.json       Example month (made-up numbers)
docs/data-format.md    On-disk data format, in prose
wrangler.jsonc         Worker + assets config (run_worker_first = true)
```

## Commands

```bash
npm run dev       # Vite dev server + Worker (Miniflare). Log in, then HMR works.
npm run build     # tsc -b (type-check) + vite build → dist/
npm run preview   # Serve the production build through the Worker locally
npm run deploy    # build, then wrangler deploy
npm run cf-typegen # regenerate Cloudflare binding types (optional)
```

## Auth / secrets

Two secrets drive the gate:

- `APP_PASSWORD` — the single site password.
- `SESSION_SECRET` — HMAC key that signs the session cookie.
- `SESSION_TTL_HOURS` (optional) — login lifetime, default 12.
- `DEV_MODE` — set to `"true"` **only** locally (via `.dev.vars`). It lets Vite's
  HMR/module requests bypass the gate so hot-reload works, and drops the cookie
  `Secure` flag for `http://localhost`. It is **absent in production**, where every
  request is gated.

Local dev: copy `.dev.vars.example` → `.dev.vars` (git-ignored) and fill values.
Production: set real secrets with `npx wrangler secret put APP_PASSWORD` and
`npx wrangler secret put SESSION_SECRET`. Never commit real secrets. The gate
fails **closed**: if the secrets are missing, nobody is let in.

## Scope discipline

Build this project one step at a time. Do not add data-downloading, analysis, or
extra dashboard screens until the step that calls for them. When in doubt, keep
the five rules and the data shape above intact.
