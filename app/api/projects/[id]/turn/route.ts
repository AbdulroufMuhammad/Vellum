import { randomUUID } from "node:crypto";
import { getProject, notFoundResponse } from "@/lib/access";
import { runTurn } from "@/lib/agent";
import { sseResponse } from "@/lib/sse";
import { effectiveStatus } from "@/lib/projectData";
import { cleanAttachments } from "@/lib/attachments";
import { currentSession } from "@/lib/accessServer";
import { githubTokenFor } from "@/lib/githubAccount";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function cleanMeta(body: any) {
  const meta: Record<string, unknown> = {};
  const t = body?.target;
  if (t && typeof t === "object") {
    meta.target = {
      id: typeof t.id === "string" ? t.id.slice(0, 40) : null,
      tag: String(t.tag ?? "element").slice(0, 20),
      path: typeof t.path === "string" ? t.path.slice(0, 120) : null,
      text: String(t.text ?? "").slice(0, 300),
      html: String(t.html ?? "").slice(0, 2000),
    };
  }
  const attachments = cleanAttachments(body?.attachments);
  if (attachments.length) meta.attachments = attachments;
  if (body?.answers && typeof body.answers === "object") meta.answers = body.answers;
  return meta;
}

/**
 * One conversational turn: optionally store the user's message, then run the
 * design agent and stream its events. `resume` continues a turn that paused
 * itself at the time limit (status stays "running" in between).
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const res = await getProject(params.id);
  if (!res.ok) return notFoundResponse();
  const { admin, project } = res;

  const body = await req.json().catch(() => ({}));
  const resume = body?.resume === true;
  const status = effectiveStatus(project);
  if (status === "running") return Response.json({ error: "Still working on the last message" }, { status: 409 });
  if (resume && status !== "paused") return Response.json({ error: "Nothing to resume" }, { status: 409 });
  // Claim the project atomically (optimistic lock on updated_at) so two tabs can't run or resume the same turn at once.
  const runId = randomUUID();
  const { data: claimed } = await admin
    .from("projects")
    .update({ status: "running", run_id: runId, updated_at: new Date().toISOString() })
    .eq("id", params.id)
    .eq("updated_at", project.updated_at)
    .select("id");
  if (!claimed?.length) return Response.json({ error: "Another tab just started this" }, { status: 409 });

  const message = typeof body?.message === "string" ? body.message.trim() : "";
  let stored: unknown = null;
  if (message) {
    const { data } = await admin
      .from("messages")
      .insert({ project_id: params.id, role: "user", content: message.slice(0, 20_000), meta: cleanMeta(body), created_at: new Date().toISOString() })
      .select("id, role, content, meta, created_at")
      .single();
    stored = data;
  }
  const activeFile = typeof body?.activeFile === "string" ? body.activeFile : null;
  const clientId = typeof body?.clientId === "string" ? body.clientId : null;
  // A connected GitHub account (private repositories) is only ever used for the main key's own turns.
  const githubToken = project.codebase ? await githubTokenFor(admin, await currentSession()).catch(() => null) : null;

  return sseResponse(req, async (send, signal) => {
    if (stored) send({ type: "message", payload: { message: stored, replaces: clientId } });
    await runTurn(admin, params.id, { onEvent: send, signal, resume, activeFile, runId, githubToken });
  });
}
