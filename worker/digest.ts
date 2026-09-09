/**
 * The digest engine — PURE, no Cloudflare/DOM APIs except Web Crypto (which
 * exists in both Workers and Node, so the same code renders the email preview).
 *
 * It turns the four served summaries into:
 *   1. a small MODEL of "what India's mutual funds did this month",
 *   2. a content SIGNATURE (sha256) used as the "only email when something
 *      actually changed" gate, and
 *   3. an email-safe HTML digest in the MUNSHOT newspaper house style (cream
 *      paper, serif MUNSHOT masthead + double rule, dark "Powered by Munshot ·
 *      muns.io" footer) — matching the sibling Munshot dashboards — with
 *      AMFIMGA as the edition and its own green-in / red-out money colours.
 *
 * Everything is coverage-aware already (the summaries are), so we only pick,
 * sort and format — never invent a number (Rule 2), never treat a missing house
 * as a sell.
 */
import type {
  ConsensusEntry,
  DashboardData,
  MarketCap,
  SectionKey,
  StockRow,
  TrendsetterEntry,
} from "./types.ts";

// --- formatting (mirrors src/lib/format.ts) --------------------------------

const DASH = "—";

/** Signed share-change, compacted to crore/lakh, e.g. 143918025 -> "+14.4 Cr". */
export function formatSignedCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return DASH;
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  const abs = Math.abs(value);
  if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(1)} Cr`;
  if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(1)} L`;
  return `${sign}${abs.toLocaleString("en-IN")}`;
}

