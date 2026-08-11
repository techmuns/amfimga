/**
 * PDF export — the "report edition" (Step: polish + export).
 *
 * NOT a screenshot of the app. Builds a print-optimised, paginated editorial
 * broadsheet (warm cream paper, self-hosted Playfair Display + Source Serif 4,
 * small-caps section labels, bordered panels, black-header zebra league tables,
 * coloured bar+track charts, a BY THE NUMBERS sidebar, per-page footers) from the
 * loaded summaries, then prints it to PDF via the browser (@page). Presentation
 * only — no data or analysis changes. Buy = green, sell = red, "—" for unknown,
 * coverage-honest throughout.
 */
import type { SectorSummary, StocksSummary, SummaryMeta } from "../types/holdings";
import { buildReport, CAP_LABEL, type Move, type ReportModel } from "./report";

const CR = 1e7, L = 1e5;
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const mag = (v: number): string => { const a = Math.abs(v); return a >= CR ? `${(a / CR).toFixed(1)} Cr` : a >= L ? `${(a / L).toFixed(1)} L` : a.toLocaleString("en-IN"); };
const signedCr = (v: number | null): string => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${mag(v)}`);
const arrow = (v: number | null): string => (v == null ? "" : v > 0 ? "▲" : v < 0 ? "▼" : "");
const int = (v: number | null | undefined): string => (v == null ? "—" : Math.round(v).toLocaleString("en-IN"));

// Editorial palette (aligns with the app's sector palette).
const PAL = ["#2a5db0", "#df6327", "#178a6e", "#c8891f", "#c85b86", "#1b7a3d", "#6a3fa0", "#c0392b"];
const GREEN = "#0c8a0c", RED = "#c0392b", INK = "#1b1913", AMBER = "#a9781d", TRACK = "#e7e1d3";

type ColorOf = (sector: string | null) => string;

/** The full standalone HTML document for the report. Exported for headless render. */
export function reportHtml(model: ReportModel, colorOf: ColorOf): string {
  const N = 4;
  const pages = [frontPage(model), flowsPage(model, colorOf, 2, N), sectorsPage(model, colorOf, 3, N), ideasPage(model, colorOf, 4, N)];
  // Front page footer needs the count too:
  const front = pages[0].replace("__FOOTER__", footer(model, "Front page", 1, N));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Mutual Fund Ownership Insights — ${esc(model.monthLabel)}</title>
<link rel="stylesheet" href="/fonts/report-fonts.css">
<style>${CSS}</style></head><body>${front}${pages.slice(1).join("")}</body></html>`;
}

