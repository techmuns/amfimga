import { useMemo, type ReactNode } from "react";
import type { SectorSummary, StocksSummary, SummaryMeta } from "../types/holdings";
import { buildReport, CAP_LABEL } from "../lib/report";
import { DASH, formatSignedCount } from "../lib/format";
import { navigate } from "../lib/router";
import { DivergingBars, type DivRow } from "./charts";
import { useTooltip } from "./Tooltip";

/** The Overview tab: the market at a glance — macro flows only, no stock leaderboards. */
export function Overview({ data }: { data: { summary: SummaryMeta; stocks: StocksSummary; sectors: SectorSummary } }) {
  const model = useMemo(() => buildReport(data.summary, data.stocks, data.sectors), [data]);

  const sectorRows: DivRow[] = model.sectors.slice(0, 12).map((s) => ({
    key: s.sector,
    label: s.sector,
    value: s.net,
    tip: (
      <div>
        <div className="t-label">{s.sector}</div>
        <div style={{ marginTop: 4 }}><span className="k">Net change: </span>{formatSignedCount(s.net)} shares</div>
        <div className="k">{s.net > 0 ? "Money flowing in" : "Money flowing out"}</div>
      </div>
    ),
  }));
  const sectorMax = Math.max(1, ...sectorRows.map((r) => Math.abs(r.value)));

  const capRows: DivRow[] = model.capFlows.map((c) => ({
    key: c.cap,
    label: CAP_LABEL[c.cap],
    value: c.net,
    tip: (
      <div>
        <div className="t-label">{CAP_LABEL[c.cap]}</div>
        <div style={{ marginTop: 4 }}><span className="k">Net change: </span>{formatSignedCount(c.net)} shares</div>
      </div>
    ),
  }));
  const capMax = Math.max(1, ...capRows.map((r) => Math.abs(r.value)));

  const month = data.summary.months[data.summary.months.length - 1];

  return (
    <section>
      <h1 className="t-page">The market at a glance</h1>
      <div className="t-muted" style={{ margin: "3px 0 6px", maxWidth: 720 }}>
        Where India&apos;s mutual funds moved in {month.label} — the macro picture, coverage-aware. The biggest-mover
        leaderboards live under <span className="link" onClick={() => navigate("/ideas")}>Ideas</span>.
      </div>

      <div className="ov-grid">
        <Panel title="Where the money moved" subtitle="Net share change by macro sector · green in, red out">
          {sectorRows.length ? <DivergingBars rows={sectorRows} maxAbs={sectorMax} /> : <Empty>No sector flows this month.</Empty>}
        </Panel>

        <Panel title="By market-cap band" subtitle="Net share change · large / mid / small (AMFI list)">
          {capRows.length ? <DivergingBars rows={capRows} maxAbs={capMax} /> : <Empty>No cap-tagged flows this month.</Empty>}
        </Panel>
      </div>

      <Panel title="Market breadth" subtitle={`How many stocks funds net-bought vs net-sold · ${model.breadth.measured} measured this month`}>
        <Breadth bought={model.breadth.bought} sold={model.breadth.sold} flat={model.breadth.flat} />
      </Panel>
    </section>
  );
}

function Panel({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <section className="panel ov-panel">
      <div className="t-section">{title}</div>
      <div className="t-muted" style={{ margin: "2px 0 12px" }}>{subtitle}</div>
      {children}
    </section>
  );
}

function Breadth({ bought, sold, flat }: { bought: number; sold: number; flat: number }) {
  const tt = useTooltip();
  const max = Math.max(1, bought, sold);
  const row = (label: string, n: number, color: string, arrow: string) => (
    <div
      className="breadth-row"
      onMouseEnter={(e) => tt.show(<div><div className="t-label">{label}</div><div style={{ marginTop: 4 }}>{n.toLocaleString("en-IN")} stocks</div></div>, e.clientX, e.clientY)}
      onMouseMove={(e) => tt.move(e.clientX, e.clientY)}
      onMouseLeave={tt.hide}
    >
      <span className="breadth-label" style={{ color }}>{arrow} {label}</span>
      <span className="breadth-track"><span className="breadth-fill" style={{ width: `${(n / max) * 100}%`, background: color }} /></span>
      <span className="num t-body" style={{ color, fontWeight: 600 }}>{n.toLocaleString("en-IN")}</span>
    </div>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {row("Bought", bought, "var(--buy)", "▲")}
      {row("Sold", sold, "var(--sell)", "▼")}
      <div className="t-muted" style={{ marginTop: 2 }}>
        {flat > 0 ? `${flat.toLocaleString("en-IN")} unchanged. ` : ""}
        Only stocks with a comparable prior month are counted; a house entering the data is never treated as buying.
      </div>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="t-muted" style={{ padding: "8px 0" }}>{DASH} {children}</div>;
}
