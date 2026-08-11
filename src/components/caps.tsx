import type { MarketCap } from "../types/holdings";
import { DASH } from "../lib/format";

export const CAPS: MarketCap[] = ["large", "mid", "small"];
const LABEL: Record<MarketCap, string> = { large: "Large", mid: "Mid", small: "Small" };

/** Small market-cap label; a muted dash when unknown (never guessed). */
export function CapPill({ cap }: { cap: MarketCap | null | undefined }) {
  if (!cap) return <span className="cap-none">{DASH}</span>;
  return <span className="cap-pill">{LABEL[cap]}</span>;
}

/** Large / Mid / Small toggle chips (multi-select; none selected = all). */
export function CapFilter({ selected, onToggle }: { selected: Set<MarketCap>; onToggle: (c: MarketCap) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {CAPS.map((c) => (
        <button
          key={c}
          className="fchip"
          data-active={selected.has(c)}
          onClick={() => onToggle(c)}
          style={selected.has(c) ? { background: "var(--ink-2)", borderColor: "transparent", color: "var(--surface)" } : undefined}
        >
          {LABEL[c]}
        </button>
      ))}
    </div>
  );
}

/** Does a stock pass the cap filter? (empty selection = all.) */
export function capPass(cap: MarketCap | null | undefined, selected: Set<MarketCap>): boolean {
  return selected.size === 0 || (cap != null && selected.has(cap));
}
