import { useEffect, useMemo, useState } from "react";
import type { SectorSummary, StockRow, StocksSummary, SummaryMeta } from "./types/holdings";
import { loadSectors, loadStocks, loadSummary } from "./lib/data";
import { DASH, formatCount, formatSignedCount } from "./lib/format";
import { makeSectorScale } from "./lib/palette";
import { navigate, useRoute } from "./lib/router";
import { TooltipProvider } from "./components/Tooltip";
import { ThemeToggle } from "./components/ThemeToggle";
import { DivergingBars, type DivRow } from "./components/charts";
import { StockTable } from "./components/StockTable";
import { StockDetailPage } from "./components/StockDetail";
import { IdeasPage } from "./components/Ideas";

type Data = { summary: SummaryMeta; stocks: StocksSummary; sectors: SectorSummary };
type LoadState =
  | { status: "loading" }
  | { status: "error"; reason: string }
  | { status: "ready"; data: Data };

export function App() {
  const path = useRoute();
  const stockMatch = path.match(/^\/stock\/([^/]+)$/);
  const content = stockMatch ? (
    <StockDetailPage isin={decodeURIComponent(stockMatch[1])} />
  ) : path === "/ideas" ? (
    <IdeasPage />
  ) : (
    <DashboardLoader />
  );
  return (
    <TooltipProvider>
      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "26px 24px 64px" }}>{content}</div>
    </TooltipProvider>
  );
}

function DashboardLoader() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadSummary(), loadStocks(), loadSectors()])
      .then(([summary, stocks, sectors]) => {
        if (!cancelled) setState({ status: "ready", data: { summary, stocks, sectors } });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ status: "error", reason: err instanceof Error ? err.message : "Unknown error" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") return <p className="t-muted">Loading…</p>;
  if (state.status === "error") return <p className="t-body" style={{ color: "var(--sell)" }}>Couldn&apos;t load data: {state.reason}</p>;
  return <Dashboard data={state.data} />;
}

function Dashboard({ data }: { data: Data }) {
  const { summary, stocks, sectors } = data;
  const last = stocks.months.length - 1;
  const month = summary.months[summary.months.length - 1];
  const scale = useMemo(() => makeSectorScale(summary.topSectors), [summary]);

  const moves = useMemo(() => buildMoveRows(stocks.stocks, last), [stocks, last]);
  const sectorRows = useMemo(() => buildSectorRows(sectors, sectors.months.length - 1), [sectors]);

  return (
    <>
      <header className="flex items-start gap-4">
        <div>
          <h1 className="t-title">Mutual fund moves</h1>
          <div className="t-muted" style={{ marginTop: 3 }}>
            Based on {month.housesPresent} of {month.housesTotal} fund houses this month.
          </div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <button className="link t-label" onClick={() => navigate("/ideas")}>Ideas →</button>
          <span className="t-section" style={{ color: "var(--ink-2)" }}>{month.label}</span>
          <ThemeToggle />
        </div>
      </header>

      <section style={{ marginTop: 26 }}>
        <div className="t-section">Biggest moves this month</div>
        <div className="t-muted" style={{ margin: "2px 0 10px" }}>Selling ← → Buying · net change in shares held</div>
        <DivergingBars rows={moves.rows} maxAbs={moves.max} />
      </section>

      <section style={{ marginTop: 30 }}>
        <div className="t-section">Where the money moved</div>
        <div className="t-muted" style={{ margin: "2px 0 10px" }}>Net share change by sector · green in, red out</div>
        <DivergingBars rows={sectorRows.rows} maxAbs={sectorRows.max} />
      </section>

      <section style={{ marginTop: 30 }}>
        <div className="t-section" style={{ marginBottom: 10 }}>All stocks</div>
        <StockTable data={stocks} scale={scale} monthIdx={last} />
      </section>
    </>
  );
}

function coverageLines(s: StockRow) {
  if (!s.coverageAffected?.length) return null;
  return (
    <div style={{ marginTop: 6, color: "var(--ink-2)" }}>
      {s.coverageAffected.map((c, i) => (
        <div key={i}>
          {c.house}{" "}
          {c.direction === "entered"
            ? "entered the data this month — its shares aren't counted as buying."
            : "left the data this month — its previous shares aren't counted."}
        </div>
      ))}
    </div>
  );
}

function buildMoveRows(stocks: StockRow[], last: number): { rows: DivRow[]; max: number } {
  const withNet = stocks
    .map((s) => ({ s, net: s.netShareChange[last] }))
    .filter((x): x is { s: StockRow; net: number } => x.net != null && x.net !== 0);
  const buys = [...withNet].sort((a, b) => b.net - a.net).slice(0, 10);
  const sells = [...withNet].sort((a, b) => a.net - b.net).slice(0, 10);
  const picked = [...buys, ...sells].sort((a, b) => b.net - a.net);
  const max = Math.max(1, ...picked.map((x) => Math.abs(x.net)));
  const rows: DivRow[] = picked.map(({ s, net }) => ({
    key: s.isin,
    label: s.name,
    value: net,
    tip: (
      <div>
        <div className="t-label">{s.name}</div>
        <div style={{ marginTop: 4 }}>
          <span className="k">{net > 0 ? "Buying" : "Selling"}: </span>
          {formatSignedCount(net)} shares
        </div>
        <div><span className="k">Funds holding: </span>{s.fundCount[last] ?? DASH}</div>
        <div><span className="k">Total shares: </span>{formatCount(s.totalShares[last])}</div>
        {coverageLines(s)}
      </div>
    ),
  }));
  return { rows, max };
}

function buildSectorRows(sectors: SectorSummary, last: number): { rows: DivRow[]; max: number } {
  const withNet = sectors.sectors
    .map((r) => ({ sector: r.sector, net: r.netShareChange[last] }))
    .filter((x): x is { sector: string; net: number } => x.net != null && x.net !== 0);
  withNet.sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
  const picked = withNet.slice(0, 12).sort((a, b) => b.net - a.net);
  const max = Math.max(1, ...picked.map((x) => Math.abs(x.net)));
  const rows: DivRow[] = picked.map((x) => ({
    key: x.sector,
    label: x.sector,
    value: x.net,
    tip: (
      <div>
        <div className="t-label">{x.sector}</div>
        <div style={{ marginTop: 4 }}>
          <span className="k">Net change: </span>{formatSignedCount(x.net)} shares
        </div>
        <div className="k">{x.net > 0 ? "Money flowing in" : "Money flowing out"}</div>
      </div>
    ),
  }));
  return { rows, max };
}
