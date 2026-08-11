import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { DASH, formatCount, formatSignedExact } from "../lib/format";
import { LineChart, Sparkline } from "./charts";
import { useTooltip } from "./Tooltip";

/**
 * Click-to-open trend view. Any sparkline can be turned into a clickable
 * <TrendSpark>: hovering peeks the numbers, clicking opens a modal with a full
 * line chart AND a month-by-month table of the real figures (a tiny sparkline
 * alone can't show the actual numbers).
 */
export interface TrendPayload {
  title: string;
  subtitle?: string;
  monthLabels: string[];
  values: (number | null)[];
}

interface TrendApi { openTrend: (p: TrendPayload) => void; }
const Ctx = createContext<TrendApi>({ openTrend: () => {} });
export const useTrend = (): TrendApi => useContext(Ctx);

export function TrendProvider({ children }: { children: ReactNode }) {
  const [payload, setPayload] = useState<TrendPayload | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPayload(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <Ctx.Provider value={{ openTrend: setPayload }}>
      {children}
      {payload && <TrendModal payload={payload} onClose={() => setPayload(null)} />}
    </Ctx.Provider>
  );
}

function TrendModal({ payload, onClose }: { payload: TrendPayload; onClose: () => void }) {
  const { title, subtitle, monthLabels, values } = payload;
  const changes = values.map((v, i) => (i === 0 || v == null || values[i - 1] == null ? null : v - (values[i - 1] as number)));
  const rows = monthLabels.map((label, i) => ({ label, v: values[i], c: changes[i] })).reverse(); // newest first
  const known = values.filter((v) => v != null).length;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div style={{ minWidth: 0 }}>
            <div className="t-section">{title}</div>
            {subtitle && <div className="t-muted" style={{ marginTop: 1 }}>{subtitle}</div>}
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {known >= 2 ? (
          <div style={{ marginTop: 12 }}>
            <LineChart values={values} labels={monthLabels} netChanges={changes} />
          </div>
        ) : (
          <div className="t-muted" style={{ margin: "12px 0" }}>Not enough months yet to draw a trend.</div>
        )}

        <div className="t-section" style={{ marginTop: 16, marginBottom: 4 }}>Month by month</div>
        <div className="trend-table trend-head"><span>Month</span><span className="cell-r">Shares held</span><span className="cell-r">Change</span></div>
        <div className="trend-table-wrap">
          {rows.map((r, i) => (
            <div key={i} className="trend-table trend-row">
              <span className="t-body">{r.label}</span>
              <span className="cell-r num t-body">{formatCount(r.v)}</span>
              <span className="cell-r num t-body" style={{ color: r.c == null ? "var(--muted)" : r.c > 0 ? "var(--buy)" : r.c < 0 ? "var(--sell)" : "var(--ink-2)" }}>
                {r.c == null ? DASH : <>{r.c > 0 ? "▲" : r.c < 0 ? "▼" : ""} {formatSignedExact(r.c)}</>}
              </span>
            </div>
          ))}
        </div>
        <div className="t-muted" style={{ marginTop: 8 }}>Exact disclosed share counts. &quot;—&quot; means a month with no comparable data.</div>
      </div>
    </div>
  );
}

/** A sparkline that peeks on hover and opens the full trend on click. */
export function TrendSpark({ values, title, subtitle, monthLabels }: TrendPayload) {
  const { openTrend } = useTrend();
  const tt = useTooltip();
  const tip = (
    <div>
      <div className="t-label">{title}</div>
      <div className="k" style={{ marginTop: 2 }}>Click for full chart + numbers</div>
    </div>
  );
  return (
    <span
      className="spark-click"
      title="Click for the full trend + monthly numbers"
      onClick={(e) => { e.stopPropagation(); openTrend({ title, subtitle, monthLabels, values }); }}
      onMouseEnter={(e) => tt.show(tip, e.clientX, e.clientY)}
      onMouseMove={(e) => tt.move(e.clientX, e.clientY)}
      onMouseLeave={tt.hide}
    >
      <Sparkline values={values} />
    </span>
  );
}
