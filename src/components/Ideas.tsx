import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { MarketCap, StockRow, StocksSummary, SummaryMeta } from "../types/holdings";
import { loadStocks, loadSummary } from "../lib/data";
import { navigate } from "../lib/router";
import { makeSectorScale, type SectorScale } from "../lib/palette";
import { DASH, formatSignedCount } from "../lib/format";
import { CapFilter, CapPill, capPass } from "./caps";
import { Sparkline } from "./charts";
import { ThemeToggle } from "./ThemeToggle";

type State =
  | { status: "loading" }
  | { status: "error"; reason: string }
  | { status: "ready"; summary: SummaryMeta; stocks: StocksSummary };

export function IdeasPage({ embedded }: { embedded?: boolean }) {
  const [state, setState] = useState<State>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    Promise.all([loadSummary(), loadStocks()])
      .then(([summary, stocks]) => !cancelled && setState({ status: "ready", summary, stocks }))
      .catch((err: unknown) => !cancelled && setState({ status: "error", reason: err instanceof Error ? err.message : "Unknown error" }));
    return () => { cancelled = true; };
  }, []);

  return (
    <>
      {!embedded && (
        <div className="mb-5 flex items-center justify-between">
          <button className="link t-body" onClick={() => navigate("/")}>← Overview</button>
          <ThemeToggle />
        </div>
      )}
      <h1 className="t-page">Ideas</h1>
      <div className="t-muted" style={{ marginTop: 3 }}>Where the opportunities are hiding this month — each list is sortable; click a stock for detail.</div>
      {state.status === "loading" && <p className="t-muted" style={{ marginTop: 20 }}>Loading…</p>}
      {state.status === "error" && <p className="t-body" style={{ marginTop: 20, color: "var(--sell)" }}>Couldn&apos;t load data: {state.reason}</p>}
      {state.status === "ready" && <Ideas summary={state.summary} stocks={state.stocks} />}
    </>
  );
}

