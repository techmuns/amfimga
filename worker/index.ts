/**
 * Cloudflare Worker — password gate + static-asset server for AMFIMGA.
 *
 * Rule 5: the whole site is a private tool behind a single password. Because the
 * fund-holdings data lives in static files under /data/*.json, the gate CANNOT be
 * client-side only — anyone could just fetch the JSON. So the Worker runs before
 * every request (wrangler.jsonc: assets.run_worker_first = true) and refuses to
 * serve anything — page, script, or data — without a valid session cookie.
 *
 * Auth model (deliberately simple):
 *   - One shared password, stored as the APP_PASSWORD secret.
 *   - On success we set an HttpOnly cookie holding an HMAC-signed, expiring token
 *     (signed with SESSION_SECRET). No database, no user accounts.
 */

interface Env {
  /** Static assets binding (the Vite-built client + /data files). */
  ASSETS: Fetcher;
  /** The single site password. Set via `wrangler secret put APP_PASSWORD`. */
  APP_PASSWORD?: string;
  /** HMAC key for signing session cookies. Set via `wrangler secret put SESSION_SECRET`. */
  SESSION_SECRET?: string;
  /** How long a login stays valid. Defaults to 12 hours. */
  SESSION_TTL_HOURS?: string;
  /** "true" only in local dev (from .dev.vars); absent in production. */
  DEV_MODE?: string;
}

const COOKIE_NAME = "amfimga_session";
const TOKEN_VERSION = "v1";
const DEFAULT_TTL_HOURS = 12;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const isDev = env.DEV_MODE === "true";

    // --- Always-open auth endpoints -------------------------------------
    if (url.pathname === "/api/login" && request.method === "POST") {
      return handleLogin(request, env, isDev);
    }
    if (url.pathname === "/api/logout" && request.method === "POST") {
      return handleLogout(isDev);
    }

    const authed = await isAuthenticated(request, env);

    // Lets the client ask "am I still logged in?" without triggering the gate.
    if (url.pathname === "/api/session") {
      return json({ authenticated: authed });
    }

    if (authed) {
      // Authenticated: serve the real asset (or SPA fallback) from the binding.
      return env.ASSETS.fetch(request);
    }

    // --- Not authenticated ----------------------------------------------
    if (gateApplies(url, request, isDev)) {
      const wantsHtml = request.headers.get("accept")?.includes("text/html");
      if (wantsHtml) {
        // A document navigation → show the self-contained login page.
        return new Response(loginPage(env), {
          status: 401,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      }
      // A data/asset fetch (e.g. /data/index.json) → machine-readable 401.
      return json({ error: "unauthorized" }, 401);
    }

    // Dev-only: Vite's own module/HMR requests are let through so hot-reload
    // works even before you log in. This branch is unreachable in production,
    // where gateApplies() is always true.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

/**
 * Which requests must pass the gate when unauthenticated.
 * Production: everything. Dev: the app document and the /data files, but not
 * Vite's internal module/HMR machinery (so the dev server keeps working).
 */
function gateApplies(url: URL, request: Request, isDev: boolean): boolean {
  if (!isDev) return true;
  if (url.pathname.startsWith("/data/")) return true;
  if (request.headers.get("sec-fetch-dest") === "document") return true;
  return (request.headers.get("accept") ?? "").includes("text/html");
}

// --- Login / logout ---------------------------------------------------------

async function handleLogin(
  request: Request,
  env: Env,
  isDev: boolean,
): Promise<Response> {
  if (!env.APP_PASSWORD || !env.SESSION_SECRET) {
    return json(
      { error: "Server not configured: APP_PASSWORD and SESSION_SECRET are required." },
      500,
    );
  }

  const password = await readPassword(request);
  if (password === null) {
    return json({ error: "Missing password." }, 400);
  }
  if (!(await passwordMatches(password, env))) {
    return json({ error: "Incorrect password." }, 401);
  }

  const ttlHours = ttl(env);
  const token = await createToken(env.SESSION_SECRET, ttlHours);
  return json({ ok: true }, 200, {
    "set-cookie": buildCookie(token, ttlHours * 3600, !isDev),
  });
}

function handleLogout(isDev: boolean): Response {
  // Expire the cookie immediately.
  return json({ ok: true }, 200, { "set-cookie": buildCookie("", 0, !isDev) });
}

async function readPassword(request: Request): Promise<string | null> {
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body = (await request.json()) as { password?: unknown };
      return typeof body.password === "string" ? body.password : null;
    }
    if (
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data")
    ) {
      const form = await request.formData();
      const value = form.get("password");
      return typeof value === "string" ? value : null;
    }
  } catch {
    return null;
  }
  return null;
}

// --- Session tokens ---------------------------------------------------------

