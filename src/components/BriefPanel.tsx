import { useEffect, useRef, useState } from "react";

/**
 * The "Brief" subscribe panel (Step: email digest).
 *
 * A top-bar button opens a right slide-in drawer where a reader subscribes to the
 * monthly email digest (email · weekday/daily · time · which sections) or asks for
 * a one-off "email me this now". It talks to the Worker's /api routes and degrades
 * gracefully: if the backend isn't configured yet, it says so instead of failing.
 */

type Freq = "weekdays" | "daily";
type SectionKey = "flows" | "movers" | "conviction" | "entries";

const SECTIONS: { key: SectionKey; label: string; note: string }[] = [
  { key: "movers", label: "Top buys & sells", note: "Biggest share moves this month" },
  { key: "flows", label: "Market flows", note: "Sector, cap-band & breadth" },
  { key: "conviction", label: "High-conviction", note: "Trendsetters & consensus" },
  { key: "entries", label: "Brand-new entries", note: "First-time fund buys" },
];

type Msg = { kind: "ok" | "err"; text: string } | null;

const REASON: Record<string, string> = {
  "storage-not-configured": "Email briefs aren’t switched on yet — the site owner is finishing a one-time setup.",
  "email-not-configured": "Instant send isn’t switched on yet — the site owner is finishing a one-time setup.",
  "invalid-email": "That doesn’t look like a valid email address.",
  "rate-limited": "You’ve asked for a few already. Try again in an hour.",
  "bad-json": "Something went wrong sending your request.",
};

function reasonText(reason: string | undefined, fallback: string): string {
  return (reason && REASON[reason]) || fallback;
}

export function BriefButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="theme-btn" onClick={() => setOpen(true)} aria-haspopup="dialog" title="Get the monthly email brief">
        <span aria-hidden="true" style={{ marginRight: 5 }}>✉</span>Brief
      </button>
      {open && <BriefDrawer onClose={() => setOpen(false)} />}
    </>
  );
}

function BriefDrawer({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [freq, setFreq] = useState<Freq>("weekdays");
  const [time, setTime] = useState("09:00");
  const [picked, setPicked] = useState<Set<SectionKey>>(new Set(SECTIONS.map((s) => s.key)));
  const [busy, setBusy] = useState<null | "sub" | "now">(null);
  const [msg, setMsg] = useState<Msg>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    emailRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggle = (k: SectionKey) =>
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });

  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const sections = SECTIONS.map((s) => s.key).filter((k) => picked.has(k));

  async function post(path: string, body: unknown): Promise<{ ok: boolean; reason?: string }> {
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return (await res.json()) as { ok: boolean; reason?: string };
    } catch {
      return { ok: false, reason: "network" };
    }
  }

  async function subscribe() {
    if (!validEmail || sections.length === 0) return;
    setBusy("sub");
    setMsg(null);
    const r = await post("/api/subscribe", { email: email.trim(), frequency: freq, timeIST: time, sections });
    setBusy(null);
    if (r.ok) setMsg({ kind: "ok", text: "You’re subscribed. We’ll email you when the next month’s data lands." });
    else setMsg({ kind: "err", text: reasonText(r.reason, "Couldn’t subscribe just now — please try again.") });
  }

  async function sendNow() {
    if (!validEmail) return;
    setBusy("now");
    setMsg(null);
    const r = await post("/api/send-now", { email: email.trim(), sections: sections.length ? sections : undefined });
    setBusy(null);
    if (r.ok) setMsg({ kind: "ok", text: "Sent. Check your inbox in a minute (and your spam folder, just in case)." });
    else setMsg({ kind: "err", text: reasonText(r.reason, "Couldn’t send just now — please try again.") });
  }

  return (
    <div className="brief-overlay" onClick={onClose}>
      <aside className="brief-drawer panel" role="dialog" aria-label="Subscribe to the AMFIMGA brief" onClick={(e) => e.stopPropagation()}>
        <div className="brief-head">
          <div>
            <div className="t-section">Get the AMFIMGA brief</div>
            <div className="t-muted" style={{ marginTop: 3, maxWidth: 340 }}>
              A polished email when India’s mutual-fund holdings update — the top buys, sells and where the money moved. We only email you when the data actually changes.
            </div>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <label className="brief-label" htmlFor="brief-email">Email</label>
        <input
          id="brief-email"
          ref={emailRef}
          className="searchbox brief-input"
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />

        <label className="brief-label">How often</label>
        <div className="seg" role="group" aria-label="Frequency">
          <button className="seg-btn" data-active={freq === "weekdays"} onClick={() => setFreq("weekdays")}>Every weekday</button>
          <button className="seg-btn" data-active={freq === "daily"} onClick={() => setFreq("daily")}>Every day</button>
        </div>

        <label className="brief-label" htmlFor="brief-time">Preferred time <span className="t-muted">(IST)</span></label>
        <input id="brief-time" className="searchbox brief-input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />

        <label className="brief-label">Include</label>
        <div className="brief-checks">
          {SECTIONS.map((s) => (
            <label key={s.key} className="brief-check">
              <input type="checkbox" checked={picked.has(s.key)} onChange={() => toggle(s.key)} />
              <span>
                <span className="brief-check-label">{s.label}</span>
                <span className="t-muted brief-check-note">{s.note}</span>
              </span>
            </label>
          ))}
        </div>

        {msg && (
          <div className="brief-msg" style={{ color: msg.kind === "ok" ? "var(--buy)" : "var(--sell)" }}>
            {msg.text}
          </div>
        )}

        <button className="brief-primary" onClick={subscribe} disabled={!validEmail || sections.length === 0 || busy != null}>
          {busy === "sub" ? "Subscribing…" : "Subscribe"}
        </button>

        <div className="brief-or"><span>or</span></div>

        <button className="theme-btn brief-secondary" onClick={sendNow} disabled={!validEmail || busy != null}>
          {busy === "now" ? "Sending…" : "✉ Email me this now"}
        </button>
        <div className="t-muted" style={{ marginTop: 10, fontSize: 11 }}>
          One-click unsubscribe is in every email. We never share your address.
        </div>
      </aside>
    </div>
  );
}
