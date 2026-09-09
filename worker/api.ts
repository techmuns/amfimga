/**
 * The /api/* handlers for the email-digest feature.
 *
 * Every handler degrades gracefully: if KV or the email token isn't configured
 * it returns a clean JSON reason instead of throwing, and the dashboard is never
 * affected. run-digests is locked behind DIGEST_KEY; send-now is rate-limited.
 */
import type { DashboardData, Env, SectionKey, Subscription } from "./types.ts";
import { SECTION_KEYS } from "./types.ts";
import { buildDigestModel, digestVersion, hasContent, renderEmail } from "./digest.ts";
import { listSubs, putSub, saveSubscription, sendNowAllowed, subKeyFor, getSub, unsubscribeByToken } from "./store.ts";

const DEFAULT_EMAIL_ENDPOINT = "https://devde.muns.io/email/send/raw";

// --- small helpers ---------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function htmlPage(title: string, message: string, status = 200): Response {
  const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#ece9e2;color:#0b0b0b;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#fcfcfb;border:1px solid #e1e0d9;border-radius:14px;padding:32px 34px;max-width:440px;margin:16px;text-align:center}
h1{font-size:20px;margin:0 0 8px}p{font-size:14px;color:#52514e;line-height:1.6;margin:0 0 16px}a{color:#0b0b0b;font-weight:700}</style></head>
<body><div class="card"><div style="font-size:20px;font-weight:800;letter-spacing:1px;margin-bottom:14px">AMFIMGA</div><h1>${title}</h1><p>${message}</p><a href="/">Back to the dashboard →</a></div></body></html>`;
  return new Response(doc, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function isEmail(s: unknown): s is string {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
}

function cleanSections(input: unknown): SectionKey[] {
  const arr = Array.isArray(input) ? input : [];
  const picked = SECTION_KEYS.filter((k) => arr.includes(k));
  return picked.length ? picked : [...SECTION_KEYS];
}

function cleanTime(input: unknown): string {
  if (typeof input === "string" && /^([01]?\d|2[0-3]):[0-5]\d$/.test(input)) {
    const [h, m] = input.split(":");
    return `${h.padStart(2, "0")}:${m}`;
  }
  return "09:00";
}

/** Constant-time string compare (avoids leaking the digest key via timing). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function siteOrigin(env: Env, request: Request): string {
  if (env.SITE_URL) return env.SITE_URL.replace(/\/$/, "");
  return new URL(request.url).origin;
}

function randomToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

// --- data loading (server-side, via the ASSETS binding) --------------------

async function loadJson<T>(env: Env, origin: string, path: string): Promise<T> {
  const res = await env.ASSETS.fetch(new Request(new URL(path, origin).toString()));
  if (!res.ok) throw new Error(`asset ${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function loadData(env: Env, origin: string): Promise<DashboardData> {
  const [summary, stocks, sectors] = await Promise.all([
    loadJson<DashboardData["summary"]>(env, origin, "/data/summary.json"),
    loadJson<DashboardData["stocks"]>(env, origin, "/data/stocks.json"),
    loadJson<DashboardData["sectors"]>(env, origin, "/data/sectors.json"),
  ]);
  let funds: DashboardData["funds"] = null;
  try {
    funds = await loadJson<NonNullable<DashboardData["funds"]>>(env, origin, "/data/funds.json");
  } catch {
    funds = null; // funds index is optional for the digest
  }
  return { summary, stocks, sectors, funds };
}

// --- email send ------------------------------------------------------------

async function sendEmail(env: Env, to: string, subject: string, html: string): Promise<{ sent: boolean; reason?: string }> {
  if (!env.MUNS_TOKEN) return { sent: false, reason: "email-not-configured" };
  const endpoint = env.MUNS_EMAIL_ENDPOINT || DEFAULT_EMAIL_ENDPOINT;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${env.MUNS_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ email: to, subject, html }),
    });
    if (!res.ok) return { sent: false, reason: `http-${res.status}` };
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e instanceof Error ? e.message : "fetch-failed" };
  }
}

function unsubUrl(origin: string, token: string): string {
  return `${origin}/api/unsubscribe?token=${encodeURIComponent(token)}`;
}

// --- IST time helpers (India has no DST — a fixed +5:30 offset) -------------

const IST_OFFSET_MS = 5.5 * 3_600_000;

function istParts(now = Date.now()): { date: string; dow: number; minutes: number } {
  const d = new Date(now + IST_OFFSET_MS);
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return { date, dow: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

function isDue(sub: Subscription, version: string, sendEmpty: boolean, now = Date.now()): boolean {
  const { date, dow, minutes } = istParts(now);
  if (sub.frequency === "weekdays" && (dow === 0 || dow === 6)) return false;
  const [th, tm] = sub.timeIST.split(":").map(Number);
  if (minutes < th * 60 + tm) return false; // not yet their time today
  if (sub.lastSentDate === date) return false; // once per day
  if (!sendEmpty && sub.lastVersion === version) return false; // nothing new since last send
  return true;
}

// --- handlers --------------------------------------------------------------

async function handleSubscribe(request: Request, env: Env): Promise<Response> {
  if (!env.DIGEST_KV) return json({ ok: false, reason: "storage-not-configured" }, 503);
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, reason: "bad-json" }, 400);
  }
  if (!isEmail(body.email)) return json({ ok: false, reason: "invalid-email" }, 400);
  const email = body.email.trim();
  const frequency = body.frequency === "daily" ? "daily" : "weekdays";
  const origin = siteOrigin(env, request);

  const subKey = await subKeyFor(email);
  const existing = await getSub(env.DIGEST_KV, subKey);
  const sub: Subscription = {
    email,
    frequency,
    timeIST: cleanTime(body.timeIST),
    sections: cleanSections(body.sections),
    token: existing?.token ?? randomToken(),
    origin,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    lastSentDate: existing?.lastSentDate,
    lastVersion: existing?.lastVersion,
  };
  await saveSubscription(env.DIGEST_KV, sub);
  return json({ ok: true, updated: !!existing });
}

