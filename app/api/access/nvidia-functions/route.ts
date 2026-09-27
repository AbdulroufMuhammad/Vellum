import { requireMain } from "@/lib/accessServer";

export const dynamic = "force-dynamic";

/**
 * Which NVIDIA Cloud Functions this deployment's key can call (main key only), filtered by ?q= (default "cosmos").
 * Diagnoses "Function ... Not found for account" from preview models without ever exposing the key itself.
 */
export async function GET(req: Request) {
  if (!(await requireMain())) return Response.json({ error: "Main key only." }, { status: 403 });
  const q = (new URL(req.url).searchParams.get("q") ?? "cosmos").toLowerCase();
  const out: Record<string, unknown> = {};
  for (const [name, key] of [
    ["NVIDIA_API_KEY", process.env.NVIDIA_API_KEY],
    ["COSMOS_API_KEY", process.env.COSMOS_API_KEY],
  ] as const) {
    if (!key) {
      out[name] = "not set";
      continue;
    }
    const res = await fetch("https://api.nvcf.nvidia.com/v2/nvcf/functions?visibility=authorized", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    }).catch((e: Error) => e);
    if (res instanceof Error) {
      out[name] = { error: res.message };
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      out[name] = { status: res.status, body: text.slice(0, 300) };
      continue;
    }
    const fns: { id: string; name: string; status?: string; versionId?: string }[] = JSON.parse(text).functions ?? [];
    out[name] = {
      authorizedCount: fns.length,
      matches: fns.filter((f) => f.name?.toLowerCase().includes(q)).map((f) => ({ id: f.id, name: f.name, status: f.status, versionId: f.versionId })),
    };
  }
  return Response.json(out);
}
