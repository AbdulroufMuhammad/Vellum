import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { BUCKET } from "@/lib/tools/files";

export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" };
// Supabase's per-file upload limit on the free plan.
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

/**
 * A signed URL the browser uploads a video clip to directly. Clips are far bigger than a serverless request body
 * can carry, so the bytes never pass through this app; only the public URL comes back.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const type = String(body.type ?? "");
  const size = Number(body.size);
  if (!TYPES[type]) return Response.json({ error: "Clips must be MP4 (H.264), WebM or MOV" }, { status: 400 });
  if (!(size > 0)) return Response.json({ error: "Empty file" }, { status: 400 });
  if (size > MAX_VIDEO_BYTES) return Response.json({ error: `That clip is ${Math.round(size / 1048576)} MB; the limit is 50 MB per clip. Export it shorter or at 1080p.` }, { status: 413 });

  const db = createAdminClient();
  const key = `uploads/${randomUUID()}.${TYPES[type]}`;
  const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(key);
  if (error || !data) return Response.json({ error: error?.message ?? "Couldn't start the upload" }, { status: 500 });
  const name = String(body.name ?? "clip").replace(/[^\p{L}\p{N} ._()-]/gu, "").slice(0, 120) || "clip";
  return Response.json({ name, uploadUrl: data.signedUrl, url: db.storage.from(BUCKET).getPublicUrl(key).data.publicUrl });
}
