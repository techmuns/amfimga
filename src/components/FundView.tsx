import { useEffect, useMemo, useState } from "react";
import type { FundDetail, FundHoldingTrend, FundsIndex, SummaryMeta } from "../types/holdings";
import { loadFundDetail, loadFundsIndex, loadSummary } from "../lib/data";
import { navigate } from "../lib/router";
import { makeSectorScale, type SectorScale } from "../lib/palette";
import { DASH, formatCount, formatCountShort, formatInr, formatPercent, formatSignedCount } from "../lib/format";
import { CapPill } from "./caps";
import { Sparkline } from "./charts";
import { ThemeToggle } from "./ThemeToggle";
import { useTooltip } from "./Tooltip";

// ===========================================================================
// Fund / house picker
// ===========================================================================

function FundPicker({ index, mode }: { index: FundsIndex; mode: "page" | "inline" }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | "house" | "fund">(mode === "page" ? "all" : "all");

  const results = useMemo(() => {
    const ql = q.trim().toLowerCase();
    let list = index.entries;
    if (kind !== "all") list = list.filter((e) => e.kind === kind);
    if (ql) list = list.filter((e) => e.name.toLowerCase().includes(ql) || e.house.toLowerCase().includes(ql));
    return list.slice(0, mode === "page" ? 120 : 10);
  }, [index, q, kind, mode]);

  const showList = mode === "page" || q.trim().length > 0;

  return (
    <div style={{ position: "relative" }}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="searchbox"
          style={{ minWidth: 240, flex: mode === "inline" ? "1 1 240px" : undefined }}
          placeholder={mode === "inline" ? "Switch fund or house…" : "Search a scheme or fund house…"}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="flex gap-1.5">
          {(["all", "house", "fund"] as const).map((k) => (
            <button key={k} className="fchip" data-active={kind === k}
              style={kind === k ? { background: "var(--ink-2)", borderColor: "transparent", color: "var(--surface)" } : undefined}
              onClick={() => setKind(k)}>
              {k === "all" ? "All" : k === "house" ? "Fund houses" : "Schemes"}
            </button>
          ))}
        </div>
      </div>

      {showList && (
        <div className="panel" style={mode === "inline"
          ? { position: "absolute", zIndex: 20, top: 40, left: 0, right: 0, maxHeight: 340, overflow: "auto" }
          : { marginTop: 10, maxHeight: 520, overflow: "auto" }}>
          {results.length === 0 && <div className="t-muted" style={{ padding: "10px 14px" }}>No matches.</div>}
          {results.map((e) => (
            <div key={e.file} className="stock-row" style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", cursor: "pointer" }}
              onClick={() => { setQ(""); navigate(`/fund/${e.file}`); }}>
              <span className="badge" style={{ color: e.kind === "house" ? "var(--ink-2)" : "var(--muted)" }}>
                {e.kind === "house" ? "House" : "Scheme"}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="t-body" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</div>
                {e.kind === "fund" && <div className="t-muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.house}</div>}
              </div>
              <div className="t-muted num" style={{ whiteSpace: "nowrap" }}>{e.stockCount} stocks · {formatInr(e.valueInr)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Landing page (route /funds)
// ===========================================================================

type IdxState =
  | { status: "loading" }
  | { status: "error"; reason: string }
  | { status: "ready"; index: FundsIndex };

export function FundsPage({ embedded }: { embedded?: boolean }) {
  const [state, setState] = useState<IdxState>({ status: "loading" });
  useEffect(() => {
    let off = false;
    loadFundsIndex()
      .then((index) => !off && setState({ status: "ready", index }))
      .catch((err: unknown) => !off && setState({ status: "error", reason: err instanceof Error ? err.message : "Unknown error" }));
    return () => { off = true; };
  }, []);

  return (
    <>
      {!embedded && (
        <div className="mb-5 flex items-center justify-between">
          <button className="link t-body" onClick={() => navigate("/")}>← Overview</button>
          <ThemeToggle />
        </div>
      )}
      {state.status === "loading" && <p className="t-muted">Loading…</p>}
      {state.status === "error" && <p className="t-body" style={{ color: "var(--sell)" }}>Couldn&apos;t load the funds list: {state.reason}</p>}
      {state.status === "ready" && (
        <>
          <h1 className="t-page">Funds &amp; fund houses</h1>
          <div className="t-muted" style={{ marginTop: 3, marginBottom: 16 }}>
            Pick a scheme to see what it&apos;s buying and selling — or a whole fund house, rolled up. {state.index.monthLabel} · {state.index.entries.filter((e) => e.kind === "house").length} houses · {state.index.entries.filter((e) => e.kind === "fund").length} schemes.
          </div>
          <FundPicker index={state.index} mode="page" />
        </>
      )}
    </>
  );
}

// ===========================================================================
// Detail page (route /fund/<file>)
// ===========================================================================

type State =
  | { status: "loading" }
  | { status: "error"; reason: string }
  | { status: "ready"; summary: SummaryMeta; index: FundsIndex; detail: FundDetail };

export function FundDetailPage({ file }: { file: string }) {
  const [state, setState] = useState<State>({ status: "loading" });
  useEffect(() => {
    let off = false;
    setState({ status: "loading" });
    Promise.all([loadSummary(), loadFundsIndex(), loadFundDetail(file)])
      .then(([summary, index, detail]) => !off && setState({ status: "ready", summary, index, detail }))
      .catch((err: unknown) => !off && setState({ status: "error", reason: err instanceof Error ? err.message : "Unknown error" }));
    return () => { off = true; };
  }, [file]);

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <button className="link t-body" onClick={() => navigate("/funds")}>← All funds</button>
        <ThemeToggle />
      </div>
      {state.status === "loading" && <p className="t-muted">Loading…</p>}
      {state.status === "error" && <p className="t-body" style={{ color: "var(--sell)" }}>Couldn&apos;t load this fund: {state.reason}</p>}
      {state.status === "ready" && <Detail summary={state.summary} index={state.index} detail={state.detail} />}
    </>
  );
}

function Detail({ summary, index, detail }: { summary: SummaryMeta; index: FundsIndex; detail: FundDetail }) {
  const last = detail.months.length - 1;
  const scale = useMemo(() => makeSectorScale(summary.topSectors), [summary]);

  const held = detail.holdings.filter((h) => (h.shares[last] ?? 0) > 0 || (h.valueInr[last] ?? 0) > 0);
  const totalValue = held.reduce<number | null>((s, h) => (h.valueInr[last] != null ? (s ?? 0) + h.valueInr[last]! : s), null);
  const biggest = detail.comparableLatest
    ? [...detail.holdings].filter((h) => h.change[last] != null && h.change[last] !== 0)
        .sort((a, b) => Math.abs(b.change[last]!) - Math.abs(a.change[last]!))[0]
    : undefined;

  return (
    <div>
      {/* Switch picker */}
      <div style={{ marginBottom: 18 }}><FundPicker index={index} mode="inline" /></div>

      {/* 1. Header */}
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="t-title">{detail.name}</h1>
        <span className="badge" style={{ color: "var(--ink-2)" }}>{detail.kind === "house" ? "Fund house" : "Scheme"}</span>
      </div>
      <div className="t-muted" style={{ marginTop: 2 }}>
        {detail.kind === "fund" ? <>{detail.house} · </> : null}{detail.monthLabels[last]}
      </div>

      {/* Inline summary line — no stat cards */}
      <div className="t-body" style={{ marginTop: 12, color: "var(--ink-2)" }}>
        holds <strong style={{ color: "var(--ink)" }}>{held.length}</strong> {held.length === 1 ? "stock" : "stocks"} ·{" "}
        <strong style={{ color: "var(--ink)" }}>{formatInr(totalValue)}</strong> in equity
        {biggest && biggest.change[last] != null ? (
          <> · biggest move{" "}
            <button className="link" style={{ color: biggest.change[last]! >= 0 ? "var(--buy)" : "var(--sell)", fontWeight: 600 }} onClick={() => navigate(`/stock/${biggest.isin}`)}>
              {biggest.name} {biggest.change[last]! >= 0 ? "▲" : "▼"} {formatSignedCount(biggest.change[last])}
            </button>
          </>
        ) : null}
      </div>

      {/* 2. This month's activity */}
      <Activity detail={detail} last={last} scale={scale} />

      {/* 3. Sector allocation */}
      {detail.sectorAllocation.length > 0 && (
        <section style={{ marginTop: 30 }}>
          <div className="t-section">Where it&apos;s invested</div>
          <div className="t-muted" style={{ margin: "2px 0 10px" }}>Equity value by macro sector · {detail.monthLabels[last]}</div>
          <SectorAllocation alloc={detail.sectorAllocation} scale={scale} />
        </section>
      )}

      {/* 4. Holdings table */}
      <section style={{ marginTop: 30 }}>
        <div className="t-section" style={{ marginBottom: 10 }}>All holdings</div>
        <HoldingsTable holdings={detail.holdings} last={last} labels={detail.monthLabels} scale={scale} comparable={detail.comparableLatest} />
      </section>
    </div>
  );
}

// ---- This month's activity (coverage-aware) ----

function Activity({ detail, last, scale }: { detail: FundDetail; last: number; scale: SectorScale }) {
  const kindWord = detail.kind === "house" ? "fund house" : "fund";
  if (!detail.comparableLatest) {
    const reason = last >= 1 && !detail.present[last - 1]
      ? `This ${kindWord} wasn't in last month's data, so this month's buys and sells can't be computed`
      : `No prior month to compare against`;
    return (
      <section style={{ marginTop: 26 }}>
        <div className="t-section">This month&apos;s activity</div>
        <div className="t-body" style={{ marginTop: 8, color: "var(--ink-2)" }}>
          {DASH} — {reason} — shown as {DASH} rather than a guess.
        </div>
      </section>
    );
  }

  const buys = detail.holdings.filter((h) => h.change[last] != null && h.change[last]! > 0)
    .sort((a, b) => b.change[last]! - a.change[last]!).slice(0, 8);
  const sells = detail.holdings.filter((h) => h.change[last] != null && h.change[last]! < 0)
    .sort((a, b) => a.change[last]! - b.change[last]!).slice(0, 8);
  const news = detail.holdings.filter((h) => h.event[last] === "new");
  const exits = detail.holdings.filter((h) => h.event[last] === "exit");

  return (
    <section style={{ marginTop: 26 }}>
      <div className="t-section">This month&apos;s activity</div>
      <div className="t-muted" style={{ margin: "2px 0 12px" }}>Net change in shares held this month</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 40px" }}>
        <MoveList title="Bought" rows={buys} last={last} scale={scale} dir="buy" />
        <MoveList title="Sold" rows={sells} last={last} scale={scale} dir="sell" />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 40px", marginTop: 16 }}>
        <EventList title="New positions" rows={news} scale={scale} color="var(--buy)" />
        <EventList title="Exited" rows={exits} scale={scale} color="var(--sell)" />
      </div>
    </section>
  );
}

function MoveList({ title, rows, last, scale, dir }: { title: string; rows: FundHoldingTrend[]; last: number; scale: SectorScale; dir: "buy" | "sell" }) {
  const color = dir === "buy" ? "var(--buy)" : "var(--sell)";
  return (
    <div style={{ minWidth: 0 }}>
      <div className="t-label" style={{ color, marginBottom: 6 }}>{dir === "buy" ? "▲" : "▼"} {title}</div>
      {rows.length === 0 && <div className="t-muted">Nothing this month.</div>}
      {rows.map((h) => (
        <div key={h.isin} className="stock-row" style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", cursor: "pointer" }}
          onClick={() => navigate(`/stock/${h.isin}`)}>
          <span className="sec-dot" style={{ background: scale.colorOf(h.macroSector) }} />
          <span className="t-body" style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={h.name}>{h.name}</span>
          <span className="t-body num" style={{ color, whiteSpace: "nowrap" }}>{formatSignedCount(h.change[last])}</span>
        </div>
      ))}
    </div>
  );
}

function EventList({ title, rows, scale, color }: { title: string; rows: FundHoldingTrend[]; scale: SectorScale; color: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="t-label" style={{ marginBottom: 4 }}>{title} <span className="t-muted">({rows.length})</span></div>
      {rows.length === 0 && <div className="t-muted">None.</div>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px" }}>
        {rows.slice(0, 12).map((h) => (
          <button key={h.isin} className="link t-body" style={{ display: "inline-flex", alignItems: "center", gap: 5 }} onClick={() => navigate(`/stock/${h.isin}`)}>
            <span className="sec-dot" style={{ background: scale.colorOf(h.macroSector) }} />
            {h.name}
          </button>
        ))}
        {rows.length > 12 && <span className="t-muted" style={{ color }}>+{rows.length - 12} more</span>}
      </div>
    </div>
  );
}

// ---- Sector allocation bar ----

function SectorAllocation({ alloc, scale }: { alloc: { sector: string; valueInr: number }[]; scale: SectorScale }) {
  const tt = useTooltip();
  const total = alloc.reduce((s, a) => s + a.valueInr, 0) || 1;
  return (
    <div>
      <div style={{ display: "flex", height: 16, borderRadius: 5, overflow: "hidden", border: "1px solid var(--border)" }}>
        {alloc.map((a) => {
          const pct = (a.valueInr / total) * 100;
          return (
            <div key={a.sector} style={{ width: `${pct}%`, background: a.sector === "Unknown" ? "var(--sector-other)" : scale.colorOf(a.sector) }}
              onMouseEnter={(e) => tt.show(<div><div className="t-label">{a.sector}</div><div style={{ marginTop: 3 }}>{formatInr(a.valueInr)} · {pct.toFixed(1)}%</div></div>, e.clientX, e.clientY)}
              onMouseMove={(e) => tt.move(e.clientX, e.clientY)}
              onMouseLeave={tt.hide} />
          );
        })}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", marginTop: 8 }}>
        {alloc.slice(0, 9).map((a) => (
          <span key={a.sector} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span className="sec-dot" style={{ background: a.sector === "Unknown" ? "var(--sector-other)" : scale.colorOf(a.sector) }} />
            <span className="t-body">{a.sector}</span>
            <span className="t-muted num">{((a.valueInr / total) * 100).toFixed(1)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ---- Holdings table ----

type SortKey = "name" | "sector" | "shares" | "percent" | "change";

function HoldingsTable({ holdings, last, labels, scale, comparable }: {
  holdings: FundHoldingTrend[]; last: number; labels: string[]; scale: SectorScale; comparable: boolean;
}) {
  const tt = useTooltip();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "shares", dir: -1 });

  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase();
    let list = holdings.filter((h) => (h.shares[last] ?? 0) > 0 || (h.valueInr[last] ?? 0) > 0 || h.event[last] === "exit");
    if (ql) list = list.filter((h) => h.name.toLowerCase().includes(ql));
    const val = (h: FundHoldingTrend): number | string | null => {
      switch (sort.key) {
        case "name": return h.name.toLowerCase();
        case "sector": return (h.macroSector ?? "￿").toLowerCase();
        case "shares": return h.shares[last];
        case "percent": return h.percent[last];
        case "change": return h.change[last];
      }
    };
    return [...list].sort((a, b) => {
      const av = val(a), bv = val(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string") return av < (bv as string) ? -sort.dir : av > (bv as string) ? sort.dir : 0;
      return ((av as number) - (bv as number)) * sort.dir;
    });
  }, [holdings, q, sort, last]);

  const click = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: (s.dir === 1 ? -1 : 1) as 1 | -1 } : { key, dir: key === "name" || key === "sector" ? 1 : -1 }));
  const arrow = (key: SortKey) => (sort.key === key ? (sort.dir === 1 ? "▲" : "▼") : "⇅");

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <input className="searchbox" style={{ minWidth: 190 }} placeholder="Search holdings…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="t-muted ml-auto">{rows.length.toLocaleString("en-IN")} holdings</span>
      </div>
      <div className="panel" style={{ overflow: "hidden" }}>
        <div className="hold-grid stock-head" style={{ padding: "8px 14px" }}>
          <span className="th" onClick={() => click("name")}>Stock <span className="arrow">{arrow("name")}</span></span>
          <span className="th" onClick={() => click("sector")}>Sector <span className="arrow">{arrow("sector")}</span></span>
          <span className="th cell-r" style={{ justifySelf: "end" }} onClick={() => click("shares")}>Shares <span className="arrow">{arrow("shares")}</span></span>
          <span className="th cell-r" style={{ justifySelf: "end" }} onClick={() => click("percent")}>% of portfolio <span className="arrow">{arrow("percent")}</span></span>
          <span className="th cell-r" style={{ justifySelf: "end" }} onClick={() => click("change")}>Change <span className="arrow">{arrow("change")}</span></span>
          <span className="t-label" style={{ color: "var(--ink-2)" }}>Trend</span>
        </div>
        <div style={{ maxHeight: 560, overflow: "auto" }}>
          {rows.map((h) => <HoldRow key={h.isin} h={h} last={last} labels={labels} scale={scale} comparable={comparable} tt={tt} />)}
        </div>
      </div>
    </div>
  );
}

function HoldRow({ h, last, labels, scale, comparable, tt }: {
  h: FundHoldingTrend; last: number; labels: string[]; scale: SectorScale; comparable: boolean; tt: ReturnType<typeof useTooltip>;
}) {
  const c = h.change[last];
  const buy = c != null && c > 0, sell = c != null && c < 0;
  const changeMsg = c == null
    ? (!comparable ? "This fund wasn't in last month's data — change isn't counted (not a sell)." : h.event[last] === "new" ? "New position this month." : "Shares not disclosed.")
    : null;
  const trendTip = (
    <div>
      <div className="t-label">{h.name}</div>
      {h.shares.map((v, i) => <div key={i}><span className="k">{labels[i]}: </span>{formatCount(v)}</div>)}
    </div>
  );
  return (
    <div className="hold-grid stock-row" style={{ padding: "8px 14px", cursor: "pointer" }} onClick={() => navigate(`/stock/${h.isin}`)}>
      <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
        <span className="t-body" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={h.name}>{h.name}</span>
        <CapPill cap={h.marketCap} />
      </div>
      <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 6 }}>
        <span className="sec-dot" style={{ background: scale.colorOf(h.macroSector) }} />
        <span className="t-body" style={{ color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.macroSector ?? DASH}</span>
      </div>
      <div className="cell-r t-body num">{formatCountShort(h.shares[last])}</div>
      <div className="cell-r t-body num">{formatPercent(h.percent[last])}</div>
      <div className="cell-r t-body num"
        style={{ color: c == null ? "var(--muted)" : buy ? "var(--buy)" : sell ? "var(--sell)" : "var(--ink-2)", cursor: changeMsg ? "help" : "default" }}
        onClick={(e) => e.stopPropagation()}
        onMouseEnter={(e) => changeMsg && tt.show(<div style={{ maxWidth: 220 }}>{changeMsg}</div>, e.clientX, e.clientY)}
        onMouseMove={(e) => tt.move(e.clientX, e.clientY)}
        onMouseLeave={tt.hide}>
        {c == null ? DASH : <>{buy ? "▲" : sell ? "▼" : ""} {formatSignedCount(c)}</>}
      </div>
      <div onClick={(e) => e.stopPropagation()}
        onMouseEnter={(e) => tt.show(trendTip, e.clientX, e.clientY)}
        onMouseMove={(e) => tt.move(e.clientX, e.clientY)}
        onMouseLeave={tt.hide}>
        <Sparkline values={h.shares} />
      </div>
    </div>
  );
}
