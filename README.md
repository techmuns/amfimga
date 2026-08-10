# AMFIMGA

A private dashboard that tracks how **India's mutual funds buy and sell stocks,
month by month**. Every month, funds disclose their holdings; by comparing one
month to the next across the whole market, the dashboard will surface where the
"smart money" is quietly moving in or out. Data originates from **AdvisorKhoj**.

> **Status: Step 1 of ~7 — project setup only.** This step scaffolds the app,
> the runtime data format, and the password gate. Data downloading, analysis, and
> the dashboard screens come in later steps.

## Stack

React 19 + TypeScript + Tailwind CSS v4, built with Vite, deployed as a
**Cloudflare Worker**. The Worker also enforces a single-password gate over the
entire site — including the data files.

## Quick start

```bash
npm install

# 1. Create local secrets (git-ignored)
cp .dev.vars.example .dev.vars
#    then edit .dev.vars — the default dev password is "amfimga-dev"

# 2. Run the dev server (Vite + Worker)
npm run dev
#    open the URL, sign in, and the app loads
```

Other commands:

```bash
npm run build     # type-check (tsc -b) + vite build → dist/
npm run preview   # serve the production build through the Worker locally
npm run deploy    # build, then wrangler deploy
```

## Deploying to Cloudflare

Set the real secrets on the Worker (do **not** commit them):

```bash
npx wrangler secret put APP_PASSWORD     # the site password
npx wrangler secret put SESSION_SECRET   # random string; e.g. openssl rand -hex 32
npm run deploy
```

In production `DEV_MODE` is unset, so **every** request — pages, scripts, and
`/data/*.json` — requires a valid login. The gate fails closed: if the secrets
are missing, no one gets in.

## How it's organized

See **[CLAUDE.md](./CLAUDE.md)** for the project guide (the five rules every step
must follow, the data shape, and the layout) and
**[docs/data-format.md](./docs/data-format.md)** for the on-disk data format.

The five rules in brief:

1. Data loads from separate files at runtime — never baked into the code.
2. Unknown values show a dash `—`, never a fake `0` or a guess.
3. Money is stored as plain whole rupees; formatted only for display.
4. Stocks are identified by **ISIN**, never by name.
5. The whole site sits behind one password, enforced in the Worker.
