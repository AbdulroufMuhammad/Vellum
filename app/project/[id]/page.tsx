import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadProjectData } from "@/lib/projectData";
import { listDesignSystems } from "@/lib/designSystemsServer";
import { MODELS } from "@/lib/gateway";
import { getModelOptions } from "@/lib/modelSettings";
import ProjectView from "@/components/project/ProjectView";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export default async function ProjectPage({ params }: { params: { id: string } }) {
  const admin = createAdminClient();
  const { data: project } = await admin.from("projects").select("*").eq("id", params.id).single();
  if (!project) notFound();

  const [data, systems, modelOptions] = await Promise.all([loadProjectData(admin, project), listDesignSystems(admin), getModelOptions(admin)]);
  // The project's current model stays selectable even if it's since been disabled in settings.
  const models = modelOptions.some((m) => m.key === data.project.model)
    ? modelOptions
    : [{ key: data.project.model, label: MODELS[data.project.model].label, note: MODELS[data.project.model].note }, ...modelOptions];
  return <ProjectView initial={data} systems={systems} models={models} />;
}