function Ideas({ summary, stocks }: { summary: SummaryMeta; stocks: StocksSummary }) {
  const L = stocks.months.length - 1;
  const scale = useMemo(() => makeSectorScale(summary.topSectors), [summary]);
  const firstMonth = stocks.monthLabels[0];
  const [capSel, setCapSel] = useState<Set<MarketCap>>(new Set());
  const toggleCap = (c: MarketCap) =>
    setCapSel((prev) => { const n = new Set(prev); n.has(c) ? n.delete(c) : n.add(c); return n; });
  const all = useMemo(() => (capSel.size ? stocks.stocks.filter((s) => capPass(s.marketCap, capSel)) : stocks.stocks), [stocks, capSel]);

  const buys = useMemo(() => all.filter((s) => (s.netShareChange[L] ?? 0) > 0), [all, L]);
  const sells = useMemo(() => all.filter((s) => (s.netShareChange[L] ?? 0) < 0), [all, L]);
  const newEntries = useMemo(() => all.filter((s) => s.newEntry), [all]);
  const turned = useMemo(() => all.filter((s) => {
    const a = s.netShareChange[L - 1], b = s.netShareChange[L];
    return a != null && b != null && a !== 0 && b !== 0 && Math.sign(a) !== Math.sign(b);
  }), [all, L]);
  const fewFunds = useMemo(() => all.filter((s) => {
    const c = s.fundCount[L];
    return (c != null && c <= 3) || (s.topHolder != null && s.topHolder.sharePct >= 70);
  }), [all, L]);

  const spark = (r: StockRow) => <Sparkline values={r.totalShares} />;
  const stockCol: Col = { label: "Stock", render: (r) => <StockCell r={r} scale={scale} /> };
  const trendCol: Col = { label: "Trend", render: spark };
  const netCol: Col = { label: "Net change", align: "right", sortValue: (r) => r.netShareChange[L], render: (r) => <Change v={r.netShareChange[L]} note={coverageNote(r)} /> };

  const [sub, setSub] = useState(0);
  const SUBS = ["Buying & selling", "Brand-new entries", "Turned around", "Held by few funds"];

  return (
    <div>
      <nav className="subtabs" style={{ marginTop: 16 }}>
        {SUBS.map((s, i) => (
          <button key={s} className="subtab" data-active={sub === i} onClick={() => setSub(i)}>{s}</button>
        ))}
      </nav>
      <div className="flex flex-wrap items-center gap-2" style={{ margin: "14px 0 2px" }}>
        <span className="t-muted">Market cap:</span>
        <CapFilter selected={capSel} onToggle={toggleCap} />
      </div>

      {sub === 0 && (
        <Section title="Funds are buying / selling these" subtitle="The biggest net buys and net sells this month. The more funds moving the same way, the broader the signal.">
          <SubLabel color="var(--buy)">Buying</SubLabel>
          <RankedTable
            rows={buys}
            grid="minmax(190px,2fr) 150px 140px 76px"
            initialSort={1} initialDir={-1}
            columns={[stockCol, netCol, { label: "Funds", align: "right", sortValue: (r) => r.fundsBuying ?? null, render: (r) => <AddTrim r={r} /> }, trendCol]}
          />
          <SubLabel color="var(--sell)" top>Selling</SubLabel>
          <RankedTable
            rows={sells}
            grid="minmax(190px,2fr) 150px 140px 76px"
            initialSort={1} initialDir={1}
            columns={[stockCol, netCol, { label: "Funds", align: "right", sortValue: (r) => r.fundsSelling ?? null, render: (r) => <AddTrim r={r} /> }, trendCol]}
          />
        </Section>
      )}

      {sub === 1 && (
        <Section title="Brand-new to mutual funds" subtitle={`Stocks funds started holding this month. Our data starts ${firstMonth}, so “new” means first seen since then — coverage changes are excluded.`}>
          {newEntries.length === 0 ? (
            <Empty>No brand-new entries this month.</Empty>
          ) : (
            <RankedTable
              rows={newEntries}
              grid="minmax(220px,2fr) 120px 150px 76px"
              initialSort={1} initialDir={-1}
              columns={[
                stockCol,
                { label: "Funds now", align: "right", sortValue: (r) => r.fundCount[L], render: (r) => <Plain v={r.fundCount[L]} /> },
                netCol,
                trendCol,
              ]}
            />
          )}
        </Section>
      )}

      {sub === 2 && (
        <Section title="Turned around" subtitle="Flow flipped direction — net selling then net buying, or the reverse. The sparkline shows the turn; this gets richer after more months of history.">
          {turned.length === 0 ? (
            <Empty>No turnarounds yet — needs a few months of history.</Empty>
          ) : (
            <RankedTable
              rows={turned}
              grid="minmax(200px,2fr) 140px 140px 76px"
              initialSort={2} initialDir={-1}
              columns={[
                stockCol,
                { label: "Last month", align: "right", render: (r) => <Change v={r.netShareChange[L - 1]} /> },
                { label: "This month", align: "right", sortValue: (r) => r.netShareChange[L], render: (r) => <Change v={r.netShareChange[L]} /> },
                trendCol,
              ]}
            />
          )}
        </Section>
      )}

      {sub === 3 && (
        <Section title="Held by only a few funds" subtitle="Under-owned names — held by just 1–3 funds, or where one fund owns most of the fund-held shares. The contrarian / unique picks.">
          <RankedTable
            rows={fewFunds}
            grid="minmax(200px,2fr) 90px minmax(150px,1fr) 76px"
            initialSort={1} initialDir={1}
            columns={[
              stockCol,
              { label: "Funds", align: "right", sortValue: (r) => r.fundCount[L], render: (r) => <Plain v={r.fundCount[L]} /> },
              { label: "Biggest holder", sortValue: (r) => r.topHolder?.sharePct ?? null, render: (r) => <TopHolder r={r} /> },
              trendCol,
            ]}
          />
        </Section>
      )}
    </div>
  );
}

// --- table primitives ---

interface Col {
  label: string;
  align?: "right";
  sortValue?: (r: StockRow) => number | string | null;
  render: (r: StockRow) => ReactNode;
}

