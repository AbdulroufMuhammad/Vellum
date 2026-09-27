import { getProject } from "@/lib/access";
import { readFile } from "@/lib/projectData";
import { prepareForDisplay } from "@/lib/finalize";

export const dynamic = "force-dynamic";

/**
 * Serves a design as a real page (thumbnails, "Open in new tab"). The CSP
 * sandbox header gives it an opaque origin even though it's served from the
 * app's domain, so model-written HTML can't touch the app. Thumbnails get no
 * scripts at all, which keeps a grid of them cheap.
 */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const res = await getProject(params.id);
  if (!res.ok) return new Response("Not found", { status: 404 });
  const sp = new URL(req.url).searchParams;
  const file = await readFile(res.admin, params.id, sp.get("path") ?? "", Number(sp.get("v")) || undefined);
  if (!file) return new Response("Not found", { status: 404 });
  const thumb = sp.get("thumb") === "1";
  return new Response(thumb ? file.content : prepareForDisplay(file.content), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": thumb ? "sandbox" : "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": thumb ? "public, max-age=60" : "no-store",
    },
  });
}
