/**
 * Fetch AMFI's half-yearly "List of Stocks for classification — Large / Mid /
 * Small Cap" and write an ISIN → cap map to data/marketcap.json (an input to
 * derive, not served). Run with `npm run marketcap`.
 *
 * AMFI publishes one file every six months (June / December). The file lists
 * every listed company with its ISIN and an explicit "Categorization" column
 * (Large Cap ranks 1–100, Mid Cap 101–250, Small Cap 251+). We match to our
 * stocks by ISIN, so nothing is guessed.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { ProxyAgent, setGlobalDispatcher } from "undici";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT = resolve(ROOT, "data/marketcap.json");
const PAGE = "https://www.amfiindia.com/otherdata/categorisation-of-stocks";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

configureProxy();

type Cap = "large" | "mid" | "small";

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.text();
}
async function getBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const norm = (v: unknown): string => String(v ?? "").replace(/\s+/g, " ").trim().toLowerCase();

function capFromText(s: string): Cap | null {
  const t = s.toLowerCase();
  if (t.includes("large")) return "large";
  if (t.includes("mid")) return "mid";
  if (t.includes("small")) return "small";
  return null;
}

async function main() {
  console.log("Fetching AMFI categorisation page…");
  const html = await getText(PAGE);
  // Newest market-cap workbook is listed first on the page.
  const links = [...html.matchAll(/href="([^"]+AverageMarketCapitali[^"]+\.xlsx)"/gi)].map((m) => m[1]);
  if (links.length === 0) throw new Error("No market-cap .xlsx link found on the AMFI page");
  const fileUrl = links[0].startsWith("http") ? links[0] : new URL(links[0], PAGE).href;
  console.log(`Latest list: ${fileUrl}`);

  const buf = await getBuffer(fileUrl);
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false, defval: null });

  // Header row + title (for asOf).
  const asOf = String(rows[0]?.[0] ?? "").replace(/\s+/g, " ").trim();
  let hr = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    if ((rows[i] || []).some((c) => norm(c).includes("isin"))) { hr = i; break; }
  }
  if (hr < 0) throw new Error("Could not find the header row (no ISIN column)");
  const header = rows[hr] || [];
  const isinCol = header.findIndex((c) => norm(c).includes("isin"));
  const catCol = header.findIndex((c) => norm(c).includes("categor"));
  const nseCol = header.findIndex((c) => norm(c) === "nse symbol");
  if (isinCol < 0 || catCol < 0) throw new Error("Missing ISIN or Categorization column");

  const caps: Record<string, Cap> = {};
  const symbols: Record<string, string> = {}; // ISIN → NSE symbol (handy for future name matching)
  const tally = { large: 0, mid: 0, small: 0 };
  for (let i = hr + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const isin = String(row[isinCol] ?? "").trim().toUpperCase();
    if (!/^INE[A-Z0-9]{9}$/.test(isin)) continue;
    const cap = capFromText(String(row[catCol] ?? ""));
    if (!cap) continue;
    caps[isin] = cap;
    tally[cap]++;
    if (nseCol >= 0) {
      const sym = String(row[nseCol] ?? "").trim();
      if (sym && sym !== "-") symbols[isin] = sym;
    }
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      { source: "AMFI — categorisation of stocks", asOf, url: fileUrl, generatedAt: new Date().toISOString(), counts: tally, caps, symbols },
      null,
      0,
    ) + "\n",
  );
  console.log(`Wrote ${OUT}: ${Object.keys(caps).length} stocks (${tally.large} large, ${tally.mid} mid, ${tally.small} small). asOf: ${asOf}`);
}

function configureProxy(): void {
  const p = readEnv();
  const proxy = p.HTTPS_PROXY || p.https_proxy || p.HTTP_PROXY || p.http_proxy;
  if (!proxy) return;
  const caPath = "/root/.ccr/ca-bundle.crt";
  const ca = existsSync(caPath) ? readFileSync(caPath, "utf8") : undefined;
  setGlobalDispatcher(new ProxyAgent({ uri: proxy, requestTls: ca ? { ca } : undefined }));
}
function readEnv(): NodeJS.ProcessEnv {
  return process.env;
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
