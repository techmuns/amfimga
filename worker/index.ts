/**
 * Cloudflare Worker — static-asset server for AMFIMGA.
 *
 * The dashboard is a public static site (no login): the monthly holdings data
 * is public disclosure, so there is nothing to gate. This Worker is a thin
 * pass-through to the static assets binding, with single-page-app fallback
 * handled by the assets config in wrangler.jsonc.
 */

interface Env {
  /** Static assets binding (the Vite-built client + /data files). */
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
