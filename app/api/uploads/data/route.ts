import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { BUCKET } from "@/lib/tools/files";

export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = {
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xls",
};
const MAX_BYTES = 20 * 1024 * 1024;

/**
 * A signed URL the browser uploads a spreadsheet to directly, the same pattern as
 * /api/uploads/video: the bytes never pass through this app, only the public URL comes back.
 * run_code reads the file from that URL into its sandbox.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const type = String(body.type ?? "");
  const size = Number(body.size);
  const ext = TYPES[type] ?? (/\.xlsx$/i.test(String(body.name ?? "")) ? "xlsx" : /\.xls$/i.test(String(body.name ?? "")) ? "xls" : null);
  if (!ext) return Response.json({ error: "Only Excel files (.xlsx, .xls) can be attached here" }, { status: 400 });
  if (!(size > 0)) return Response.json({ error: "Empty file" }, { status: 400 });
  if (size > MAX_BYTES) return Response.json({ error: `That file is ${Math.round(size / 1048576)} MB; the limit is 20 MB.` }, { status: 413 });

  const db = createAdminClient();
  const key = `uploads/${randomUUID()}.${ext}`;
  const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(key);
  if (error || !data) return Response.json({ error: error?.message ?? "Couldn't start the upload" }, { status: 500 });
  const name = String(body.name ?? "spreadsheet").replace(/[^\p{L}\p{N} ._()-]/gu, "").slice(0, 120) || "spreadsheet";
  return Response.json({ name, uploadUrl: data.signedUrl, url: db.storage.from(BUCKET).getPublicUrl(key).data.publicUrl });
}
