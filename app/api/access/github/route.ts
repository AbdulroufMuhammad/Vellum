import { createAdminClient } from "@/lib/supabase/admin";
import { requireMain } from "@/lib/accessServer";
import { connectGithub, disconnectGithub, githubAccount } from "@/lib/githubAccount";

export const dynamic = "force-dynamic";

const denied = () => Response.json({ error: "Only the main access key can manage the GitHub connection." }, { status: 403 });

/** The connected GitHub account, if any (never its token). Main key only. */
export async function GET() {
  if (!(await requireMain())) return denied();
  return Response.json({ account: await githubAccount(createAdminClient()), envToken: !!process.env.GITHUB_TOKEN });
}

/** Connect an account: body { token }. The token is checked with GitHub, then stored encrypted. Main key only. */
export async function POST(req: Request) {
  if (!(await requireMain())) return denied();
  const body = await req.json().catch(() => ({}));
  try {
    return Response.json({ account: await connectGithub(createAdminClient(), body?.token) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Couldn't connect." }, { status: 400 });
  }
}

/** Disconnect the account and delete its stored token. Main key only. */
export async function DELETE() {
  if (!(await requireMain())) return denied();
  try {
    await disconnectGithub(createAdminClient());
    return Response.json({ account: null });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Couldn't disconnect." }, { status: 400 });
  }
}
