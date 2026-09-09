/**
 * Cloudflare Worker — static-asset server for AMFIMGA, plus the (optional)
 * email-digest API.
 *
 * The dashboard is a public static site (no login): the monthly holdings data is
 * public disclosure, so there is nothing to gate. This Worker is a thin
 * pass-through to the static assets binding, with single-page-app fallback
 * handled by the assets config in wrangler.jsonc.
 *
 * ADDITIVE: requests under `/api/*` are handled by the email-digest feature
 * (subscribe / unsubscribe / run-digests / send-now). Everything there degrades
 * gracefully when its KV/secret isn't configured, so the dashboard is never
 * affected. All other requests are served unchanged from ASSETS.
 */
import type { Env } from "./types.ts";
import { handleApi } from "./api.ts";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const api = await handleApi(request, env);
    if (api) return api;
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
