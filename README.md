# AMFIMGA

A dashboard that tracks how **India's mutual funds buy and sell stocks, month by
month**. Every month, funds disclose their holdings; by comparing one month to
the next across the whole market, the dashboard will surface where the "smart
money" is quietly moving in or out. Data originates from **AdvisorKhoj**, which
links each fund house's official monthly holdings file.

> **Status: Steps 1–2 of ~7 done.** The app scaffold, runtime data format, and
> the real data ingestion (download + parse + monthly automation) are in place.
> The buy/sell analysis and the dashboard screens come in later steps.

## Stack

React 19 + TypeScript + Tailwind CSS v4, built with Vite, deployed as a
**Cloudflare Worker** (a thin static-asset server — the site is public). Data
ingestion is a Node script using SheetJS (`xlsx`).

## Quick start

```bash
npm install
npm run dev        # Vite dev server + Worker; open the URL
```

Other commands:

```bash
npm run build      # type-check (tsc -b) + vite build → dist/
npm run preview    # serve the production build through the Worker locally
npm run deploy     # build, then wrangler deploy
```

## Data ingestion

Download the official monthly disclosures and write month files under
`public/data/`:

```bash
npm run ingest -- --latest         # newest full month
npm run ingest -- --month 2026-05  # a specific month
npm run ingest -- --backfill       # all of 2023–2026
```

Many fund-house sites sit behind a bot-wall. Set a **scrape.do** key to reach
them (copy `.env.example` → `.env`, or export it):

```bash
export SCRAPEDO_API_KEY=...   # without it, only openly-reachable houses ingest;
                              # the rest are recorded as gaps, never as zeros
```

`.github/workflows/ingest.yml` runs `--latest` on the 16th of each month and
commits the result (set `SCRAPEDO_API_KEY` as a repo secret for full coverage).

## How it's organized

See **[CLAUDE.md](./CLAUDE.md)** for the project guide (the five rules every step
must follow, the data shape, and the layout) and
**[docs/data-format.md](./docs/data-format.md)** for the on-disk data format.

The five rules in brief:

1. Data loads from separate files at runtime — never baked into the code.
2. Unknown values show a dash `—`, never a fake `0` or a guess.
3. Money is stored as plain whole rupees; formatted only for display.
4. Stocks are identified by **ISIN**, never by name.
5. Ingested data is sacred — a bad/partial fetch never overwrites good data or
   invents zeros; gaps are recorded as gaps.
