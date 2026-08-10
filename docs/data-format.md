# Data format

How each month's fund-holdings data is stored on disk. The TypeScript types in
[`src/types/holdings.ts`](../src/types/holdings.ts) are the authoritative source;
this document explains the format and the decisions behind it.

## Where the files live and how they load

All data is plain JSON under `public/data/`. Vite copies `public/` verbatim into
the build, so at runtime the files are served from the site root:

```
public/data/index.json      ->  /data/index.json
public/data/2026-05.json    ->  /data/2026-05.json
public/data/2026-06.json    ->  /data/2026-06.json
```

The app **fetches** these at runtime (`src/lib/data.ts`); it never imports them.
This is Rule 1 — the data changes monthly, the code does not. Publishing a new
month is a data-only change:

1. Add `public/data/<YYYY-MM>.json`.
2. Add a matching entry to `public/data/index.json` (keep the list sorted
   oldest → newest).

No rebuild of application logic is required.

> Note: the files are still served **through the Worker password gate** (Rule 5),
> so they are private — but they are static data, not code.

## The index file — `index.json`

Lists which months are available. The app loads this first.

```json
{
  "schemaVersion": 1,
  "months": [
    { "month": "2026-05", "label": "May 2026", "file": "/data/2026-05.json" },
    { "month": "2026-06", "label": "June 2026", "file": "/data/2026-06.json" }
  ]
}
```

| Field           | Type     | Notes                                                     |
| --------------- | -------- | --------------------------------------------------------- |
| `schemaVersion` | `number` | Bump when this format changes, so future steps can migrate. |
| `months`        | array    | Sorted oldest → newest.                                   |
| `months[].month`| `string` | `"YYYY-MM"`. The canonical month key.                     |
| `months[].label`| `string` | Human label, e.g. `"May 2026"`.                           |
| `months[].file` | `string` | Absolute path (from site root) to the month's data file.  |

## A month file — `<YYYY-MM>.json`

Every fund's holdings for one month.

```json
{
  "month": "2026-05",
  "source": "AdvisorKhoj (EXAMPLE placeholder data — made-up numbers, not real holdings)",
  "funds": [
    {
      "fundId": "example-bluechip-fund",
      "fundName": "Example Bluechip Equity Fund",
      "fundHouse": "Example Asset Management",
      "holdings": [
        {
          "isin": "INE001A01036",
          "stockName": "Bharat Digital Services Ltd",
          "shares": 1200000,
          "marketValueInr": 1523400000,
          "portfolioPercent": 8.42,
          "sector": "Information Technology"
        }
      ]
    }
  ]
}
```

### Month object

| Field    | Type     | Notes                                            |
| -------- | -------- | ------------------------------------------------ |
| `month`  | `string` | `"YYYY-MM"`; must match the index entry.         |
| `source` | `string` | Provenance — where the numbers came from.        |
| `funds`  | array    | One entry per fund reporting this month.         |

### Fund object

| Field       | Type     | Notes                                                          |
| ----------- | -------- | -------------------------------------------------------------- |
| `fundId`    | `string` | Stable slug identifying the fund **across months** (the join key for funds). |
| `fundName`  | `string` | Display name of the scheme.                                    |
| `fundHouse` | `string` | The AMC / fund house.                                          |
| `holdings`  | array    | The stock positions held this month.                           |

### Holding object

| Field              | Type             | Notes                                                        |
| ------------------ | ---------------- | ------------------------------------------------------------ |
| `isin`             | `string`         | **Canonical stock identifier (Rule 4).** Join stocks on this, never on name. |
| `stockName`        | `string`         | Display only. Spelling varies across sources.                |
| `shares`           | `number \| null` | Whole share count. `null` when not disclosed.                |
| `marketValueInr`   | `number \| null` | **Plain whole rupees (Rule 3)** — not lakhs/crores. `null` when not disclosed. |
| `portfolioPercent` | `number \| null` | Percent of the fund's portfolio, `0`–`100`. `null` when not disclosed. |
| `sector`           | `string \| null` | Sector/industry. `null` when not disclosed.                  |

## Conventions baked into the format

- **Unknown → `null`, never `0` (Rule 2).** Any field that wasn't disclosed is
  `null` and renders as `—` in the UI. A `0` means a real, disclosed zero.
- **Money is plain rupees (Rule 3).** `marketValueInr` is a whole number of
  rupees. Example: `1523400000` is ₹152.34 crore. Formatting to crores/lakhs
  happens only at display time (`formatInr`).
- **ISIN is the identity (Rule 4).** The same company can appear under slightly
  different `stockName`s in different files; only `isin` is reliable for matching
  a stock month-over-month and across funds.
- **`fundId` is the fund identity.** Use it (not `fundName`) to track a fund
  across months.

## Example data in this repo

`2026-05.json` and `2026-06.json` are **fictional** — made-up funds, stocks, and
numbers — so the app has something to load in this setup step. Between the two
months the examples deliberately include a buy (more shares), a sell (fewer
shares), an exit (a holding that disappears), a new position, and one `null`
`sector`, so later steps have realistic month-over-month changes and a missing
value to render as `—`.
