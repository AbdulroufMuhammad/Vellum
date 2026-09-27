import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Session } from "@/lib/accessKeys";

/**
 * The GitHub account connected from Settings > GitHub. Only a main-key session can connect it, see it, or have
 * the agent and the codebase picker use it; temporary keys get public repositories only. The token is stored
 * encrypted (AES-256-GCM) in app_settings.github and never sent back to a browser.
 */
export type GithubAccount = { login: string; name: string | null; avatar: string | null; scopes: string | null; connected_at: string };
type Stored = GithubAccount & { token: string };

/**
 * The encryption key: GITHUB_TOKEN_SECRET if set, otherwise derived from the Supabase service-role key, a long
 * server-only secret (never the typed main access key, which is too short to make a good key).
 */
function secret(): Buffer {
  const base = process.env.GITHUB_TOKEN_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base) throw new Error("the server has no secret to encrypt the token with");
  return createHash("sha256").update(`vellum-github:${base}`).digest();
}

function seal(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secret(), iv);
  const body = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString("base64")).join(".");
}

function open(sealed: string): string | null {
  try {
    const [iv, tag, body] = sealed.split(".").map((p) => Buffer.from(p, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", secret(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    // The secret changed since it was saved: treat it as not connected, so it can simply be connected again.
    return null;
  }
}

async function stored(db: SupabaseClient): Promise<Stored | null> {
  const { data } = await db.from("app_settings").select("github").eq("id", true).maybeSingle();
  const g = data?.github as Stored | null | undefined;
  return g?.token && g.login ? g : null;
}

/** The connected account, without its token. */
export async function githubAccount(db: SupabaseClient): Promise<GithubAccount | null> {
  const g = await stored(db);
  if (!g || open(g.token) == null) return null;
  const { token: _token, ...account } = g;
  return account;
}

/**
 * The GitHub token a session may use: for the main key, the connected account's (or the GITHUB_TOKEN environment
 * variable's); for anyone else, none, so they only ever reach public repositories.
 */
export async function githubTokenFor(db: SupabaseClient, session: Session | null): Promise<string | null> {
  if (session?.kind !== "main") return null;
  const g = await stored(db);
  const token = g ? open(g.token) : null;
  return token ?? (process.env.GITHUB_TOKEN || null);
}

/** Check a token with GitHub, then save it (encrypted) as the connected account. */
export async function connectGithub(db: SupabaseClient, raw: string): Promise<GithubAccount> {
  const token = String(raw ?? "").trim();
  if (!/^[\w-]{20,255}$/.test(token)) throw new Error("That doesn't look like a GitHub token. Paste the whole token, which starts with github_pat_ or ghp_.");
  const res = await fetch("https://api.github.com/user", {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "vellum", Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401) throw new Error("GitHub didn't accept that token (it may be mistyped, expired or revoked).");
  if (!res.ok) throw new Error(`GitHub answered ${res.status}; try again in a moment.`);
  const user = await res.json();
  const account: GithubAccount = {
    login: String(user.login),
    name: user.name ? String(user.name) : null,
    avatar: user.avatar_url ? String(user.avatar_url) : null,
    // Classic tokens list their scopes here; fine-grained tokens don't (their access is set per repository).
    scopes: res.headers.get("x-oauth-scopes"),
    connected_at: new Date().toISOString(),
  };
  const { error } = await db.from("app_settings").upsert({ id: true, github: { ...account, token: seal(token) }, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
  return account;
}

export async function disconnectGithub(db: SupabaseClient): Promise<void> {
  const { error } = await db.from("app_settings").upsert({ id: true, github: null, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}