/** Build the model, open a print window, and print to PDF. */
export function exportPdf(summary: SummaryMeta, stocks: StocksSummary, sectors: SectorSummary, colorOf: ColorOf): void {
  const model = buildReport(summary, stocks, sectors);
  const html = reportHtml(model, colorOf);
  const w = window.open("", "_blank");
  if (!w) { alert("Please allow pop-ups to export the PDF report."); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
  const go = () => setTimeout(() => { w.focus(); w.print(); }, 350);
  const doc = w.document as Document & { fonts?: FontFaceSet };
  if (doc.fonts) { doc.fonts.ready.then(go).catch(go); } else { w.onload = go; setTimeout(go, 1200); }
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

const dot = (color: string): string => `<span class="dot" style="background:${color}"></span>`;

function sectionHead(color: string, label: string, meta: string): string {
  return `<div class="sec-head"><div class="sec-label" style="color:${color}">${dot(color)}${esc(label)}</div><div class="sec-meta">${esc(meta)}</div></div>`;
}

function footer(model: ReportModel, section: string, page: number, n: number): string {
  return `<div class="foot"><span>MF OWNERSHIP INSIGHTS · ${esc(model.monthLabel).toUpperCase()}</span><span>${esc(section).toUpperCase()}</span><span>PAGE ${page} OF ${n}</span></div>`;
}

/** Horizontal bar rows: coloured bar + grey track + end value (+ arrow). */
function bars(rows: { label: string; value: number; color: string; signed?: boolean }[], opts: { labelW?: number } = {}): string {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  const lw = opts.labelW ?? 118;
  return `<div class="bars">${rows.map((r) => {
    const w = Math.max(2, (Math.abs(r.value) / max) * 100);
    const val = r.signed ? `${arrow(r.value)} ${signedCr(r.value)}` : mag(r.value);
    return `<div class="bar-row" style="grid-template-columns:${lw}px 1fr auto">
      <div class="bar-label">${esc(r.label)}</div>
      <div class="track"><div class="fill" style="width:${w}%;background:${r.color}"></div></div>
      <div class="bar-val">${esc(val)}</div></div>`;
  }).join("")}</div>`;
}

/** A league table (black header, zebra, coloured rank + dot, bold right numbers). */
function league(title: string, color: string, rows: Move[], colorOf: ColorOf, kind: "buy" | "sell"): string {
  const body = rows.slice(0, 12).map((m, i) => {
    const c = kind === "buy" ? GREEN : RED;
    return `<tr>
      <td class="rank" style="color:${AMBER}">${i + 1}</td>
      <td class="name">${dot(colorOf(m.macroSector))}<span>${esc(m.name)}</span></td>
      <td class="num" style="color:${c};font-weight:600">${arrow(m.net)} ${signedCr(m.net)}</td>
      <td class="num">${int(m.fundCount)}</td></tr>`;
  }).join("");
  return `<div class="ltable"><div class="ltable-cap" style="color:${color};border-color:${color}">${esc(title)}</div>
    <table><thead><tr><th>#</th><th style="text-align:left">Stock</th><th>Net · shares</th><th>Funds</th></tr></thead>
    <tbody>${body || `<tr><td colspan="4" class="empty">—  none this month</td></tr>`}</tbody></table></div>`;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function frontPage(m: ReportModel): string {
  const numbers: [string, string][] = [
    ["Stocks tracked", int(m.stockCount)],
    ["Funds (schemes)", int(m.fundCount)],
    ["Fund houses", `${m.housesPresent} of ${m.housesTotal}`],
    ["Stocks bought", int(m.breadth.bought)],
    ["Stocks sold", int(m.breadth.sold)],
    ["Biggest net buy", m.biggestBuy ? signedCr(m.biggestBuy.net) : "—"],
    ["Biggest net sell", m.biggestSell ? signedCr(m.biggestSell.net) : "—"],
    ["Leading sector", m.leadingSector ? m.leadingSector.sector : "—"],
  ];
  const sidebar = `<div class="panel sidebar"><div class="sidebar-head">BY THE NUMBERS <span>${esc(m.monthLabel)}</span></div>
    ${numbers.map(([k, v]) => `<div class="kv"><span class="k">${esc(k)}</span><span class="leader"></span><span class="v">${esc(v)}</span></div>`).join("")}</div>`;

  const hero = `<div class="panel hero"><div class="panel-head"><span>THE MONTH'S FLOWS · NET SHARES BY SECTOR</span><span class="muted">SELLING ← → BUYING</span></div>
    ${bars(m.sectors.slice(0, 6).map((s) => ({ label: s.sector, value: s.net, color: s.net >= 0 ? GREEN : RED, signed: true })), { labelW: 150 })}</div>`;

  const bb = m.biggestBuy, bs = m.biggestSell;
  const headline = bb ? `${esc(bb.name.split(" ").slice(0, 3).join(" "))} Leads the Month's Buying` : "Where India's Funds Moved";
  const deck = `Across ${m.housesPresent} of ${m.housesTotal} fund houses, mutual funds net-bought ${int(m.breadth.bought)} stocks and net-sold ${int(m.breadth.sold)} — a coverage-aware read of where the smart money shifted in ${esc(m.monthLabel)}.`;
  const p1 = bb && bs
    ? `The clearest accumulation this month is <b>${esc(bb.name)}</b>, up a net <b>${signedCr(bb.net)}</b> shares across the funds present in both months. At the other end, <b>${esc(bs.name)}</b> saw the deepest trimming at <b>${signedCr(bs.net)}</b>.`
    : `This edition reads mutual-fund ownership across the market, month over month.`;
  const p2 = m.leadingSector
    ? `By sector, <b>${esc(m.leadingSector.sector)}</b> drew the most net buying. Every figure here counts only funds whose house is present in both months — a house appearing in the data is never mistaken for buying.`
    : `Every figure counts only funds whose house is present in both months compared.`;

  return `<div class="page">
    <div class="masthead">
      <div class="kicker">MARKET-INTELLIGENCE EDITION · ${esc(m.monthLabel).toUpperCase()}</div>
      <div class="wordmark">MUTUAL FUND OWNERSHIP INSIGHTS</div>
      <div class="tagline">Tracking how India's mutual funds buy &amp; sell stocks, month by month</div>
    </div>
    <div class="metabar"><span>INDIA · EQUITY</span><span class="amber">AS OF ${esc(m.monthLabel).toUpperCase()} · SHARES ARE THE HERO METRIC</span><span>${esc(int(m.stockCount))} STOCKS · ${esc(int(m.fundCount))} FUNDS</span></div>
    <div class="sec-label big" style="color:${AMBER}">THE BIG STORY · NET SHARE FLOWS</div>
    <h1 class="headline">${headline}</h1>
    <div class="deck">${deck}</div>
    <div class="byline">BY THE AMFIMGA DATA DESK · SOURCED FROM OFFICIAL MONTHLY PORTFOLIO DISCLOSURES</div>
    <div class="lede">
      <div class="cols">
        <p><span class="dropcap">${bb ? esc(bb.name[0]) : "F"}</span>${p1}</p>
        <p>${p2}</p>
      </div>
      ${sidebar}
    </div>
    ${hero}
    <div class="teasers">
      ${teaser("BUYS & SELLS", "The month's league tables", "Page 2", GREEN)}
      ${teaser("SECTORS & CAP", "Where the money moved", "Page 3", PAL[0])}
      ${teaser("IDEAS", "New, turned-around, under-owned", "Page 4", PAL[2])}
      ${teaser("COVERAGE", `${m.housesPresent} of ${m.housesTotal} houses`, "Honest gaps", AMBER)}
    </div>
    __FOOTER__
  </div>`;
}

function teaser(label: string, head: string, page: string, color: string): string {
  return `<div class="teaser"><div class="t-label" style="color:${color}">${esc(label)}</div><div class="t-head">${esc(head)}</div><div class="t-page" style="color:${AMBER}">▸ ${esc(page)}</div></div>`;
}

function flowsPage(m: ReportModel, colorOf: ColorOf, page: number, n: number): string {
  const chartRows = [
    ...m.topBuys.slice(0, 6).map((x) => ({ label: x.name, value: x.net ?? 0, color: GREEN, signed: true })),
    ...m.topSells.slice(0, 6).reverse().map((x) => ({ label: x.name, value: x.net ?? 0, color: RED, signed: true })),
  ].sort((a, b) => b.value - a.value);
  return `<div class="page">
    ${sectionHead(GREEN, "THE FLOWS DESK · NET SHARE CHANGE", `HERO METRIC · SHARES · ${esc(m.monthLabel).toUpperCase()}`)}
    <h2 class="page-title">The Biggest Buys &amp; Sells of the Month</h2>
    <div class="page-deck">Ranked by coverage-aware net change in shares held — funds present in both months only.</div>
    <div class="two">
      ${league("VALUE IN · BIGGEST BUYS", GREEN, m.topBuys, colorOf, "buy")}
      ${league("VALUE OUT · BIGGEST SELLS", RED, m.topSells, colorOf, "sell")}
    </div>
    <div class="panel"><div class="panel-head"><span>THE SWING · TOP MOVES, BOTH WAYS</span><span class="muted">SELLING ← → BUYING</span></div>
      ${bars(chartRows, { labelW: 160 })}
      <div class="caption">Green = net bought, red = net sold. A house entering the data is never counted as buying.</div>
    </div>
    ${footer(m, "The Flows Desk", page, n)}
  </div>`;
}

function sectorsPage(m: ReportModel, colorOf: ColorOf, page: number, n: number): string {
  const secTable = m.sectors.map((s, i) => `<tr><td class="rank" style="color:${AMBER}">${i + 1}</td>
    <td class="name">${dot(colorOf(s.sector))}<span>${esc(s.sector)}</span></td>
    <td class="num" style="color:${s.net >= 0 ? GREEN : RED};font-weight:600">${arrow(s.net)} ${signedCr(s.net)}</td></tr>`).join("");
  const capRows = m.capFlows.map((c) => ({ label: CAP_LABEL[c.cap], value: c.net, color: c.net >= 0 ? GREEN : RED, signed: true }));
  const br = m.breadth;
  return `<div class="page">
    ${sectionHead(PAL[0], "THE SECTOR DESK · WHERE MONEY MOVED", `${esc(int(br.measured))} STOCKS MEASURED`)}
    <h2 class="page-title">Where the Money Moved</h2>
    <div class="page-deck">Net shares bought minus sold, summed by macro sector and by market-cap band.</div>
    <div class="two">
      <div class="panel"><div class="panel-head"><span>NET FLOW · BY MACRO SECTOR</span><span class="muted">SELLING ← → BUYING</span></div>
        ${bars(m.sectors.slice(0, 10).map((s) => ({ label: s.sector, value: s.net, color: s.net >= 0 ? GREEN : RED, signed: true })), { labelW: 150 })}</div>
      <div class="side">
        <div class="ltable"><div class="ltable-cap" style="color:${PAL[0]};border-color:${PAL[0]}">SECTOR LEAGUE</div>
          <table><thead><tr><th>#</th><th style="text-align:left">Sector</th><th>Net · shares</th></tr></thead><tbody>${secTable}</tbody></table></div>
        <div class="panel" style="margin-top:14px"><div class="panel-head"><span>LARGE / MID / SMALL CAP</span></div>
          ${bars(capRows, { labelW: 90 })}
          <div class="caption">Net share change by AMFI cap band.</div></div>
        <div class="panel callout" style="margin-top:14px"><div class="callout-head" style="color:${AMBER}">★ MARKET BREADTH</div>
          <div class="callout-body">Funds net-<b style="color:${GREEN}">bought ${int(br.bought)}</b> stocks and net-<b style="color:${RED}">sold ${int(br.sold)}</b> this month${br.flat ? `, with ${int(br.flat)} unchanged` : ""} — a ${br.bought >= br.sold ? "net-positive" : "net-negative"} breadth across the ${int(br.measured)} names with a comparable prior month.</div></div>
      </div>
    </div>
    ${footer(m, "The Sector Desk", page, n)}
  </div>`;
}

function ideasPage(m: ReportModel, colorOf: ColorOf, page: number, n: number): string {
  const listRows = (rows: Move[], right: (x: Move) => string, color: string) => rows.slice(0, 7).map((x) => `<div class="idea-row">
    <div class="idea-name">${dot(colorOf(x.macroSector))}<b>${esc(x.name)}</b> <span class="muted">${esc(x.macroSector ?? "—")}</span></div>
    <span class="idea-leader"></span><div class="idea-val" style="color:${color}">${right(x)}</div></div>`).join("") || `<div class="idea-empty">— none this month</div>`;
  return `<div class="page">
    ${sectionHead(PAL[2], "THE IDEAS DESK · BREAKOUTS", `${esc(m.monthLabel).toUpperCase()}`)}
    <h2 class="page-title">Breakouts, Turnarounds &amp; Hidden Names</h2>
    <div class="page-deck">Signals hiding in the flow — brand-new positions, reversals, and stocks held by only a handful of funds.</div>
    <div class="three">
      <div class="idea-col"><div class="idea-cap" style="color:${GREEN};border-color:${GREEN}">BRAND-NEW ENTRIES</div>
        ${listRows(m.newEntries, (x) => `${int(x.fundCount)} funds`, INK)}</div>
      <div class="idea-col"><div class="idea-cap" style="color:${AMBER};border-color:${AMBER}">TURNED AROUND</div>
        ${listRows(m.turnedAround as Move[], (x) => `${arrow(x.net)} ${signedCr(x.net)}`, (m.turnedAround[0]?.net ?? 0) >= 0 ? GREEN : RED)}</div>
      <div class="idea-col"><div class="idea-cap" style="color:${PAL[6]};border-color:${PAL[6]}">HELD BY FEW</div>
        ${listRows(m.heldByFew as Move[], (x) => `${int(x.fundCount)} ${x.fundCount === 1 ? "fund" : "funds"}`, INK)}</div>
    </div>
    <div class="panel callout"><div class="callout-head" style="color:${PAL[2]}">★ HOW TO READ THIS</div>
      <div class="callout-body">“New” means first seen since our data began (${esc(m.firstMonthLabel)}); coverage changes are excluded. “Turned around” flipped between net buying and selling. “Held by few” are owned by 1–3 funds or dominated by a single holder — the contrarian, under-owned names.</div></div>
    ${footer(m, "The Ideas Desk", page, n)}
  </div>`;
}

// ---------------------------------------------------------------------------
// CSS (editorial broadsheet)
// ---------------------------------------------------------------------------

const CSS = `
:root{--paper:#f6f1e6;--ink:#1b1913;--muted:#7c776b;--amber:${AMBER};--track:${TRACK};--line:#d8d2c2;--display:'Playfair Display',Georgia,serif;--body:'Source Serif 4',Georgia,serif;}
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
html,body{margin:0;padding:0;background:#8a8578;color:var(--ink);font-family:var(--body);}
@page{size:A4;margin:9mm;}
.page{background:var(--paper);border:1px solid var(--ink);padding:11mm 13mm 11mm;position:relative;overflow:hidden;}
.page + .page{page-break-before:always;}
@media screen{.page{width:210mm;min-height:297mm;margin:10px auto;box-shadow:0 4px 24px rgba(0,0,0,.3);}}
@media print{.page{height:279mm;}}
/* masthead */
.masthead{text-align:center;border-top:3px solid var(--ink);border-bottom:3px solid var(--ink);padding:5px 0 8px;}
.kicker{font-weight:700;letter-spacing:.28em;font-size:11px;color:var(--amber);margin-top:2px;}
.wordmark{font-family:var(--display);font-weight:900;font-size:43px;line-height:1;letter-spacing:.01em;margin:3px 0 2px;}
.tagline{font-style:italic;font-size:12.5px;color:#4a463c;}
.metabar{display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:11px;letter-spacing:.08em;padding:7px 2px;border-bottom:1px solid var(--ink);}
.metabar .amber{color:var(--amber);}
/* section head */
.sec-head{display:flex;justify-content:space-between;align-items:baseline;border-bottom:3px solid var(--ink);padding-bottom:6px;}
.sec-label{font-weight:700;letter-spacing:.2em;font-size:13px;display:flex;align-items:center;}
.sec-label.big{font-size:12px;margin:16px 0 0;}
.sec-meta{font-weight:700;letter-spacing:.1em;font-size:10.5px;color:var(--muted);}
.dot{width:9px;height:9px;border-radius:2px;display:inline-block;margin-right:8px;flex:none;}
/* headlines */
.headline{font-family:var(--display);font-weight:800;font-size:33px;line-height:1.04;margin:6px 0 5px;letter-spacing:-.01em;}
.deck{font-family:var(--display);font-style:italic;font-size:15px;line-height:1.32;color:#4a463c;margin-bottom:6px;}
.byline{font-weight:700;letter-spacing:.06em;font-size:10.5px;color:var(--muted);border-bottom:1px solid var(--line);padding-bottom:8px;}
.page-title{font-family:var(--display);font-weight:800;font-size:30px;line-height:1.05;margin:10px 0 4px;}
.page-deck{font-family:var(--display);font-style:italic;font-size:14px;color:#4a463c;margin-bottom:14px;}
/* lede two columns + sidebar */
.lede{display:grid;grid-template-columns:1fr 250px;gap:18px;margin-top:8px;}
.cols{column-count:2;column-gap:20px;font-size:12.5px;line-height:1.5;text-align:justify;}
.cols p{margin:0 0 9px;}
.dropcap{float:left;font-family:var(--display);font-weight:800;font-size:52px;line-height:.8;padding:2px 6px 0 0;color:var(--amber);}
/* panels */
.panel{border:1px solid var(--ink);padding:12px 14px;background:transparent;}
.panel-head{display:flex;justify-content:space-between;align-items:baseline;font-weight:700;letter-spacing:.1em;font-size:11px;border-bottom:2px solid var(--ink);padding-bottom:6px;margin-bottom:10px;}
.panel-head .muted,.muted{color:var(--muted);font-weight:700;}
.caption{font-size:10.5px;color:var(--muted);margin-top:8px;font-style:italic;}
.hero{margin-top:9px;}
/* sidebar */
.sidebar{background:#efe8d7;}
.sidebar-head{font-weight:700;letter-spacing:.16em;font-size:12px;color:var(--amber);display:flex;justify-content:space-between;border-bottom:1px solid var(--ink);padding-bottom:6px;margin-bottom:4px;}
.sidebar-head span{color:var(--muted);font-size:10px;letter-spacing:.05em;}
.kv{display:flex;align-items:baseline;gap:6px;padding:3px 0;border-bottom:1px dotted var(--line);}
.kv .k{font-weight:600;font-size:12px;}
.kv .leader{flex:1;}
.kv .v{font-family:var(--display);font-weight:800;font-size:15px;white-space:nowrap;}
/* bars */
.bars{display:flex;flex-direction:column;gap:6px;}
.bar-row{display:grid;align-items:center;column-gap:10px;}
.bar-label{font-size:12px;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.track{height:13px;background:var(--track);border:1px solid var(--line);position:relative;}
.fill{height:100%;}
.bar-val{font-weight:700;font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums;}
/* league tables */
.two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:18px;margin-bottom:16px;}
.three{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-bottom:16px;}
.side{}
.ltable-cap{font-weight:700;letter-spacing:.14em;font-size:12px;border-bottom:2px solid;padding-bottom:5px;margin-bottom:0;}
.ltable table{width:100%;border-collapse:collapse;font-size:11.5px;table-layout:fixed;}
.ltable th{background:var(--ink);color:#fff;font-weight:700;letter-spacing:.06em;font-size:9px;text-transform:uppercase;text-align:right;padding:6px 6px;}
.ltable th:first-child{text-align:left;width:20px;}
.ltable th:nth-child(3){width:70px;}
.ltable th:nth-child(4){width:38px;}
.ltable td{padding:4px 6px;border-bottom:1px solid var(--line);text-align:right;}
.ltable tbody tr:nth-child(even){background:#efe8d7;}
.ltable td.rank{font-weight:800;text-align:left;width:20px;}
.ltable td.name{text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.ltable td.name span{overflow:hidden;text-overflow:ellipsis;}
.ltable td.num{font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;}
.dot{width:8px;height:8px;margin-right:6px;}
.ltable td.empty{text-align:center;color:var(--muted);font-style:italic;}
/* callout */
.callout{background:#efe8d7;}
.callout-head{font-weight:700;letter-spacing:.14em;font-size:12px;border-bottom:1px solid var(--line);padding-bottom:5px;margin-bottom:7px;}
.callout-body{font-size:12.5px;line-height:1.5;}
/* ideas */
.idea-col{}
.idea-cap{font-weight:700;letter-spacing:.12em;font-size:11px;border-bottom:2px solid;padding-bottom:5px;margin-bottom:6px;}
.idea-row{display:flex;align-items:baseline;gap:6px;padding:6px 0;border-bottom:1px dotted var(--line);font-size:12px;}
.idea-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}
.idea-name .muted{font-size:10.5px;}
.idea-leader{flex:1;}
.idea-val{font-weight:700;white-space:nowrap;font-variant-numeric:tabular-nums;}
.idea-empty{color:var(--muted);font-style:italic;padding:8px 0;font-size:12px;}
/* teasers */
.teasers{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;border-top:1px solid var(--line);margin-top:10px;padding-top:8px;}
.teaser .t-label{font-weight:700;letter-spacing:.1em;font-size:10.5px;}
.teaser .t-head{font-family:var(--display);font-weight:700;font-size:15px;margin:2px 0;}
.teaser .t-page{font-weight:700;font-size:11px;}
/* footer */
.foot{position:absolute;left:14mm;right:14mm;bottom:8mm;display:flex;justify-content:space-between;font-weight:700;letter-spacing:.06em;font-size:9.5px;color:var(--muted);border-top:1px solid var(--ink);padding-top:6px;}
`;
