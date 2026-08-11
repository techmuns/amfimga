import { useMemo, useState } from "react";
import type { MarketCap, StockRow, StocksSummary } from "../types/holdings";
import type { SectorScale } from "../lib/palette";
import { DASH, formatCount, formatSignedCount } from "../lib/format";
import { navigate } from "../lib/router";
import { CapFilter, CapPill, capPass } from "./caps";
import { Sparkline } from "./charts";
import { useTooltip } from "./Tooltip";

type SortKey = "name" | "sector" | "shares" | "net" | "funds";
type Dir = "asc" | "desc";

const ROW = 40;
const VIEW = 560;
const HEADER = 37;
const OVERSCAN = 6;

export function StockTable({
  data,
  scale,
  monthIdx,
}: {
  data: StocksSummary;
  scale: SectorScale;
  monthIdx: number;
}) {
  const [q, setQ] = useState("");
  const [sectors, setSectors] = useState<Set<string>>(new Set());
  const [otherOn, setOtherOn] = useState(false);
  const [capSel, setCapSel] = useState<Set<MarketCap>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; dir: Dir }>({ key: "net", dir: "desc" });
  const [scrollTop, setScrollTop] = useState(0);

  const m = monthIdx;

  const maxNet = useMemo(() => {
    let x = 0;
    for (const s of data.stocks) {
      const n = s.netShareChange[m];
      if (n != null) x = Math.max(x, Math.abs(n));
    }
    return x;
  }, [data, m]);

  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase();
    let list = data.stocks;
    if (ql) list = list.filter((s) => s.name.toLowerCase().includes(ql));
    if (sectors.size || otherOn) {
      list = list.filter(
        (s) => (s.macroSector != null && sectors.has(s.macroSector)) || (otherOn && scale.isOther(s.macroSector)),
      );
    }
    if (capSel.size) list = list.filter((s) => capPass(s.marketCap, capSel));
    const dir = sort.dir === "asc" ? 1 : -1;
    const key = (s: StockRow): number | string | null => {
      switch (sort.key) {
        case "name": return s.name.toLowerCase();
        case "sector": return (s.macroSector ?? "￿").toLowerCase();
        case "shares": return s.totalShares[m];
        case "net": return s.netShareChange[m];
        case "funds": return s.fundCount[m];
      }
    };
    return [...list].sort((a, b) => {
      const av = key(a);
      const bv = key(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1; // unknown always last
      if (bv == null) return -1;
      if (typeof av === "string") return av < (bv as string) ? -dir : av > (bv as string) ? dir : 0;
      return ((av as number) - (bv as number)) * dir;
    });
  }, [data, q, sectors, otherOn, capSel, sort, scale, m]);

  const toggleCap = (c: MarketCap) =>
    setCapSel((prev) => {
      const n = new Set(prev);
      if (n.has(c)) n.delete(c);
      else n.add(c);
      return n;
    });

  const eff = Math.max(0, scrollTop - HEADER);
  const start = Math.max(0, Math.floor(eff / ROW) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((eff + VIEW) / ROW) + OVERSCAN);
  const windowRows = rows.slice(start, end);

  const toggleSector = (sec: string) =>
    setSectors((prev) => {
      const n = new Set(prev);
      if (n.has(sec)) n.delete(sec);
      else n.add(sec);
      return n;
    });
  const clickSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "name" || key === "sector" ? "asc" : "desc" },
    );

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          className="searchbox"
          style={{ minWidth: 190 }}
          placeholder="Search stocks…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="flex flex-wrap gap-1.5">
          {scale.top.map((sec, i) => (
            <button
              key={sec}
              className="fchip"
              data-active={sectors.has(sec)}
              onClick={() => toggleSector(sec)}
              style={sectors.has(sec) ? { background: `var(--sector-${i + 1})` } : undefined}
            >
              <span className="sec-dot" style={{ background: `var(--sector-${i + 1})` }} />
              {sec}
            </button>
          ))}
          <button
            className="fchip"
            data-active={otherOn}
            onClick={() => setOtherOn((v) => !v)}
            style={otherOn ? { background: "var(--sector-other)" } : undefined}
          >
            <span className="sec-dot" style={{ background: "var(--sector-other)" }} />
            Other
          </button>
        </div>
        <span className="t-muted" style={{ marginLeft: 6 }}>Cap:</span>
        <CapFilter selected={capSel} onToggle={toggleCap} />
        <span className="t-muted ml-auto">{rows.length.toLocaleString("en-IN")} stocks</span>
      </div>

      <div
        className="panel"
        style={{ height: VIEW, overflow: "auto" }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div
          className="stock-grid stock-head"
          style={{ position: "sticky", top: 0, zIndex: 2, background: "var(--surface)", height: HEADER, alignContent: "center", padding: "0 14px" }}
        >
          <Th label="Stock" k="name" sort={sort} on={clickSort} />
          <Th label="Sector" k="sector" sort={sort} on={clickSort} />
          <span className="t-label" style={{ color: "var(--ink-2)" }}>Trend</span>
          <Th label="Total shares" k="shares" sort={sort} on={clickSort} right />
          <Th label="Net change" k="net" sort={sort} on={clickSort} right />
          <Th label="Funds" k="funds" sort={sort} on={clickSort} right />
        </div>

        <div style={{ height: rows.length * ROW, position: "relative" }}>
          <div style={{ position: "absolute", top: start * ROW, left: 0, right: 0 }}>
            {windowRows.map((s) => (
              <Row key={s.isin} s={s} scale={scale} m={m} maxNet={maxNet} labels={data.monthLabels} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Th({
  label,
  k,
  sort,
  on,
  right,
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; dir: Dir };
  on: (k: SortKey) => void;
  right?: boolean;
}) {
  const active = sort.key === k;
  return (
    <span className="th" onClick={() => on(k)} style={right ? { justifySelf: "end" } : undefined}>
      {label}
      <span className="arrow">{active ? (sort.dir === "asc" ? "▲" : "▼") : "⇅"}</span>
    </span>
  );
}

function Row({
  s,
  scale,
  m,
  maxNet,
  labels,
}: {
  s: StockRow;
  scale: SectorScale;
  m: number;
  maxNet: number;
  labels: string[];
}) {
  const tt = useTooltip();
  const net = s.netShareChange[m];
  const shares = s.totalShares[m];
  const funds = s.fundCount[m];
  const buy = net != null && net > 0;
  const sell = net != null && net < 0;
  const magW = net != null && maxNet > 0 ? Math.max(2, (Math.abs(net) / maxNet) * 100) : 0;
  const cov = s.coverageAffected ?? [];

  const netColor = buy ? "var(--buy)" : sell ? "var(--sell)" : "var(--ink-2)";

  const netTip = (
    <div>
      <div className="t-label">{s.name}</div>
      <div style={{ marginTop: 4 }}><span className="k">Net change: </span>{net == null ? DASH : formatSignedCount(net)}</div>
      <div><span className="k">Total shares: </span>{formatCount(shares)}</div>
      <div><span className="k">Funds holding: </span>{funds == null ? DASH : funds}</div>
      {cov.length > 0 && (
        <div style={{ marginTop: 6, color: "var(--ink-2)" }}>
          {cov.map((c, i) => (
            <div key={i}>
              {c.house}{" "}
              {c.direction === "entered"
                ? "entered the data this month — its shares aren't counted as buying."
                : "left the data this month — its previous shares aren't counted."}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const trendTip = (
    <div>
      <div className="t-label">{s.name}</div>
      {s.totalShares.map((v, i) => (
        <div key={i}><span className="k">{labels[i]}: </span>{formatCount(v)}</div>
      ))}
    </div>
  );

  return (
    <div
      className="stock-grid stock-row"
      style={{ height: ROW, padding: "0 14px", cursor: "pointer" }}
      onClick={() => navigate(`/stock/${s.isin}`)}
    >
      <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
        <span className="t-body" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.name}>
          {s.name}
        </span>
        <CapPill cap={s.marketCap} />
      </div>
      <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 6 }}>
        <span className="sec-dot" style={{ background: scale.colorOf(s.macroSector) }} />
        <span className="t-body" style={{ color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {s.macroSector ?? DASH}
        </span>
      </div>
      <div
        onMouseEnter={(e) => tt.show(trendTip, e.clientX, e.clientY)}
        onMouseMove={(e) => tt.move(e.clientX, e.clientY)}
        onMouseLeave={tt.hide}
      >
        <Sparkline values={s.totalShares} />
      </div>
      <div className="cell-r t-body num">{formatCount(shares)}</div>
      <div
        style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "flex-end", justifyContent: "center", cursor: cov.length ? "help" : "default" }}
        onMouseEnter={(e) => tt.show(netTip, e.clientX, e.clientY)}
        onMouseMove={(e) => tt.move(e.clientX, e.clientY)}
        onMouseLeave={tt.hide}
      >
        <div className="t-body num" style={{ color: netColor }}>
          {net == null ? DASH : (
            <>
              {buy ? "▲" : sell ? "▼" : ""} {formatSignedCount(net)}
              {cov.length > 0 && <span style={{ color: "var(--muted)" }}> *</span>}
            </>
          )}
        </div>
        {net != null && <div className="mag" style={{ width: `${magW}%`, background: buy ? "var(--buy)" : "var(--sell)" }} />}
      </div>
      <div className="cell-r t-body num">{funds == null ? DASH : funds}</div>
    </div>
  );
}
