import type { ReactNode } from "react";
import { formatSignedCount } from "../lib/format";
import { useTooltip } from "./Tooltip";

/** Tiny inline sparkline: a 2px line, no dots except on hover. */
export function Sparkline({
  values,
  width = 60,
  height = 18,
}: {
  values: (number | null)[];
  width?: number;
  height?: number;
}) {
  const pts = values
    .map((v, i) => ({ v, i }))
    .filter((p): p is { v: number; i: number } => p.v != null);
  if (pts.length < 2) return <svg width={width} height={height} aria-hidden />;

  const span = Math.max(1, values.length - 1);
  const x = (i: number) => (i / span) * (width - 2) + 1;
  const lo = Math.min(...pts.map((p) => p.v));
  const hi = Math.max(...pts.map((p) => p.v));
  const y = (v: number) => (hi === lo ? height / 2 : height - 2 - ((v - lo) / (hi - lo)) * (height - 4));
  const d = pts.map((p, k) => `${k ? "L" : "M"}${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];

  return (
    <svg className="spark" width={width} height={height} aria-hidden>
      <path d={d} fill="none" stroke="var(--ink-2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle className="spark-dot" cx={x(last.i)} cy={y(last.v)} r="2.4" fill="var(--ink-2)" />
    </svg>
  );
}

export interface DivRow {
  key: string;
  label: string;
  value: number; // signed; >=0 → buy/inflow (right, green), <0 → sell/outflow (left, red)
  tip: ReactNode;
}

/**
 * Horizontal diverging bars: outflows/sells to the left (red), inflows/buys to
 * the right (green). Meaning is carried by sign + arrow as well as colour.
 * Caller sorts `rows` (biggest inflow first → biggest outflow last).
 */
export function DivergingBars({ rows, maxAbs }: { rows: DivRow[]; maxAbs: number }) {
  const tt = useTooltip();
  return (
    <div className="div-chart">
      {rows.map((r) => {
        const w = maxAbs > 0 ? Math.max(1, (Math.abs(r.value) / maxAbs) * 100) : 0;
        const buy = r.value >= 0;
        return (
          <div
            key={r.key}
            className="div-row"
            onMouseEnter={(e) => tt.show(r.tip, e.clientX, e.clientY)}
            onMouseMove={(e) => tt.move(e.clientX, e.clientY)}
            onMouseLeave={tt.hide}
          >
            <div className="div-label t-body" title={r.label}>
              {r.label}
            </div>
            <div className="div-half left">
              {!buy && (
                <>
                  <span className="div-val val-sell">▼ {formatSignedCount(r.value)}</span>
                  <span className="bar-sell div-bar" style={{ width: `${w}%` }} />
                </>
              )}
            </div>
            <div className="div-half right">
              {buy && (
                <>
                  <span className="bar-buy div-bar" style={{ width: `${w}%` }} />
                  <span className="div-val val-buy">▲ {formatSignedCount(r.value)}</span>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
