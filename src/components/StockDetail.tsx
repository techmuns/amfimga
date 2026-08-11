import { useEffect, useMemo, useState } from "react";
import type { FundTrend, StockDetail, SummaryMeta } from "../types/holdings";
import { fundFileKey, loadStockDetail, loadSummary } from "../lib/data";
import { navigate } from "../lib/router";
import { makeSectorScale } from "../lib/palette";
import { DASH, formatCount, formatCountShort, formatPercent, formatSignedCount } from "../lib/format";
import { CapPill } from "./caps";
import { LineChart, NetBars, Sparkline } from "./charts";
import { ThemeToggle } from "./ThemeToggle";
import { useTooltip } from "./Tooltip";

type State =
  | { status: "loading" }
  | { status: "error"; reason: string }
  | { status: "ready"; summary: SummaryMeta; detail: StockDetail };

export function StockDetailPage({ isin }: { isin: string }) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    Promise.all([loadSummary(), loadStockDetail(isin)])
      .then(([summary, detail]) => {
        if (!cancelled) setState({ status: "ready", summary, detail });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: "error", reason: err instanceof Error ? err.message : "Unknown error" });
      });
    return () => { cancelled = true; };
  }, [isin]);

  return (
    <>
      <div className="mb-5 flex items-center justify-between">
        <button className="link t-body" onClick={() => navigate("/stocks")}>← Stocks</button>
        <ThemeToggle />
      </div>
      {state.status === "loading" && <p className="t-muted">Loading…</p>}
      {state.status === "error" && (
        <p className="t-body" style={{ color: "var(--sell)" }}>
          Couldn&apos;t load {isin}: {state.reason}
        </p>
      )}
      {state.status === "ready" && <Detail summary={state.summary} detail={state.detail} />}
    </>
  );
}

function Detail({ summary, detail }: { summary: SummaryMeta; detail: StockDetail }) {
  const last = detail.months.length - 1;
  const scale = useMemo(() => makeSectorScale(summary.topSectors), [summary]);
  const net = detail.netShareChange[last];
  const buying = detail.funds.filter((f) => f.change[last] != null && f.change[last]! > 0).length;
  const selling = detail.funds.filter((f) => f.change[last] != null && f.change[last]! < 0).length;

  return (
    <div>
      {/* 1. Header */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="t-title">{detail.name}</h1>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span className="sec-dot" style={{ background: scale.colorOf(detail.macroSector) }} />
          <span className="t-label" style={{ color: "var(--ink-2)" }}>{detail.sector ?? DASH}</span>
        </span>
        <CapPill cap={detail.marketCap} />
      </div>
      <div className="t-muted" style={{ marginTop: 2 }}>
        {detail.isin}{detail.macroSector ? ` · ${detail.macroSector}` : ""}
      </div>

      {/* Inline summary line — no stat cards */}
      <div className="t-body" style={{ marginTop: 12, color: "var(--ink-2)" }}>
        <strong style={{ color: "var(--ink)" }}>{formatCountShort(detail.totalShares[last])}</strong> shares held ·{" "}
        <span style={{ color: net == null ? "var(--muted)" : net >= 0 ? "var(--buy)" : "var(--sell)", fontWeight: 600 }}>
          {net == null ? DASH : <>{net >= 0 ? "▲" : "▼"} {formatSignedCount(net)}</>}
        </span>{" "}
        this month · held by <strong style={{ color: "var(--ink)" }}>{detail.fundCount[last] ?? DASH}</strong> funds — {buying} buying, {selling} selling
      </div>

      {/* 2. Total shares line chart */}
      <section style={{ marginTop: 28 }}>
        <div className="t-section">Total shares held</div>
        <div className="t-muted" style={{ margin: "2px 0 8px" }}>Across all mutual funds, month by month</div>
        <LineChart values={detail.totalShares} labels={detail.monthLabels} netChanges={detail.netShareChange} />
      </section>

      {/* 3. Monthly net-change bars */}
      <section style={{ marginTop: 24 }}>
        <div className="t-section">Monthly net change</div>
        <div className="t-muted" style={{ margin: "2px 0 8px" }}>Green when funds net-bought, red when they net-sold</div>
        <NetBars values={detail.netShareChange} labels={detail.monthLabels} />
      </section>

      {/* 4. Funds table */}
      <section style={{ marginTop: 28 }}>
        <div className="t-section" style={{ marginBottom: 10 }}>Funds holding this stock</div>
        <FundsTable funds={detail.funds} last={last} labels={detail.monthLabels} />
      </section>
    </div>
  );
}

type SortKey = "fund" | "shares" | "change";

function FundsTable({ funds, last, labels }: { funds: FundTrend[]; last: number; labels: string[] }) {
  const tt = useTooltip();
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "shares", dir: -1 });

  const rows = useMemo(() => {
    const val = (f: FundTrend): number | string | null => {
      if (sort.key === "fund") return f.fundName.toLowerCase();
      if (sort.key === "shares") return f.shares[last];
      return f.change[last];
    };
    return [...funds].sort((a, b) => {
      const av = val(a), bv = val(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string") return av < (bv as string) ? -sort.dir : av > (bv as string) ? sort.dir : 0;
      return ((av as number) - (bv as number)) * sort.dir;
    });
  }, [funds, sort, last]);

  const click = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: (s.dir === 1 ? -1 : 1) as 1 | -1 } : { key, dir: key === "fund" ? 1 : -1 }));
  const arrow = (key: SortKey) => (sort.key === key ? (sort.dir === 1 ? "▲" : "▼") : "⇅");

  return (
    <div className="panel" style={{ overflow: "hidden" }}>
      <div className="fund-grid stock-head" style={{ padding: "8px 14px" }}>
        <span className="th" onClick={() => click("fund")}>Fund <span className="arrow">{arrow("fund")}</span></span>
        <span className="th cell-r" style={{ justifySelf: "end" }} onClick={() => click("shares")}>Shares held <span className="arrow">{arrow("shares")}</span></span>
        <span className="th cell-r" style={{ justifySelf: "end" }} onClick={() => click("change")}>Change <span className="arrow">{arrow("change")}</span></span>
        <span className="t-label" style={{ color: "var(--ink-2)" }}>Trend</span>
        <span className="t-label cell-r" style={{ color: "var(--ink-2)", justifySelf: "end" }}>% of fund</span>
        <span className="t-label" style={{ color: "var(--ink-2)" }}>Status</span>
      </div>
      <div style={{ maxHeight: 520, overflow: "auto" }}>
        {rows.map((f) => (
          <FundRow key={f.fundId} f={f} last={last} labels={labels} tt={tt} />
        ))}
      </div>
    </div>
  );
}

