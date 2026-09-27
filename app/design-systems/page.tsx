import { createAdminClient } from "@/lib/supabase/admin";
import { listDesignSystems } from "@/lib/designSystemsServer";
import DesignSystemsClient from "@/components/DesignSystemsClient";
import AppHeader from "@/components/ui/AppHeader";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

export default async function DesignSystemsPage({ searchParams }: { searchParams: { new?: string } }) {
  const admin = createAdminClient();
  const systems = await listDesignSystems(admin);

  return (
    <div className="home">
      <AppHeader />
      <main className="ds-main">
        <DesignSystemsClient initialSystems={systems} startNew={searchParams.new === "1"} />
      </main>
    </div>
  );
}
