import { useEffect, useState } from "react";
import type { AifPmsEntry, AifPmsSummary } from "../types/holdings";
import { loadAifPms } from "../lib/data";
import { navigate } from "../lib/router";
import { CapPill } from "./caps";

/**
 * AIF / PMS early signals — a complementary layer to the mutual-fund dashboard.
 * Renders NOTHING until fact-sheet data is loaded (see scripts/derive-aif-pms.ts),
 * so it stays dormant on the live site until the client provides fact sheets.
 *
 * The data is ENTRY-ONLY by design (AIF/PMS disclose only their top holdings, so a
 * name leaving a list is never a sell). We surface who newly disclosed a stock, and
 * flag the ones NO mutual fund holds yet — an AIF/PMS ahead of the crowd.
 */
export function AifPmsPanel() {
  const [data, setData] = useState<AifPmsSummary | null>(null);
  useEffect(() => {
    let off = false;
    loadAifPms().then((d) => !off && setData(d));
    return () => { off = true; };
  }, []);

  if (!data || data.entries.length === 0) return null;

  const shown = data.entries.slice(0, 20);
  return (
    <section className="panel" style={{ padding: "16px 18px", marginBottom: 20, borderColor: "var(--ink-2)" }}>
      <div className="t-section">AIF &amp; PMS — early signals</div>
      <div className="t-muted" style={{ margin: "2px 0 4px", maxWidth: 760 }}>
        What {data.providers.length} tracked AIFs/PMSes are disclosing in their latest fact sheets ({data.monthLabel}).
        These funds move earlier than mutual funds, so a NEW name here — especially one <strong>no mutual fund holds yet</strong> —
        is an early signal. Fact sheets show only top holdings, so this is entry-only: a name leaving a list is never read as a sell.
      </div>
      <div className="t-muted" style={{ marginBottom: 12, fontSize: 12 }}>
        Providers: {data.providers.map((p) => `${p.name} (${p.type})`).join(" · ")}
      </div>

      <div className="panel" style={{ overflow: "hidden" }}>
        <div className="aif-grid stock-head" style={{ padding: "8px 14px" }}>
          <span className="t-label" style={{ color: "var(--ink-2)" }}>Stock</span>
          <span className="t-label" style={{ color: "var(--ink-2)" }}>Disclosed by</span>
          <span className="t-label" style={{ color: "var(--ink-2)" }}>Signal</span>
          <span className="t-label cell-r" style={{ color: "var(--ink-2)", justifySelf: "end" }}>Mutual funds</span>
        </div>
        {shown.map((e) => <AifRow key={e.isin} e={e} />)}
      </div>
    </section>
  );
}

function AifRow({ e }: { e: AifPmsEntry }) {
  return (
    <div className="aif-grid stock-row" style={{ padding: "8px 14px", cursor: "pointer" }} onClick={() => navigate(`/stock/${e.isin}`)}>
      <div style={{ minWidth: 0 }}>
        <div className="t-body" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</div>
        <div className="t-muted" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <CapPill cap={e.marketCap} />{e.sector ?? ""}
        </div>
      </div>
      <div className="t-muted" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={e.heldBy.map((h) => h.name).join(", ")}>
        <strong style={{ color: "var(--ink)" }}>{e.heldBy.length}</strong> {e.heldBy.length === 1 ? "provider" : "providers"}
        {" · "}{e.heldBy.map((h) => h.type).filter((t, i, a) => a.indexOf(t) === i).join("/")}
      </div>
      <div>
        {e.newlyDisclosed.length > 0
          ? <span className="badge" style={{ color: "var(--buy)", borderColor: "var(--buy)" }}>▲ New · {e.newlyDisclosed.length}</span>
          : <span className="t-muted">Held</span>}
      </div>
      <div className="cell-r t-body num" style={{ justifySelf: "end" }}>
        {e.aheadOfMutualFunds
          ? <span className="badge" style={{ color: "var(--ink-2)", borderColor: "var(--ink-2)" }}>Ahead — no MF</span>
          : <span className="t-muted">{e.mfFundCount} hold</span>}
      </div>
    </div>
  );
}
