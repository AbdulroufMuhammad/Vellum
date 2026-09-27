import { redirect } from "next/navigation";
import { requireMain } from "@/lib/accessServer";
import AppHeader from "@/components/ui/AppHeader";
import ModelsClient from "@/components/access/ModelsClient";

export const dynamic = "force-dynamic";

/** Which build models show up in the Model picker. Main key only. */
export default async function ModelsPage() {
  if (!(await requireMain())) redirect("/access?next=/access/models");
  return (
    <div className="home">
      <AppHeader />
      <ModelsClient />
    </div>
  );
}
