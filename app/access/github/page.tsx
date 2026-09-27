import { redirect } from "next/navigation";
import { requireMain } from "@/lib/accessServer";
import AppHeader from "@/components/ui/AppHeader";
import GithubClient from "@/components/access/GithubClient";

export const dynamic = "force-dynamic";

/** Connect a GitHub account so the main key can base designs on private repositories. Main key only. */
export default async function GithubPage() {
  if (!(await requireMain())) redirect("/access?next=/access/github");
  return (
    <div className="home">
      <AppHeader />
      <GithubClient />
    </div>
  );
}
