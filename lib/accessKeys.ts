/**
 * Access keys, edge-safe (Web Crypto only), shared by the middleware and the API.
 *
 * - The main key is the MAIN_ACCESS_KEY environment variable. It opens the app
 *   and is the only key that can create or revoke temporary keys.
 * - Temporary keys live in the access_keys table (as SHA-256 hashes), each with
 *   an expiry, and can be revoked.
 * - Entering a key sets a signed session cookie; nothing else is stored in the
 *   browser. Changing MAIN_ACCESS_KEY signs everyone out.
 */
export const SESSION_COOKIE = "vellum_access";
export const MAIN_SESSION_DAYS = 30;

export type Session = { kind: "main" } | { kind: "temp"; id: string; exp: number };
type Token = { k: "main" | "temp"; id?: string; exp: number };

const enc = new TextEncoder();

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export async function sha256Hex(text: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function mainKey() {
  return (process.env.MAIN_ACCESS_KEY ?? "").trim();
}

/** Whether keys are switched on. Without MAIN_ACCESS_KEY, local development stays open; production stays locked. */
export function accessConfigured() {
  return mainKey().length > 0;
}

async function hmac(data: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(`${mainKey()}:vellum-session`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

/** Constant-time comparison, so a wrong key or signature takes as long to reject as a nearly right one. */
export function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function isMainKey(candidate: string) {
  const main = mainKey();
  if (!main || !candidate) return false;
  // Compare digests, so lengths don't leak either.
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(candidate.trim())), crypto.subtle.digest("SHA-256", enc.encode(main))]);
  return sameBytes(new Uint8Array(x), new Uint8Array(y));
}

export async function signSession(token: Token) {
  const body = b64url(enc.encode(JSON.stringify(token)));
  return `${body}.${b64url(await hmac(body))}`;
}

/** The session in a cookie value, if its signature is valid and it hasn't expired. Doesn't check revocation. */
export async function readSession(value: string | undefined | null): Promise<Session | null> {
  if (!value || !accessConfigured()) return null;
  const [body, sig] = value.split(".");
  if (!body || !sig) return null;
  try {
    if (!sameBytes(fromB64url(sig), await hmac(body))) return null;
    const t = JSON.parse(new TextDecoder().decode(fromB64url(body))) as Token;
    if (!t || typeof t.exp !== "number" || t.exp < Date.now()) return null;
    if (t.k === "main") return { kind: "main" };
    if (t.k === "temp" && typeof t.id === "string") return { kind: "temp", id: t.id, exp: t.exp };
    return null;
  } catch {
    return null;
  }
}

/** A new temporary key: "vlm_" and 32 random letters and digits. */
export function newKey() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return "vlm_" + [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

// Revocation checks are cached briefly, so every request doesn't hit the database; a revoked key stops working within this window.
const STATUS_TTL_MS = 30_000;
const statusCache = new Map<string, { ok: boolean; at: number }>();

/** Whether a temporary key is still valid (not revoked, not expired), via Supabase's REST API so it works on the edge. */
export async function tempKeyActive(id: string): Promise<boolean> {
  const hit = statusCache.get(id);
  if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.ok;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !service || !/^[0-9a-f-]{36}$/i.test(id)) return false;
  try {
    const res = await fetch(`${url}/rest/v1/access_keys?id=eq.${id}&select=expires_at,revoked_at`, {
      headers: { apikey: service, Authorization: `Bearer ${service}` },
      cache: "no-store",
    });
    const rows = res.ok ? ((await res.json()) as { expires_at: string; revoked_at: string | null }[]) : [];
    const ok = !!rows[0] && !rows[0].revoked_at && new Date(rows[0].expires_at).getTime() > Date.now();
    statusCache.set(id, { ok, at: Date.now() });
    return ok;
  } catch {
    return hit?.ok ?? false;
  }
}

export function forgetKeyStatus(id: string) {
  statusCache.delete(id);
}

/** The full check: a valid cookie, and for a temporary key, one that is still active. */
export async function sessionFromCookie(value: string | undefined | null): Promise<Session | null> {
  const s = await readSession(value);
  if (!s) return null;
  if (s.kind === "temp" && !(await tempKeyActive(s.id))) return null;
  return s;
}

/** Paths open without a key: the key entry page, signing in and out, and view-only share links with what they load. */
export function isPublicPath(pathname: string, method: string) {
  if (pathname === "/access" || pathname === "/api/access/login" || pathname === "/api/access/logout") return true;
  if (pathname === "/api/health" && method === "GET") return true;
  if (/^\/p\/[^/]+\/?$/.test(pathname)) return true;
  if (method === "GET" && /^\/api\/projects\/[^/]+\/(export|file|render)\/?$/.test(pathname)) return true;
  return false;
}