/** Plain whole rupees -> compact Indian string, e.g. 40392308300000 -> "₹40.4 L Cr". */
export function formatInr(rupees: number | null | undefined): string {
  if (rupees == null || !Number.isFinite(rupees)) return DASH;
  const sign = rupees < 0 ? "-" : "";
  const abs = Math.abs(rupees);
  if (abs >= 1e12) return `${sign}₹${(abs / 1e12).toFixed(1)} L Cr`;
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(1)} Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(1)} L`;
  return `${sign}₹${abs.toLocaleString("en-IN")}`;
}

/** Escape a string for safe interpolation into HTML. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// --- the model -------------------------------------------------------------

interface Move {
  isin: string;
  name: string;
  sector: string | null;
  net: number;
  fundCount: number | null;
}
interface SectorFlow {
  sector: string;
  net: number;
}

export interface DigestModel {
  month: string;
  monthLabel: string;
  generatedAt: string;
  coverage: { present: number; total: number; delta: number | null };
  totals: { fundCount: number; stockCount: number; equityValueInr: number | null };
  breadth: { bought: number; sold: number };
  topBuys: Move[];
  topSells: Move[];
  sectorsIn: SectorFlow[];
  sectorsOut: SectorFlow[];
  capFlows: { cap: MarketCap; net: number }[];
  newEntries: Move[];
  trendsetters: TrendsetterEntry[];
  consensus: ConsensusEntry[];
  consensusOf: number;
}

const CAP_ORDER: MarketCap[] = ["large", "mid", "small"];
const CAP_LABEL: Record<MarketCap, string> = { large: "Large cap", mid: "Mid cap", small: "Small cap" };

const toMove = (s: StockRow, L: number, net: number): Move => ({
  isin: s.isin,
  name: s.name,
  sector: s.macroSector,
  net,
  fundCount: s.fundCount[L] ?? null,
});

/** Build the digest model from the four served summaries. */
export function buildDigestModel(data: DashboardData): DigestModel {
  const { summary, stocks, sectors, funds } = data;
  const L = stocks.months.length - 1;
  const meta = summary.months[summary.months.length - 1];
  const prev = summary.months[summary.months.length - 2];
  const rows = stocks.stocks;

  const withNet = rows
    .map((s) => ({ s, net: s.netShareChange[L] }))
    .filter((x): x is { s: StockRow; net: number } => x.net != null && x.net !== 0);

  const topBuys = withNet
    .filter((x) => x.net > 0)
    .sort((a, b) => b.net - a.net)
    .slice(0, 6)
    .map((x) => toMove(x.s, L, x.net));
  const topSells = withNet
    .filter((x) => x.net < 0)
    .sort((a, b) => a.net - b.net)
    .slice(0, 6)
    .map((x) => toMove(x.s, L, x.net));

  const sectorFlows = sectors.sectors
    .map((r) => ({ sector: r.sector, net: r.netShareChange[sectors.months.length - 1] }))
    .filter((x): x is SectorFlow => x.net != null && x.net !== 0);
  const sectorsIn = sectorFlows.filter((x) => x.net > 0).sort((a, b) => b.net - a.net).slice(0, 6);
  const sectorsOut = sectorFlows.filter((x) => x.net < 0).sort((a, b) => a.net - b.net).slice(0, 3);

  const capSum = new Map<MarketCap, number>();
  let bought = 0, sold = 0, equity = 0, hasEquity = false;
  for (const s of rows) {
    const n = s.netShareChange[L];
    if (n != null) {
      if (n > 0) bought++;
      else if (n < 0) sold++;
      if (s.marketCap) capSum.set(s.marketCap, (capSum.get(s.marketCap) ?? 0) + n);
    }
    const v = s.totalValueInr[L];
    if (v != null) { equity += v; hasEquity = true; }
  }
  const capFlows = CAP_ORDER.filter((c) => capSum.has(c)).map((cap) => ({ cap, net: capSum.get(cap)! }));

  // Brand-new to mutual funds this month, preferring established names over fresh IPOs
  // (an old company funds are buying for the FIRST time is the strong signal).
  const entriesAll = rows.filter((s) => s.newEntry).map((s) => toMove(s, L, s.netShareChange[L] ?? 0));
  const established = entriesAll.filter((m) => {
    const row = rows.find((r) => r.isin === m.isin);
    return row?.recentIpo !== true;
  });
  const newEntries = (established.length ? established : entriesAll)
    .sort((a, b) => b.net - a.net)
    .slice(0, 5);

  return {
    month: meta.month,
    monthLabel: meta.label,
    generatedAt: summary.generatedAt,
    coverage: {
      present: meta.housesPresent,
      total: meta.housesTotal,
      delta: prev ? meta.housesPresent - prev.housesPresent : null,
    },
    totals: { fundCount: meta.fundCount, stockCount: meta.stockCount, equityValueInr: hasEquity ? equity : null },
    breadth: { bought, sold },
    topBuys,
    topSells,
    sectorsIn,
    sectorsOut,
    capFlows,
    newEntries,
    trendsetters: (funds?.trendsetters ?? []).slice(0, 3),
    consensus: (funds?.consensus ?? []).slice(0, 6),
    consensusOf: funds?.consensusOf ?? 0,
  };
}

/** True when the month has enough to be worth an email at all. */
export function hasContent(m: DigestModel): boolean {
  return m.topBuys.length > 0 || m.topSells.length > 0 || m.sectorsIn.length > 0 || m.sectorsOut.length > 0;
}

/**
 * Content signature — the "only email when something changed" gate. Built from
 * the numbers that actually make this month's story, so a re-derive of identical
 * data yields the SAME version (no email), while a new month or shifted coverage
 * yields a new one (one email).
 */
export async function digestVersion(m: DigestModel): Promise<string> {
  const canon = [
    m.month,
    `h${m.coverage.present}/${m.coverage.total}`,
    `b${m.breadth.bought}/${m.breadth.sold}`,
    "buy:" + m.topBuys.map((x) => `${x.isin}=${x.net}`).join(","),
    "sell:" + m.topSells.map((x) => `${x.isin}=${x.net}`).join(","),
    "sin:" + m.sectorsIn.map((x) => `${x.sector}=${x.net}`).join(","),
    "sout:" + m.sectorsOut.map((x) => `${x.sector}=${x.net}`).join(","),
  ].join("|");
  const bytes = new TextEncoder().encode(canon);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- email rendering — Munshot newspaper house style -----------------------

/** Munshot newspaper palette (shared with the sibling Munshot dashboards). */
const C = {
  ink: "#1a1712",
  paper: "#fbf9f3",
  cream: "#f2eee3",
  rule: "#d9d2c2",
  meta: "#8a8272",
  soft: "#4a4438",
  link: "#b4531f",
  buy: "#1a7d33",
  sell: "#bf3d30",
  gold: "#a9812f",
} as const;
const SERIF = `Georgia,'Times New Roman',serif`;
const SANS = `Arial,Helvetica,sans-serif`;

function formatTimeIST(hhmm?: string): string {
  const [h, m] = (hhmm ?? "09:00").split(":").map(Number);
  const ap = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m ?? 0).padStart(2, "0")} ${ap}`;
}