async function handleUnsubscribe(request: Request, env: Env): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!env.DIGEST_KV) return htmlPage("Unsubscribe", "Storage isn't configured, so there's nothing to remove.");
  if (!token) return htmlPage("Unsubscribe", "That link is missing its token.", 400);
  const email = await unsubscribeByToken(env.DIGEST_KV, token);
  if (email == null) return htmlPage("Already unsubscribed", "This link has already been used, or the subscription no longer exists.");
  return htmlPage("You're unsubscribed", `We won't email <strong>${email.replace(/</g, "&lt;")}</strong> any more. You can re-subscribe anytime from the dashboard.`);
}

async function handleRunDigests(request: Request, env: Env): Promise<Response> {
  const provided = request.headers.get("x-digest-key") ?? "";
  if (!env.DIGEST_KEY || !timingSafeEqual(provided, env.DIGEST_KEY)) return json({ ok: false, reason: "unauthorized" }, 401);
  if (!env.DIGEST_KV) return json({ ok: false, reason: "storage-not-configured" }, 503);

  const origin = siteOrigin(env, request);
  const data = await loadData(env, origin);
  const model = buildDigestModel(data);
  const version = await digestVersion(model);
  const sendEmpty = env.SEND_EMPTY === "true";

  if (!hasContent(model) && !sendEmpty) return json({ ok: true, sent: 0, note: "no-content" });

  const subs = await listSubs(env.DIGEST_KV);
  const today = istParts().date;
  let sent = 0, skipped = 0, failed = 0;

  for (const { key, sub } of subs) {
    if (!isDue(sub, version, sendEmpty)) { skipped++; continue; }
    const sections = sub.sections.length ? (sub.sections as SectionKey[]) : [...SECTION_KEYS];
    const { subject, html } = renderEmail(model, {
      sections,
      unsubUrl: unsubUrl(sub.origin || origin, sub.token),
      siteUrl: sub.origin || origin,
      frequency: sub.frequency,
      timeIST: sub.timeIST,
    });
    const r = await sendEmail(env, sub.email, subject, html);
    if (r.sent) {
      sent++;
      await putSub(env.DIGEST_KV, key, { ...sub, lastSentDate: today, lastVersion: version });
    } else if (r.reason === "email-not-configured") {
      skipped++; // no token yet — leave everyone due, don't burn their slot
    } else {
      failed++;
    }
  }
  return json({ ok: true, version, total: subs.length, sent, skipped, failed });
}

async function handleSendNow(request: Request, env: Env): Promise<Response> {
  if (!env.DIGEST_KV) return json({ ok: false, reason: "storage-not-configured" }, 503);
  if (!env.MUNS_TOKEN) return json({ ok: false, reason: "email-not-configured" }, 503);
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, reason: "bad-json" }, 400);
  }
  if (!isEmail(body.email)) return json({ ok: false, reason: "invalid-email" }, 400);
  const email = body.email.trim();
  if (!(await sendNowAllowed(env.DIGEST_KV, email))) return json({ ok: false, reason: "rate-limited" }, 429);

  const origin = siteOrigin(env, request);
  const data = await loadData(env, origin);
  const model = buildDigestModel(data);
  const sections = cleanSections(body.sections);

  // Reuse the person's real unsubscribe token if they're already subscribed, so
  // the one-off email's unsubscribe link works too; otherwise link to the site.
  const existing = await getSub(env.DIGEST_KV, await subKeyFor(email));
  const unsub = existing ? unsubUrl(origin, existing.token) : `${origin}/`;
  const { subject, html } = renderEmail(model, {
    sections,
    unsubUrl: unsub,
    siteUrl: origin,
    frequency: existing?.frequency,
    timeIST: existing?.timeIST,
  });
  const r = await sendEmail(env, email, `${subject} (preview)`, html);
  return r.sent ? json({ ok: true }) : json({ ok: false, reason: r.reason ?? "send-failed" }, 502);
}

/** Route an /api/* request, or return null to fall through to static assets. */
export async function handleApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const p = url.pathname;
  if (!p.startsWith("/api/")) return null;

  if (p === "/api/subscribe" && request.method === "POST") return handleSubscribe(request, env);
  if (p === "/api/unsubscribe" && request.method === "GET") return handleUnsubscribe(request, env);
  if (p === "/api/run-digests" && request.method === "POST") return handleRunDigests(request, env);
  if (p === "/api/send-now" && request.method === "POST") return handleSendNow(request, env);
  if (p === "/api/health") return json({ ok: true, storage: !!env.DIGEST_KV, email: !!env.MUNS_TOKEN });

  return json({ ok: false, reason: "not-found" }, 404);
}
