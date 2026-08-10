import { useEffect, useMemo, useState } from "react";
import type { MonthMeta, StockRow, StocksSummary, SummaryMeta } from "./types/holdings";
import { loadStocks, loadSummary } from "./lib/data";
import { DASH, formatSignedCount } from "./lib/format";

type LoadState =
  | { status: "loading" }
  | { status: "error"; reason: string }
  | { status: "ready"; summary: SummaryMeta; stocks: StocksSummary };

export function App() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadSummary(), loadStocks()])
      .then(([summary, stocks]) => {
        if (!cancelled) setState({ status: "ready", summary, stocks });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            reason: err instanceof Error ? err.message : "Unknown error",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-dvh flex-col">
      <Header />
      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-10 sm:py-14">
        <p className="text-sm font-medium tracking-wide text-indigo-600 dark:text-indigo-400">
          Step 3 · Buy/sell signals
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
          Where the funds are moving
        </h1>
        <p className="mt-3 max-w-2xl text-slate-600 dark:text-slate-300">
          Net change in shares held across India's mutual funds, month over month.
          Positive means funds are net <strong>buying</strong>; negative means net{" "}
          <strong>selling</strong>. Changes only compare funds present in both
          months — a fund house missing from a month is shown as {DASH}, never
          counted as a seller.
        </p>

        {state.status === "loading" && <Note>Loading summaries…</Note>}
        {state.status === "error" && (
          <Note tone="error">Couldn&apos;t load the data: {state.reason}</Note>
        )}
        {state.status === "ready" && (
          <Movers summary={state.summary} stocks={state.stocks} />
        )}
      </main>
      <Footer />
    </div>
  );
}

function Movers({ summary, stocks }: { summary: SummaryMeta; stocks: StocksSummary }) {
  const last = stocks.months.length - 1;
  const meta: MonthMeta | undefined = summary.months[summary.months.length - 1];

  const { buys, sells } = useMemo(() => {
    const withChange = stocks.stocks
      .map((s) => ({ s, net: s.netShareChange[last] }))
      .filter((x): x is { s: StockRow; net: number } => x.net != null && x.net !== 0);
    const buys = [...withChange].sort((a, b) => b.net - a.net).slice(0, 10);
    const sells = [...withChange].sort((a, b) => a.net - b.net).slice(0, 10);
    return { buys, sells };
  }, [stocks, last]);

  if (!meta) return <Note>No months available yet.</Note>;

  return (
    <section className="mt-8">
      <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 text-sm dark:border-slate-800 dark:bg-slate-900">
        <span className="font-semibold">{meta.label}</span>
        <span className="text-slate-500 dark:text-slate-400">
          {" "}· based on <strong>{meta.housesPresent}</strong> of {meta.housesTotal}{" "}
          fund houses · {meta.stockCount.toLocaleString("en-IN")} stocks ·{" "}
          {meta.fundCount} funds
        </span>
      </div>

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <MoverList
          title="Top 10 net buys"
          accent="text-emerald-600 dark:text-emerald-400"
          rows={buys}
        />
        <MoverList
          title="Top 10 net sells"
          accent="text-rose-600 dark:text-rose-400"
          rows={sells}
        />
      </div>

      <p className="mt-6 text-xs text-slate-400 dark:text-slate-500">
        Net share change vs the previous month, summed across funds present in both
        months. Full sortable tables and per-stock detail come next.
      </p>
    </section>
  );
}

function MoverList({
  title,
  accent,
  rows,
}: {
  title: string;
  accent: string;
  rows: { s: StockRow; net: number }[];
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <h2 className="text-sm font-semibold">{title}</h2>
      <ol className="mt-3 space-y-2">
        {rows.length === 0 && (
          <li className="text-sm text-slate-400">Nothing comparable this month.</li>
        )}
        {rows.map(({ s, net }) => (
          <li key={s.isin} className="flex items-baseline justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{s.name}</div>
              <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                {s.sector ?? DASH}
              </div>
            </div>
            <div className={`shrink-0 font-mono text-sm tabular-nums ${accent}`}>
              {formatSignedCount(net)}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Header() {
  return (
    <header className="border-b border-slate-200 dark:border-slate-800">
      <div className="mx-auto flex w-full max-w-4xl items-center px-6 py-4">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-indigo-600 text-sm font-bold text-white">
            A
          </span>
          <div className="leading-tight">
            <div className="text-sm font-semibold">AMFIMGA</div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Fund holdings tracker
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

function Note({
  children,
  tone = "default",
}: {
  children: React.ReactNode;
  tone?: "default" | "error";
}) {
  return (
    <div
      className={`mt-8 rounded-2xl border p-6 ${
        tone === "error"
          ? "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300"
          : "border-slate-200 bg-white text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400"
      }`}
    >
      {children}
    </div>
  );
}

function Footer() {
  return (
    <footer className="border-t border-slate-200 dark:border-slate-800">
      <div className="mx-auto w-full max-w-4xl px-6 py-4 text-xs text-slate-400 dark:text-slate-500">
        Data: AdvisorKhoj · official monthly disclosures
      </div>
    </footer>
  );
}