function dot(color: string, size = 9): string {
  return `<span style="display:inline-block;width:${size}px;height:${size}px;background:${color};border-radius:50%;vertical-align:middle;"></span>`;
}

/** A newspaper section tag (white uppercase on a colour block). */
function tag(label: string, color: string): string {
  return `<span style="display:inline-block;background:${color};color:#ffffff;font-family:${SANS};font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;padding:4px 12px;">${esc(label)}</span>`;
}

function section(label: string, color: string, note: string, innerRows: string): string {
  return `
    <tr><td style="padding:22px 0 2px;">${tag(label, color)}</td></tr>
    ${note ? `<tr><td style="font-family:${SANS};font-size:12px;color:${C.meta};padding:5px 0 0;">${esc(note)}</td></tr>` : ""}
    <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${innerRows}</table></td></tr>`;
}

function moveRow(m: Move, color: string): string {
  return `
    <tr><td style="padding:11px 0;border-bottom:1px solid ${C.rule};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="font-family:${SERIF};font-size:16px;font-weight:bold;color:${C.ink};line-height:1.3;">${esc(m.name)}
          <div style="font-family:${SANS};font-size:11px;color:${C.meta};padding-top:4px;font-weight:normal;">${m.sector ? `${dot(color, 7)} ${esc(m.sector)}` : ""}${m.fundCount != null ? ` &nbsp;·&nbsp; ${m.fundCount} funds` : ""}</div>
        </td>
        <td align="right" valign="top" style="font-family:${SANS};font-size:16px;font-weight:bold;color:${color};white-space:nowrap;padding-left:12px;">${esc(formatSignedCount(m.net))}</td>
      </tr></table>
    </td></tr>`;
}

function sectorBar(sector: string, net: number, maxAbs: number, color: string): string {
  const pct = Math.max(4, Math.round((Math.abs(net) / maxAbs) * 100));
  const arrow = net > 0 ? "▲" : "▼";
  return `
    <tr><td style="padding:9px 0 3px;">
      <span style="font-family:${SANS};font-size:12px;color:${C.ink};">${esc(sector)}</span>
      <span style="float:right;font-family:${SANS};font-size:12px;font-weight:bold;color:${color};">${arrow} ${esc(formatSignedCount(net))}</span>
    </td></tr>
    <tr><td style="padding-bottom:7px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${C.cream};">
        <tr><td>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${pct}%" style="min-width:8px;">
            <tr><td style="background:${color};height:6px;line-height:6px;font-size:0;">&nbsp;</td></tr>
          </table>
        </td></tr>
      </table>
    </td></tr>`;
}

export interface RenderOpts {
  sections: SectionKey[];
  unsubUrl: string;
  siteUrl: string;
  /** Subscriber cadence + time, for the footer line. */
  frequency?: "weekdays" | "daily";
  timeIST?: string;
}

