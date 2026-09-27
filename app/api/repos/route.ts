import { createAdminClient } from "@/lib/supabase/admin";
import { currentSession } from "@/lib/accessServer";
import { githubAccount, githubTokenFor } from "@/lib/githubAccount";
import { listRepos } from "@/lib/tools/github";

export const dynamic = "force-dynamic";

/**
 * Repositories for the codebase picker. The main key sees everything the connected GitHub account can reach,
 * private repositories included; any other session only gets public ones.
 */
export async function GET() {
  const db = createAdminClient();
  const session = await currentSession();
  const main = session?.kind === "main";
  const account = main ? await githubAccount(db).catch(() => null) : null;
  const token = await githubTokenFor(db, session).catch(() => null);
  try {
    return Response.json({ repos: await listRepos(token), main, connected: account?.login ?? null });
  } catch (e) {
    return Response.json({ repos: [], main, connected: account?.login ?? null, error: e instanceof Error ? e.message : String(e) });
  }
}
