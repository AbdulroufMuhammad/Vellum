import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const REQUIRED = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "MAIN_ACCESS_KEY"];
const OPTIONAL = ["NVIDIA_API_KEY", "DEEPSEEK_API_KEY", "SEEKLY_API_KEY", "VERCEL_SANDBOX_TOKEN"];

/**
 * Deployment diagnostics that don't need log access: Node version, which env vars are set (names only, never
 * values), and whether the database answers. Public so a broken deployment can still be checked.
 */
export async function GET() {
  const env = Object.fromEntries([...REQUIRED, ...OPTIONAL].map((k) => [k, !!process.env[k]]));
  let database: { ok: boolean; error?: string };
  try {
    const { error } = await createAdminClient().from("projects").select("id").limit(1);
    database = error ? { ok: false, error: error.message.slice(0, 200) } : { ok: true };
  } catch (e) {
    database = { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
  const missing = REQUIRED.filter((k) => !process.env[k]);
  return Response.json({ ok: database.ok && !missing.length, node: process.version, missing, env, database }, { status: database.ok && !missing.length ? 200 : 503 });
}