/** Render the digest email in the Munshot newspaper house style. */
export function renderEmail(m: DigestModel, opts: RenderOpts): { subject: string; html: string } {
  const want = (k: SectionKey) => opts.sections.includes(k);
  const cov = m.coverage;
  const covDelta = cov.delta == null || cov.delta === 0 ? "" : ` (${cov.delta > 0 ? "+" : "−"}${Math.abs(cov.delta)})`;

  const subject = m.topBuys[0]
    ? `AMFIMGA · ${m.monthLabel} — funds pile into ${m.topBuys[0].name}`
    : `AMFIMGA · ${m.monthLabel} — mutual fund money moves`;
  const preheader = `Where India's mutual funds moved in ${m.monthLabel} — ${cov.present} of ${cov.total} houses in. ${m.breadth.bought} bought, ${m.breadth.sold} sold.`;

  const lead =
    m.topBuys[0] && m.topSells[0]
      ? `In ${m.monthLabel}, India's mutual funds added the most to ${m.topBuys[0].name} and cut ${m.topSells[0].name} the hardest.`
      : m.topBuys[0]
      ? `In ${m.monthLabel}, India's mutual funds added the most to ${m.topBuys[0].name}.`
      : `Fresh mutual-fund holdings just landed for ${m.monthLabel}.`;

  const busiest = m.sectorsIn[0]?.sector ?? m.sectorsOut[0]?.sector ?? "—";
  const stats = `
    <tr><td style="padding:16px 0 2px;font-family:${SANS};font-size:12px;color:${C.soft};line-height:1.9;">
      ${dot(C.buy)} <b>${m.breadth.bought.toLocaleString("en-IN")}</b> bought &nbsp;&nbsp;
      ${dot(C.sell)} <b>${m.breadth.sold.toLocaleString("en-IN")}</b> sold &nbsp;&nbsp;
      <span style="color:${C.meta};">busiest sector:</span> <b>${esc(busiest)}</b>
    </td></tr>`;

  const blocks: string[] = [];

  if (want("movers")) {
    if (m.topBuys.length) blocks.push(section("Top net buys", C.buy, "Biggest coverage-aware share additions this month", m.topBuys.map((x) => moveRow(x, C.buy)).join("")));
    if (m.topSells.length) blocks.push(section("Top net sells", C.sell, "Biggest share reductions this month", m.topSells.map((x) => moveRow(x, C.sell)).join("")));
  }

  if (want("flows") && (m.sectorsIn.length || m.sectorsOut.length)) {
    const maxAbs = Math.max(1, ...m.sectorsIn.map((s) => s.net), ...m.sectorsOut.map((s) => Math.abs(s.net)));
    const bars =
      m.sectorsIn.map((s) => sectorBar(s.sector, s.net, maxAbs, C.buy)).join("") +
      m.sectorsOut.map((s) => sectorBar(s.sector, s.net, maxAbs, C.sell)).join("");
    const capLine = m.capFlows.length
      ? `<tr><td style="padding:8px 0 0;font-family:${SANS};font-size:12px;color:${C.soft};">By cap band &nbsp;` +
        m.capFlows.map((c) => `<b style="color:${c.net >= 0 ? C.buy : C.sell};">${esc(CAP_LABEL[c.cap])} ${esc(formatSignedCount(c.net))}</b>`).join(" &nbsp;·&nbsp; ") +
        `</td></tr>`
      : "";
    blocks.push(section("Where the money moved", C.ink, "Net share change by macro sector · green in, red out", `${bars}${capLine}`));
  }

  if (want("conviction") && (m.consensus.length || m.trendsetters.length)) {
    let inner = "";
    if (m.consensus.length) {
      inner += m.consensus
        .map(
          (c) => `<tr><td style="padding:9px 0;border-bottom:1px solid ${C.rule};">
            <span style="font-family:${SERIF};font-size:15px;font-weight:bold;color:${C.ink};">${esc(c.name)}</span>
            <span style="font-family:${SANS};font-size:12px;color:${C.meta};"> &mdash; held by ${c.heldBy} of ${m.consensusOf} top funds, ${c.adding} still adding</span>
          </td></tr>`,
        )
        .join("");
    }
    if (m.trendsetters.length) {
      inner += `<tr><td style="padding:12px 0 2px;font-family:${SANS};font-size:11px;letter-spacing:1px;text-transform:uppercase;color:${C.meta};">Funds that tend to buy before the crowd</td></tr>`;
      inner += m.trendsetters
        .map(
          (t) => `<tr><td style="padding:8px 0;border-bottom:1px solid ${C.rule};">
            <span style="font-family:${SERIF};font-size:15px;font-weight:bold;color:${C.ink};">${esc(t.name)}</span>
            <span style="font-family:${SANS};font-size:12px;color:${C.meta};"> &mdash; early on ${t.score} of ${t.evaluated}${t.examples.length ? `, e.g. ${esc(t.examples.slice(0, 2).join(", "))}` : ""}</span>
          </td></tr>`,
        )
        .join("");
    }
    blocks.push(section("High-conviction", C.link, "What the biggest active funds commonly own", inner));
  }

  if (want("entries") && m.newEntries.length) {
    const inner = m.newEntries
      .map(
        (e) => `<tr><td style="padding:9px 0;border-bottom:1px solid ${C.rule};">
          <span style="font-family:${SERIF};font-size:15px;font-weight:bold;color:${C.ink};">${esc(e.name)}</span>
          ${e.sector ? `<span style="font-family:${SANS};font-size:11px;color:${C.meta};"> &nbsp;${dot(C.gold, 7)} ${esc(e.sector)}</span>` : ""}
          <span style="float:right;font-family:${SANS};font-size:13px;font-weight:bold;color:${C.buy};">${esc(formatSignedCount(e.net))}</span>
        </td></tr>`,
      )
      .join("");
    blocks.push(section("Brand-new entries", C.gold, "Stocks mutual funds bought for the first time", inner));
  }

  const content = blocks.length
    ? stats + blocks.join("")
    : `<tr><td style="padding:26px 0;text-align:center;"><div style="font-family:${SERIF};font-size:20px;font-style:italic;color:${C.soft};">Fresh holdings just landed for ${esc(m.monthLabel)}.</div></td></tr>`;

  const cadence = opts.frequency === "daily" ? "every day" : "every weekday";
  const timeLabel = formatTimeIST(opts.timeIST);

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.cream};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.cream}" style="background:${C.cream};">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:640px;background:${C.paper};border:1px solid ${C.rule};">

      <!-- MASTHEAD -->
      <tr><td style="padding:30px 34px 0;text-align:center;">
        <div style="font-family:${SERIF};font-size:34px;font-weight:bold;letter-spacing:7px;color:${C.ink};padding-left:7px;">MUNSHOT</div>
        <div style="border-top:3px double ${C.ink};margin:12px 0 7px;"></div>
        <div style="font-family:${SANS};font-size:11px;letter-spacing:4px;text-transform:uppercase;color:${C.meta};">AMFIMGA — India's Mutual-Fund Money Flows</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;border-top:1px solid ${C.rule};border-bottom:1px solid ${C.rule};">
          <tr><td style="font-family:${SANS};font-size:11px;letter-spacing:1px;color:${C.meta};padding:7px 0;text-align:center;text-transform:uppercase;">
            ${esc(m.monthLabel)} &nbsp;·&nbsp; ${cov.present} of ${cov.total} fund houses in${covDelta} &nbsp;·&nbsp; ${m.totals.fundCount.toLocaleString("en-IN")} active funds${m.totals.equityValueInr != null ? ` &nbsp;·&nbsp; ${esc(formatInr(m.totals.equityValueInr))}` : ""}
          </td></tr>
        </table>
      </td></tr>

      <!-- LEAD -->
      <tr><td style="padding:16px 34px 0;">
        <div style="font-family:${SERIF};font-size:19px;font-style:italic;line-height:1.4;color:${C.soft};text-align:center;">${esc(lead)}</div>
      </td></tr>

      <!-- CONTENT -->
      <tr><td style="padding:0 34px 8px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${content}</table>
      </td></tr>

      <!-- CTA -->
      <tr><td align="center" style="padding:12px 34px 26px;">
        <a href="${esc(opts.siteUrl)}" style="font-family:${SANS};font-size:13px;font-weight:bold;color:${C.link};text-decoration:none;">Read the full dashboard &rarr;</a>
      </td></tr>

      <!-- FOOTER -->
      <tr><td style="background:${C.ink};padding:22px 34px;">
        <div style="font-family:${SANS};font-size:12px;line-height:1.6;color:#d8d0be;">
          You're subscribed to the <b style="color:#f2ead6;">AMFIMGA</b> edition, ${cadence} at <b style="color:#f2ead6;">${esc(timeLabel)} IST</b>. We only email you when the monthly data actually changes.
        </div>
        <div style="font-family:${SANS};font-size:12px;padding-top:8px;">
          <a href="${esc(opts.unsubUrl)}" style="color:#e0b48c;text-decoration:underline;">Unsubscribe</a>
          <span style="color:#6b6455;">&nbsp;·&nbsp;</span>
          <a href="${esc(opts.siteUrl)}" style="color:#e0b48c;text-decoration:underline;">Open the dashboard</a>
          <span style="color:#6b6455;">&nbsp;·&nbsp;</span>
          <span style="color:#a89f8b;">Powered by <b style="color:#e8dfca;letter-spacing:1px;">Munshot</b> · muns.io</span>
        </div>
        <div style="font-family:${SANS};font-size:10px;color:#6b6455;padding-top:10px;line-height:1.5;">
          Holdings from official monthly fund disclosures · coverage-aware (a missing house is never a sell). Informational, not investment advice.
        </div>
      </td></tr>

    </table>
    <div style="font-family:${SANS};font-size:10px;color:#a49b88;padding:12px 0 0;">AMFIMGA by Munshot</div>
  </td></tr>
</table>
</body></html>`;

  return { subject, html };
}
