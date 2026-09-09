/**
 * KV storage helpers for subscriptions.
 *
 * Key layout:
 *   sub:<sha256(email)>   -> Subscription JSON
 *   unsub:<token>         -> the sub key above (reverse lookup for 1-click unsub)
 *   sendnow:<hash>:<hour> -> count (rate-limit for "Email me this now")
 *
 * All of this is optional at runtime: callers pass the KVNamespace only when the
 * binding exists, so the dashboard keeps working when storage isn't configured.
 */
import type { Subscription } from "./types.ts";

/** Lowercase hex sha256 of a string. */
export async function sha256Hex(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function subKeyFor(email: string): Promise<string> {
  return `sub:${await sha256Hex(email.trim().toLowerCase())}`;
}

export async function getSub(kv: KVNamespace, subKey: string): Promise<Subscription | null> {
  return kv.get<Subscription>(subKey, "json");
}

export async function putSub(kv: KVNamespace, subKey: string, sub: Subscription): Promise<void> {
  await kv.put(subKey, JSON.stringify(sub));
}

export async function saveSubscription(kv: KVNamespace, sub: Subscription): Promise<void> {
  const subKey = await subKeyFor(sub.email);
  await kv.put(subKey, JSON.stringify(sub));
  await kv.put(`unsub:${sub.token}`, subKey);
}

/** Resolve an unsubscribe token to its sub, delete both. Returns the email if found. */
export async function unsubscribeByToken(kv: KVNamespace, token: string): Promise<string | null> {
  const subKey = await kv.get(`unsub:${token}`);
  if (!subKey) return null;
  const sub = await getSub(kv, subKey);
  await kv.delete(subKey);
  await kv.delete(`unsub:${token}`);
  return sub?.email ?? null;
}

/** All subscriptions (KV list, paged). Fine for the modest scale here. */
export async function listSubs(kv: KVNamespace): Promise<{ key: string; sub: Subscription }[]> {
  const out: { key: string; sub: Subscription }[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: "sub:", cursor });
    for (const k of page.keys) {
      const sub = await getSub(kv, k.name);
      if (sub) out.push({ key: k.name, sub });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

/**
 * Best-effort rate limit for send-now: at most `max` per email per rolling hour.
 * KV is eventually consistent, so this bounds abuse rather than being exact.
 */
export async function sendNowAllowed(kv: KVNamespace, email: string, max = 3): Promise<boolean> {
  const hash = await sha256Hex(email.trim().toLowerCase());
  const bucket = Math.floor(Date.now() / 3_600_000);
  const key = `sendnow:${hash}:${bucket}`;
  const current = Number((await kv.get(key)) ?? "0");
  if (current >= max) return false;
  await kv.put(key, String(current + 1), { expirationTtl: 3600 });
  return true;
}
