import { useEffect, useState } from "react";
import type { DataIndex } from "./types/holdings";
import { loadIndex } from "./lib/data";
import { DASH } from "./lib/format";

type LoadState =
  | { status: "loading" }
  | { status: "error"; reason: string }
  | { status: "ready"; index: DataIndex };

export function App() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    loadIndex()
      .then((index) => {
        if (!cancelled) setState({ status: "ready", index });
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
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10 sm:py-16">
        <p className="text-sm font-medium tracking-wide text-indigo-600 dark:text-indigo-400">
          Step 1 · Project setup
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
          Mutual Fund Holdings Tracker
        </h1>

        <MonthsSummary state={state} />

        <section className="mt-8 space-y-4 text-slate-600 dark:text-slate-300">
          <p>
            Every month, India's mutual funds publicly disclose which stocks they
            hold and how many shares. This dashboard will line those disclosures up
            month&#8209;over&#8209;month across the whole market — all fund houses,
            all stocks — so you can see where the &ldquo;smart money&rdquo; is
            quietly moving in or out, and surface investment ideas from the shifts.
          </p>
          <p>
            Data comes from AdvisorKhoj&apos;s links to each fund house&apos;s
            official monthly holdings files. Stocks are matched by their{" "}
            <abbr
              title="International Securities Identification Number — a stable unique ID like INE040A01034"
              className="cursor-help font-medium text-slate-700 no-underline dark:text-slate-200"
            >
              ISIN
            </abbr>{" "}
            code rather than by name, so inconsistent spellings never split one
            company into several.
          </p>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            This first step is scaffolding only: the page below just confirms it can
            load month files at runtime. Downloading real data, the buy/sell
            analysis, and the dashboard screens come in later steps.
          </p>
        </section>
      </main>
      <Footer />
    </div>
  );
}

function Header() {
  return (
    <header className="border-b border-slate-200 dark:border-slate-800">
      <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-6 py-4">
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
        <LogoutButton />
      </div>
    </header>
  );
}

function LogoutButton() {
  const [busy, setBusy] = useState(false);
  async function logout() {
    setBusy(true);
    try {
      await fetch("/api/logout", { method: "POST" });
    } finally {
      window.location.replace("/");
    }
  }
  return (
    <button
      type="button"
      onClick={logout}
      disabled={busy}
      className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}

/** The one live thing this step proves: month files load at runtime (Rule 1). */
function MonthsSummary({ state }: { state: LoadState }) {
  return (
    <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      {state.status === "loading" && (
        <p className="text-slate-500 dark:text-slate-400">Loading month index…</p>
      )}

      {state.status === "error" && (
        <div>
          <p className="text-2xl font-semibold text-slate-400 dark:text-slate-500">
            {/* Rule 2: never fake a number — show a dash with the reason. */}
            {DASH} months loaded
          </p>
          <p className="mt-1 text-sm text-rose-600 dark:text-rose-400">
            Couldn&apos;t load the data index: {state.reason}
          </p>
        </div>
      )}

      {state.status === "ready" && <ReadySummary index={state.index} />}
    </div>
  );
}

function ReadySummary({ index }: { index: DataIndex }) {
  const months = index.months;
  const count = months.length;

  if (count === 0) {
    return (
      <div>
        <p className="text-2xl font-semibold text-slate-400 dark:text-slate-500">
          {DASH} months loaded
        </p>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          The index is empty — no month files are listed yet.
        </p>
      </div>
    );
  }

  const first = months[0].label;
  const last = months[count - 1].label;
  const range = count === 1 ? first : `${first} – ${last}`;

  return (
    <div>
      <p className="text-2xl font-semibold">
        {count} {count === 1 ? "month" : "months"} loaded{" "}
        <span className="text-slate-500 dark:text-slate-400">({range})</span>
      </p>
      <ul className="mt-4 flex flex-wrap gap-2">
        {months.map((m) => (
          <li
            key={m.month}
            className="rounded-full bg-indigo-50 px-3 py-1 text-sm font-medium text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
          >
            {m.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Footer() {
  return (
    <footer className="border-t border-slate-200 dark:border-slate-800">
      <div className="mx-auto w-full max-w-3xl px-6 py-4 text-xs text-slate-400 dark:text-slate-500">
        Private tool · example placeholder data
      </div>
    </footer>
  );
}