function FundRow({ f, last, labels, tt }: { f: FundTrend; last: number; labels: string[]; tt: ReturnType<typeof useTooltip> }) {
  const c = f.change[last];
  const buy = c != null && c > 0;
  const sell = c != null && c < 0;

  let changeMsg: string | null = null;
  if (c == null) {
    if (!f.present[last]) changeMsg = "This fund's house isn't in this month's data — its change isn't counted (not a sell).";
    else if (last >= 1 && !f.present[last - 1]) changeMsg = "This fund's house entered the data this month — not counted as buying.";
    else changeMsg = "Shares not disclosed this month.";
  }

  const status = !f.present[last]
    ? { label: "No data", color: "var(--muted)" }
    : f.event[last] === "new"
    ? { label: "New", color: "var(--buy)" }
    : f.event[last] === "exit"
    ? { label: "Exited", color: "var(--sell)" }
    : { label: "Holding", color: "var(--muted)" };

  const trendTip = (
    <div>
      <div className="t-label">{f.fundName}</div>
      {f.shares.map((v, i) => (
        <div key={i}><span className="k">{labels[i]}: </span>{formatCount(v)}</div>
      ))}
    </div>
  );

  return (
    <div className="fund-grid stock-row" style={{ padding: "8px 14px" }}>
      <div style={{ minWidth: 0 }}>
        {f.present[last] ? (
          <button
            className="link t-body"
            style={{ display: "block", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}
            title={f.fundName}
            onClick={() => navigate(`/fund/${fundFileKey("fund", f.fundId)}`)}
          >
            {f.fundName}
          </button>
        ) : (
          <div className="t-body" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.fundName}</div>
        )}
        {f.present[last] ? (
          <button
            className="link t-muted"
            style={{ display: "block", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}
            title={f.fundHouse}
            onClick={() => navigate(`/fund/${fundFileKey("house", f.fundId.split(":")[0])}`)}
          >
            {f.fundHouse}
          </button>
        ) : (
          <div className="t-muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.fundHouse}</div>
        )}
      </div>
      <div className="cell-r t-body num">{formatCountShort(f.shares[last])}</div>
      <div
        className="cell-r t-body num"
        style={{ color: c == null ? "var(--muted)" : buy ? "var(--buy)" : sell ? "var(--sell)" : "var(--ink-2)", cursor: changeMsg ? "help" : "default" }}
        onMouseEnter={(e) => changeMsg && tt.show(<div style={{ maxWidth: 220 }}>{changeMsg}</div>, e.clientX, e.clientY)}
        onMouseMove={(e) => tt.move(e.clientX, e.clientY)}
        onMouseLeave={tt.hide}
      >
        {c == null ? DASH : <>{buy ? "▲" : sell ? "▼" : ""} {formatSignedCount(c)}</>}
      </div>
      <div
        onMouseEnter={(e) => tt.show(trendTip, e.clientX, e.clientY)}
        onMouseMove={(e) => tt.move(e.clientX, e.clientY)}
        onMouseLeave={tt.hide}
      >
        <Sparkline values={f.shares} />
      </div>
      <div className="cell-r t-body num">{formatPercent(f.percent[last])}</div>
      <div><span className="badge" style={{ color: status.color, borderColor: status.color }}>{status.label}</span></div>
    </div>
  );
}
