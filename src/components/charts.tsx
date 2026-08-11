import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { DASH, formatCount, formatCountShort, formatSignedCount } from "../lib/format";
import { useTooltip } from "./Tooltip";

/** Measure a container's pixel width so charts render at exact sizes (no SVG scaling). */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(720);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () => setW(el.clientWidth || 720);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

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

/** Simple line chart of a value across months, with hover crosshair + tooltip. */
export function LineChart({
  values,
  labels,
  netChanges,
}: {
  values: (number | null)[];
  labels: string[];
  netChanges: (number | null)[];
}) {
  const tt = useTooltip();
  const [ref, W] = useWidth();
  const [hi, setHi] = useState<number | null>(null);
  const H = 200;
  const padL = 6;
  const padR = 6;
  const padT = 14;
  const padB = 24;
  const plotH = H - padT - padB;

  const pts = values
    .map((v, i) => ({ v, i }))
    .filter((p): p is { v: number; i: number } => p.v != null);

  const lo = pts.length ? Math.min(...pts.map((p) => p.v)) : 0;
  const peak = pts.length ? Math.max(...pts.map((p) => p.v)) : 1;
  const pad = (peak - lo) * 0.12 || 1;
  const yMin = lo - pad;
  const yMax = peak + pad;
  const n = values.length;
  const x = (i: number) => padL + (n <= 1 ? (W - padL - padR) / 2 : (i / (n - 1)) * (W - padL - padR));
  const y = (v: number) => padT + (yMax === yMin ? plotH / 2 : (1 - (v - yMin) / (yMax - yMin)) * plotH);
  const d = pts.map((p, k) => `${k ? "L" : "M"}${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
  const grid = [yMax, (yMax + yMin) / 2, yMin];

  const tipFor = (i: number) => (
    <div>
      <div className="t-label">{labels[i]}</div>
      <div style={{ marginTop: 4 }}><span className="k">Total shares: </span>{formatCount(values[i])}</div>
      <div>
        <span className="k">Net change: </span>
        {netChanges[i] == null ? DASH : (
          <span style={{ color: netChanges[i]! >= 0 ? "var(--buy)" : "var(--sell)" }}>
            {netChanges[i]! >= 0 ? "▲" : "▼"} {formatSignedCount(netChanges[i])}
          </span>
        )}
      </div>
    </div>
  );

  return (
    <div ref={ref}>
      <svg width={W} height={H} style={{ display: "block" }}>
        {grid.map((gv, k) => (
          <g key={k}>
            <line x1={padL} x2={W - padR} y1={y(gv)} y2={y(gv)} stroke="var(--grid)" strokeWidth="1" />
            <text x={padL} y={y(gv) - 3} fill="var(--muted)" fontSize="12">{formatCountShort(gv)}</text>
          </g>
        ))}
        <path d={d} fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {pts.map((p) => <circle key={p.i} cx={x(p.i)} cy={y(p.v)} r="2.5" fill="var(--ink)" />)}
        {hi != null && values[hi] != null && (
          <>
            <line x1={x(hi)} x2={x(hi)} y1={padT} y2={padT + plotH} stroke="var(--axis)" strokeWidth="1" strokeDasharray="3 3" />
            <circle cx={x(hi)} cy={y(values[hi]!)} r="4" fill="var(--ink)" />
          </>
        )}
        {labels.map((l, i) => (
          <text
            key={i}
            x={x(i)}
            y={H - 7}
            fill="var(--muted)"
            fontSize="12"
            textAnchor={i === 0 ? "start" : i === labels.length - 1 ? "end" : "middle"}
          >
            {l}
          </text>
        ))}
        {values.map((_, i) => (
          <rect
            key={i}
            x={x(i) - (W - padL - padR) / (2 * Math.max(1, n - 1))}
            y={0}
            width={(W - padL - padR) / Math.max(1, n - 1)}
            height={H}
            fill="transparent"
            onMouseEnter={(e) => { setHi(i); tt.show(tipFor(i), e.clientX, e.clientY); }}
            onMouseMove={(e) => tt.move(e.clientX, e.clientY)}
            onMouseLeave={() => { setHi(null); tt.hide(); }}
          />
        ))}
      </svg>
    </div>
  );
}

/** Monthly net-change bars: green when funds net-bought, red when they net-sold. */
export function NetBars({ values, labels }: { values: (number | null)[]; labels: string[] }) {
  const tt = useTooltip();
  const max = Math.max(1, ...values.map((v) => (v == null ? 0 : Math.abs(v))));
  return (
    <div>
      <div style={{ display: "flex", height: 120, position: "relative" }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: "50%", borderTop: "1px solid var(--axis)" }} />
        {values.map((v, i) => (
          <div
            key={i}
            style={{ flex: 1, position: "relative", cursor: v == null ? "default" : "default" }}
            onMouseEnter={(e) => v != null && tt.show(
              <div>
                <div className="t-label">{labels[i]}</div>
                <div style={{ marginTop: 4, color: v >= 0 ? "var(--buy)" : "var(--sell)" }}>
                  {v >= 0 ? "▲ Net bought" : "▼ Net sold"}: {formatSignedCount(v)} shares
                </div>
              </div>, e.clientX, e.clientY,
            )}
            onMouseMove={(e) => tt.move(e.clientX, e.clientY)}
            onMouseLeave={tt.hide}
          >
            {v != null && (
              <div
                style={{
                  position: "absolute", left: "50%", transform: "translateX(-50%)", width: 26,
                  ...(v >= 0
                    ? { bottom: "50%", height: `${(Math.abs(v) / max) * 50}%`, background: "var(--buy)", borderRadius: "3px 3px 0 0" }
                    : { top: "50%", height: `${(Math.abs(v) / max) * 50}%`, background: "var(--sell)", borderRadius: "0 0 3px 3px" }),
                }}
              />
            )}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", marginTop: 4 }}>
        {labels.map((l, i) => <div key={i} className="t-muted" style={{ flex: 1, textAlign: "center" }}>{l}</div>)}
      </div>
    </div>
  );
}
