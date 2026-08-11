import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

// The Cloudflare plugin wires the Worker in `worker/index.ts` together with the
// Vite-built client assets, both in dev (Miniflare) and for `wrangler deploy`.
export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
});
