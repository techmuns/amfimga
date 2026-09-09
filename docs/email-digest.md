# Email digest — the AMFIMGA "Brief"

An **additive, optional** feature: a reader can subscribe to a monthly email
digest of what India's mutual funds bought and sold. It never changes the data or
analysis, and it degrades gracefully — if storage or the email secret isn't
configured, the dashboard runs exactly as before and the API returns a clean
"not-configured" reason instead of failing.

## What the reader gets

A top-bar **✉ Brief** button opens a slide-in panel: email · **Every weekday /
Every day** · time (IST) · which sections to include (Top buys & sells · Market
flows · High-conviction · Brand-new entries) · **Subscribe**. There's also an
**"Email me this now"** one-off send. One-click **unsubscribe** is in every email.

The email is rendered in the **Munshot newspaper house style** (matching the
sibling dashboards): cream paper, serif **MUNSHOT** masthead + double rule,
Georgia headlines, a dark *"Powered by Munshot · muns.io"* footer — with AMFIMGA
as the edition and its own green-in / red-out money colours.

## When it sends ("only when the data changes")

The holdings update ~monthly (the AMFIBEAS sync). So the digest is gated on a
**content signature** (a sha256 of the month's key numbers). A subscriber is
emailed only when that signature differs from the one they last received —
i.e. when a **new month or shifted coverage** lands. Result: one email when fresh
data arrives, never a daily repeat. `SEND_EMPTY=true` overrides for testing.

Due logic (IST, fixed +5:30 — India has no DST): day matches frequency **and**
now ≥ their time **and** not already sent today **and** the signature changed.

## Pieces

| Piece | File |
| --- | --- |
| Worker router (`/api/*`, else static) | `worker/index.ts` |
| API handlers | `worker/api.ts` |
| Digest model + signature + email HTML | `worker/digest.ts` |
| KV helpers | `worker/store.ts` |
| Types / bindings | `worker/types.ts` |
| Subscribe panel (UI) | `src/components/BriefPanel.tsx` |
| Hourly trigger | `.github/workflows/email-digests.yml` |

### Endpoints

- `POST /api/subscribe` — `{ email, frequency, timeIST, sections }` → saves it.
- `GET  /api/unsubscribe?token=…` — one-click, deletes the subscription.
- `POST /api/run-digests` — **locked** behind `DIGEST_KEY` (`x-digest-key`
  header). Emails everyone due. Idempotent.
- `POST /api/send-now` — `{ email, sections? }`, rate-limited 3/email/hour.
- `GET  /api/health` — `{ ok, storage, email }` (whether KV / token are set).

### KV layout

- `sub:<sha256(email)>` → subscription JSON
- `unsub:<token>` → the sub key (reverse lookup for one-click unsubscribe)
- `sendnow:<hash>:<hour>` → count (send-now rate limit, 1-hour TTL)

## One-time setup (do once → automatic forever)

Deploy is **push-to-main auto-deploy** via the connected repo — no manual deploy
step, no deploy secrets in the repo.

1. **Connect the repo to Cloudflare** (Workers Builds → this GitHub repo). Set the
   build command to `npm run derive && npm run derive:aifpms && npm run build`
   and the deploy command to `npx wrangler deploy`. Every push to `main` now
   builds + deploys automatically.
2. **Create the KV namespace** and bind it:
   ```
   npx wrangler kv namespace create DIGEST_KV
   ```
   Uncomment the `kv_namespaces` block in `wrangler.jsonc` and paste the `id`.
3. **Set the Worker secrets** (Cloudflare dashboard → the Worker → Settings →
   Variables, or the CLI):
   ```
   npx wrangler secret put MUNS_TOKEN     # Munshot email bearer token
   npx wrangler secret put DIGEST_KEY     # a long random string
   ```
   Optional vars: `SITE_URL` (canonical origin for links), `MUNS_EMAIL_ENDPOINT`
   (defaults to `https://devde.muns.io/email/send/raw`), `SEND_EMPTY`.
4. **Add the GitHub Actions secrets** (repo → Settings → Secrets → Actions):
   - `DIGEST_KEY` — the **same** value as the Worker secret.
   - `SITE_URL` — the deployed site origin, e.g. `https://amfimga.<account>.workers.dev`.

That's it. The hourly workflow then pokes `/api/run-digests`, and the Worker
emails everyone due whenever a new month's data lands.

## Local dev

`cp .dev.vars.example .dev.vars`, fill what you want, then `npm run dev`. Check
`GET /api/health`. To preview the email itself without sending, the digest
renderer is a pure module (`worker/digest.ts`) you can import from a script.