async function isAuthenticated(request: Request, env: Env): Promise<boolean> {
  // Fail closed: no secrets configured means nobody gets in.
  if (!env.APP_PASSWORD || !env.SESSION_SECRET) return false;
  const token = parseCookies(request.headers.get("cookie"))[COOKIE_NAME];
  if (!token) return false;
  return verifyToken(token, env.SESSION_SECRET);
}

/** Token shape: `v1.<expiryMillis>.<hex hmac of "v1.<expiryMillis>">`. */
async function createToken(secret: string, ttlHours: number): Promise<string> {
  const expiry = Date.now() + ttlHours * 3_600_000;
  const payload = `${TOKEN_VERSION}.${expiry}`;
  const sig = await hmacHex(secret, payload);
  return `${payload}.${sig}`;
}

async function verifyToken(token: string, secret: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [version, expiryStr, sig] = parts;
  if (version !== TOKEN_VERSION) return false;

  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) return false;

  const expected = await hmacHex(secret, `${version}.${expiryStr}`);
  return timingSafeEqual(sig, expected);
}

async function passwordMatches(candidate: string, env: Env): Promise<boolean> {
  // Compare fixed-length HMACs so we never leak the password length via timing.
  const a = await hmacHex(env.SESSION_SECRET!, `pw:${candidate}`);
  const b = await hmacHex(env.SESSION_SECRET!, `pw:${env.APP_PASSWORD}`);
  return timingSafeEqual(a, b);
}

// --- Small crypto / cookie / http helpers -----------------------------------

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function buildCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name) out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

function ttl(env: Env): number {
  const parsed = Number(env.SESSION_TTL_HOURS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_HOURS;
}

function json(
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

// --- Login page (self-contained; served before any app asset loads) ---------

function loginPage(env: Env): string {
  const configError =
    !env.APP_PASSWORD || !env.SESSION_SECRET
      ? "Server not configured — set APP_PASSWORD and SESSION_SECRET."
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="light dark" />
<title>Sign in · AMFIMGA</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh; display: grid; place-items: center;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #f8fafc; color: #0f172a; padding: 1.5rem;
  }
  .card {
    width: 100%; max-width: 22rem; background: #fff; border: 1px solid #e2e8f0;
    border-radius: 16px; padding: 2rem; box-shadow: 0 10px 30px rgba(2,6,23,.08);
  }
  .brand { display: flex; align-items: center; gap: .6rem; margin-bottom: 1.25rem; }
  .brand .dot {
    width: 32px; height: 32px; border-radius: 8px; background: #4f46e5;
    display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 14px;
  }
  h1 { font-size: 1.05rem; margin: 0; font-weight: 650; }
  p.sub { margin: .15rem 0 0; font-size: .8rem; color: #64748b; }
  label { display: block; font-size: .8rem; font-weight: 600; margin: 1.25rem 0 .4rem; }
  input {
    width: 100%; padding: .6rem .75rem; font-size: .95rem; border-radius: 10px;
    border: 1px solid #cbd5e1; background: #fff; color: inherit;
  }
  input:focus { outline: 2px solid #4f46e5; outline-offset: 1px; border-color: #4f46e5; }
  button {
    width: 100%; margin-top: 1.1rem; padding: .65rem; font-size: .95rem; font-weight: 600;
    color: #fff; background: #4f46e5; border: 0; border-radius: 10px; cursor: pointer;
  }
  button:hover { background: #4338ca; }
  button:disabled { opacity: .6; cursor: default; }
  .msg { margin-top: .9rem; font-size: .8rem; min-height: 1rem; color: #dc2626; }
  @media (prefers-color-scheme: dark) {
    body { background: #020617; color: #e2e8f0; }
    .card { background: #0f172a; border-color: #1e293b; box-shadow: none; }
    p.sub { color: #94a3b8; }
    input { background: #020617; border-color: #334155; }
  }
</style>
</head>
<body>
  <form class="card" id="login">
    <div class="brand">
      <div class="dot">A</div>
      <div>
        <h1>AMFIMGA</h1>
        <p class="sub">Mutual Fund Holdings Tracker · private</p>
      </div>
    </div>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password"
           autofocus required />
    <button type="submit" id="submit">Sign in</button>
    <div class="msg" id="msg">${configError}</div>
  </form>
<script>
  const form = document.getElementById("login");
  const msg = document.getElementById("msg");
  const submit = document.getElementById("submit");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    msg.style.color = "";
    msg.textContent = "";
    submit.disabled = true;
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: document.getElementById("password").value }),
      });
      if (res.ok) {
        window.location.replace("/");
        return;
      }
      const data = await res.json().catch(() => ({}));
      msg.textContent = data.error || "Sign in failed.";
    } catch {
      msg.textContent = "Network error. Please try again.";
    }
    submit.disabled = false;
  });
</script>
</body>
</html>`;
}
