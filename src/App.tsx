import { useEffect, useMemo, useState } from "react";
import type { FundsIndex, SectorSummary, StocksSummary, SummaryMeta } from "./types/holdings";
import { loadFundsIndex, loadSectors, loadStocks, loadSummary } from "./lib/data";
import { makeSectorScale } from "./lib/palette";
import { navigate, useRoute } from "./lib/router";
import { exportExcel } from "./lib/exportExcel";
import { exportPdf } from "./lib/exportPdf";
import { TooltipProvider } from "./components/Tooltip";
import { TrendProvider } from "./components/Trend";
import { ThemeToggle } from "./components/ThemeToggle";
import { StockTable } from "./components/StockTable";
import { StockDetailPage } from "./components/StockDetail";
import { IdeasPage } from "./components/Ideas";
import { FundDetailPage, FundsPage } from "./components/FundView";
import { Overview } from "./components/Overview";

type Data = { summary: SummaryMeta; stocks: StocksSummary; sectors: SectorSummary };
type LoadState = { status: "loading" } | { status: "error"; reason: string } | { status: "ready"; data: Data };

type Tab = "overview" | "stocks" | "funds" | "ideas";
const TABS: { id: Tab; label: string; path: string }[] = [
  { id: "overview", label: "Overview", path: "/" },
  { id: "stocks", label: "Stocks", path: "/stocks" },
  { id: "funds", label: "Funds", path: "/funds" },
  { id: "ideas", label: "Ideas", path: "/ideas" },
];

export function App() {
  const path = useRoute();
  const stockMatch = path.match(/^\/stock\/([^/]+)$/);
  const fundMatch = path.match(/^\/fund\/([^/]+)$/);
  const content = stockMatch ? (
    <StockDetailPage isin={decodeURIComponent(stockMatch[1])} />
  ) : fundMatch ? (
    <FundDetailPage file={decodeURIComponent(fundMatch[1])} />
  ) : (
    <Tabbed path={path} />
  );
  return (
    <TooltipProvider>
      <TrendProvider>
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "20px 24px 72px" }}>{content}</div>
      </TrendProvider>
    </TooltipProvider>
  );
}

function Tabbed({ path }: { path: string }) {
  const active: Tab = path === "/stocks" ? "stocks" : path.startsWith("/funds") ? "funds" : path === "/ideas" ? "ideas" : "overview";
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let off = false;
    Promise.all([loadSummary(), loadStocks(), loadSectors()])
      .then(([summary, stocks, sectors]) => !off && setState({ status: "ready", data: { summary, stocks, sectors } }))
      .catch((err: unknown) => !off && setState({ status: "error", reason: err instanceof Error ? err.message : "Unknown error" }));
    return () => { off = true; };
  }, []);

  const data = state.status === "ready" ? state.data : null;
  const month = data?.summary.months[data.summary.months.length - 1];

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-name">
            Mutual Fund Ownership Insights
            {month && (
              <span
                className="info-i"
                title={`India has about ${month.housesTotal} fund houses. We have ${month.label}'s data for ${month.housesPresent} of them — the rest either haven't published this month yet or couldn't be fetched, and are NEVER shown as zero (they read "—"). Month-over-month changes only compare houses present in BOTH months, so a house simply appearing is never mistaken for buying.`}
              >i</span>
            )}
          </span>
          <span className="brand-sub">{month ? `Based on ${month.housesPresent} of ${month.housesTotal} fund houses · ${month.label}` : " "}</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {data && <ExportMenu data={data} />}
          <ThemeToggle />
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className="tab" data-active={active === t.id} onClick={() => navigate(t.path)}>
            {t.label}
          </button>
        ))}
      </nav>

      {state.status === "loading" && <p className="t-muted" style={{ marginTop: 24 }}>Loading…</p>}
      {state.status === "error" && <p className="t-body" style={{ marginTop: 24, color: "var(--sell)" }}>Couldn&apos;t load data: {state.reason}</p>}
      {data && (
        <div style={{ marginTop: 18 }}>
          {active === "overview" && <Overview data={data} />}
          {active === "stocks" && <StocksTab data={data} />}
          {active === "funds" && <FundsPage embedded />}
          {active === "ideas" && <IdeasPage embedded />}
        </div>
      )}
    </>
  );
}

function StocksTab({ data }: { data: Data }) {
  const scale = useMemo(() => makeSectorScale(data.summary.topSectors), [data.summary]);
  const last = data.stocks.months.length - 1;
  return (
    <section>
      <h1 className="t-page">All stocks</h1>
      <div className="t-muted" style={{ margin: "3px 0 14px" }}>
        Every stock mutual funds hold, this month. Search, filter by sector or cap, sort any column — click a row for its full history.
      </div>
      <StockTable data={data.stocks} scale={scale} monthIdx={last} />
    </section>
  );
}

function ExportMenu({ data }: { data: Data }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<null | "xlsx" | "pdf">(null);

  const doExcel = async () => {
    setBusy("xlsx");
    try {
      let funds: FundsIndex | null = null;
      try { funds = await loadFundsIndex(); } catch { /* funds sheet is optional */ }
      await exportExcel(data.summary, data.stocks, data.sectors, funds);
    } catch (e) { alert("Excel export failed: " + (e instanceof Error ? e.message : "error")); }
    setBusy(null); setOpen(false);
  };
  const doPdf = () => {
    setBusy("pdf");
    try {
      const colorOf = makeSectorScale(data.summary.topSectors).colorOf;
      exportPdf(data.summary, data.stocks, data.sectors, colorOf);
    } catch (e) { alert("PDF export failed: " + (e instanceof Error ? e.message : "error")); }
    setBusy(null); setOpen(false);
  };

  return (
    <div style={{ position: "relative" }} onMouseLeave={() => setOpen(false)}>
      <button className="theme-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="menu">
        Export ▾
      </button>
      {open && (
        <div className="panel menu" role="menu">
          <button className="menu-item" onClick={doExcel} disabled={busy != null}>
            {busy === "xlsx" ? "Building…" : "Excel (.xlsx)"}
          </button>
          <button className="menu-item" onClick={doPdf} disabled={busy != null}>
            {busy === "pdf" ? "Opening…" : "PDF report"}
          </button>
        </div>
      )}
    </div>
  );
}