function RankedTable({
  rows, columns, grid, initialSort = 0, initialDir = -1, pageSize = 15,
}: {
  rows: StockRow[];
  columns: Col[];
  grid: string;
  initialSort?: number;
  initialDir?: 1 | -1;
  pageSize?: number;
}) {
  const [sortIdx, setSortIdx] = useState(initialSort);
  const [dir, setDir] = useState<1 | -1>(initialDir);
  const [all, setAll] = useState(false);

  const sorted = useMemo(() => {
    const f = columns[sortIdx]?.sortValue;
    if (!f) return rows;
    return [...rows].sort((a, b) => {
      const av = f(a), bv = f(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string") return av < (bv as string) ? -dir : av > (bv as string) ? dir : 0;
      return ((av as number) - (bv as number)) * dir;
    });
  }, [rows, columns, sortIdx, dir]);

  const shown = all ? sorted : sorted.slice(0, pageSize);
  const cell = (align?: "right"): React.CSSProperties => ({ minWidth: 0, textAlign: align === "right" ? "right" : "left" });

  return (
    <div className="panel" style={{ overflow: "hidden" }}>
      <div className="stock-head" style={{ display: "grid", gridTemplateColumns: grid, alignItems: "center", columnGap: 12, padding: "8px 14px" }}>
        {columns.map((c, i) => (
          <div key={i} style={cell(c.align)}>
            {c.sortValue ? (
              <span className="th" onClick={() => (i === sortIdx ? setDir((d) => (d === 1 ? -1 : 1)) : (setSortIdx(i), setDir(-1)))}>
                {c.label} <span className="arrow">{i === sortIdx ? (dir === 1 ? "▲" : "▼") : "⇅"}</span>
              </span>
            ) : (
              <span className="t-label" style={{ color: "var(--ink-2)" }}>{c.label}</span>
            )}
          </div>
        ))}
      </div>
      {shown.map((r) => (
        <div
          key={r.isin}
          className="stock-row"
          style={{ display: "grid", gridTemplateColumns: grid, alignItems: "center", columnGap: 12, padding: "8px 14px", cursor: "pointer" }}
          onClick={() => navigate(`/stock/${r.isin}`)}
        >
          {columns.map((c, i) => <div key={i} style={cell(c.align)}>{c.render(r)}</div>)}
        </div>
      ))}
      {sorted.length > pageSize && (
        <div style={{ padding: "8px 14px", borderTop: "1px solid var(--border)" }}>
          <button className="link t-body" onClick={() => setAll((a) => !a)}>
            {all ? `Show top ${pageSize}` : `Show all ${sorted.length}`}
          </button>
        </div>
      )}
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <section style={{ marginTop: 30 }}>
      <div className="t-section">{title}</div>
      <div className="t-muted" style={{ margin: "2px 0 10px", maxWidth: 720 }}>{subtitle}</div>
      {children}
    </section>
  );
}

function SubLabel({ children, color, top }: { children: ReactNode; color: string; top?: boolean }) {
  return <div className="t-label" style={{ color, margin: top ? "14px 0 6px" : "0 0 6px" }}>{children}</div>;
}

function StockCell({ r, scale }: { r: StockRow; scale: SectorScale }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span className="t-body" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
        <CapPill cap={r.marketCap} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
        <span className="sec-dot" style={{ background: scale.colorOf(r.macroSector) }} />
        <span className="t-muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.macroSector ?? DASH}</span>
      </div>
    </div>
  );
}

function coverageNote(r: StockRow): string | undefined {
  if (!r.coverageAffected?.length) return undefined;
  return r.coverageAffected
    .map((c) => `${c.house} ${c.direction === "entered" ? "entered the data this month — its shares aren't counted as buying." : "left the data this month — its previous shares aren't counted."}`)
    .join(" ");
}

function Change({ v, note }: { v: number | null | undefined; note?: string }) {
  if (v == null) return <span className="num" style={{ color: "var(--muted)" }} title={note}>{DASH}</span>;
  const up = v > 0, down = v < 0;
  return (
    <span className="num" style={{ color: up ? "var(--buy)" : down ? "var(--sell)" : "var(--ink-2)" }} title={note}>
      {up ? "▲" : down ? "▼" : ""} {formatSignedCount(v)}{note ? <span style={{ color: "var(--muted)" }}> *</span> : null}
    </span>
  );
}

function Plain({ v }: { v: number | null | undefined }) {
  return <span className="num t-body">{v == null ? DASH : v.toLocaleString("en-IN")}</span>;
}

function AddTrim({ r }: { r: StockRow }) {
  return (
    <span className="t-muted" style={{ fontVariantNumeric: "tabular-nums" }}>
      <span style={{ color: "var(--buy)" }}>{r.fundsBuying ?? DASH}</span> add ·{" "}
      <span style={{ color: "var(--sell)" }}>{r.fundsSelling ?? DASH}</span> trim
    </span>
  );
}

function TopHolder({ r }: { r: StockRow }) {
  if (!r.topHolder) return <span className="t-muted">{DASH}</span>;
  return (
    <span className="t-body" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>
      <span className="num" style={{ fontWeight: 600 }}>{Math.round(r.topHolder.sharePct)}%</span>{" "}
      <span className="t-muted">{r.topHolder.fundHouse}</span>
    </span>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="panel t-muted" style={{ padding: "14px" }}>{children}</div>;
}
