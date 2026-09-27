import { createAdminClient } from "@/lib/supabase/admin";
import { listDesignSystems } from "@/lib/designSystemsServer";
import { getModelOptions } from "@/lib/modelSettings";
import HomeClient from "@/components/home/HomeClient";

// Lists live projects — never frozen at build time or served from a cached fetch.
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export default async function HomePage({ searchParams }: { searchParams: { ds?: string } }) {
  const admin = createAdminClient();
  const [{ data: projects }, systems, models] = await Promise.all([
    admin.from("projects").select("id, title, template, status, updated_at").order("updated_at", { ascending: false }).limit(60),
    listDesignSystems(admin),
    getModelOptions(admin),
  ]);

  // The most recently written file of each project becomes its thumbnail.
  const ids = (projects ?? []).map((p) => p.id);
  const thumbs = new Map<string, string>();
  if (ids.length) {
    const { data: files } = await admin
      .from("files")
      .select("project_id, path, created_at")
      .in("project_id", ids)
      .order("created_at", { ascending: false })
      .limit(1000);
    for (const f of files ?? []) if (!thumbs.has(f.project_id)) thumbs.set(f.project_id, f.path);
  }

  return (
    <HomeClient
      systems={systems}
      models={models}
      initialDs={searchParams.ds ?? null}
      projects={(projects ?? []).map((p) => ({
        ...p,
        thumb: thumbs.has(p.id) ? `/api/projects/${p.id}/render?thumb=1&path=${encodeURIComponent(thumbs.get(p.id)!)}` : null,
      }))}
    />
  );
}
