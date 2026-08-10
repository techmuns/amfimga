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
```

The app **fetches** these at runtime (`src/lib/data.ts`); it never imports them.
This is Rule 1 — the data changes monthly, the code does not. Month files are
produced by the ingestion script (see below), which also rebuilds the index.

## The index file — `index.json`

Lists which months are available. The app loads this first.

```json
{
  "schemaVersion": 1,
  "months": [
    { "month": "2026-05", "label": "May 2026", "file": "/data/2026-05.json" }
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

Every fund house's schemes for one month, in one file. Each `fund` is one scheme.

```json
{
  "month": "2026-05",
  "source": "AdvisorKhoj → fund-house monthly portfolio disclosures (official .xlsx). Values converted from lakhs to plain rupees.",
  "generatedAt": "2026-08-10T17:57:00.000Z",
  "coverage": [
    { "fundHouse": "Axis Mutual Fund", "amcSlug": "Axis-Mutual-Fund", "status": "ok", "schemes": 67, "holdings": 4441 },
    { "fundHouse": "HDFC Mutual Fund", "amcSlug": "HDFC-Mutual-Fund", "status": "walled", "schemes": 0, "holdings": 0, "reason": "walled (no scrape.do key)" }
  ],
  "funds": [
    {
      "fundId": "Axis-Mutual-Fund:AXIS500",
      "fundName": "Axis Nifty 500 Index Fund",
      "fundHouse": "Axis Mutual Fund",
      "holdings": [
        {
          "isin": "INE040A01034",
          "stockName": "HDFC Bank Limited",
          "shares": 236732,
          "marketValueInr": 176258810,
          "portfolioPercent": 5.87,
          "sector": "Banks"
        }
      ]
    }
  ]
}
```

### Month object

| Field         | Type              | Notes                                                       |
| ------------- | ----------------- | ----------------------------------------------------------- |
| `month`       | `string`          | `"YYYY-MM"`; matches the index entry.                       |
| `source`      | `string`          | Provenance.                                                 |
| `generatedAt` | `string?`         | ISO timestamp of the ingestion run. Optional.               |
| `coverage`    | `AmcCoverage[]?`  | Per-fund-house outcome for this month (records gaps). Optional. |
| `funds`       | `FundHoldings[]`  | Every scheme that was successfully ingested.                |

### Coverage entry — how gaps are recorded (Rule 5)

A run never invents zeros for a fund house it couldn't fetch. Instead each house
gets a `coverage` row:

| `status`   | Meaning                                                              |
| ---------- | ------------------------------------------------------------------- |
| `ok`       | Downloaded and parsed this run.                                     |
| `walled`   | Blocked by a bot-wall; needs a scrape.do key. Data is a gap.        |
| `failed`   | Link found but the download/parse failed. Data is a gap.            |
| `missing`  | No disclosure link listed for this month. Data is a gap.            |
| `retained` | This run couldn't fetch it, so previously-good data was kept.       |

### Fund object

| Field       | Type     | Notes                                                          |
| ----------- | -------- | -------------------------------------------------------------- |
| `fundId`    | `string` | Stable id `"<AMC-Slug>:<schemeCode>"` — the join key for funds across months. |
| `fundName`  | `string` | Display name of the scheme.                                    |
| `fundHouse` | `string` | The AMC / fund house (used to roll schemes up later).          |
| `holdings`  | array    | The stock positions held this month.                           |

### Holding object

| Field              | Type             | Notes                                                        |
| ------------------ | ---------------- | ------------------------------------------------------------ |
| `isin`             | `string`         | **Canonical stock identifier (Rule 4).** `INE` + 9 chars.    |
| `stockName`        | `string`         | Display only. Spelling varies across sources.                |
| `shares`           | `number \| null` | Whole share count. `null` when not disclosed.                |
| `marketValueInr`   | `number \| null` | **Plain whole rupees (Rule 3)** — the source lakhs value × 100000. `null` when not disclosed. |
| `portfolioPercent` | `number \| null` | Percent of the fund's portfolio, `0`–`100`. `null` when not disclosed. |
| `sector`           | `string \| null` | Sector/industry. `null` when not disclosed.                  |

## How the source .xlsx maps to this format

Each fund house publishes one workbook per month with **one sheet per scheme**.
SEBI fixes the columns but not their position, so the ingestion:

1. Finds the header row by locating the column whose header contains **"ISIN"**,
   then reads the other columns off that same row: *Name of the Instrument*,
   *Quantity*, *Market/Fair Value*, *% to Net Assets*, and *Industry*.
2. Keeps only rows whose ISIN matches `INE` + 9 characters (skips subtotals,
   section headers, and non-`INE` instruments).
3. **Market value is in lakhs** in the file → multiplied by 100000 to store plain
   rupees. Empty/`NIL` cells become `null`, never `0`.
4. **% to Net Assets** is read honouring the cell's number format: some houses
   store an Excel fraction (`0.0587` shown as `5.87%`), others the plain number
   `5.87`. The value always lands in `0`–`100`.

See [`scripts/ingest.ts`](../scripts/ingest.ts) and the "Data ingestion" section
of [`CLAUDE.md`](../CLAUDE.md).
