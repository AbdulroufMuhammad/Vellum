export type StoredAttachment = {
  name: string;
  kind: "text" | "image" | "folder" | "video";
  content?: string;
  url?: string;
  description?: string;
  /** Videos: their first and last frames (JPEGs, read in the uploader's browser), length and size. */
  first_frame_url?: string;
  last_frame_url?: string;
  seconds?: number;
  width?: number;
  height?: number;
};

const MAX_TEXT = 200_000;
const MAX_FOLDER = 320_000;
// A cinematic scroll film is one clip per scene (up to ~8), so a message can carry that many.
export const MAX_ATTACHMENTS = 12;

/** Images and videos must be ones uploaded through /api/uploads, so the agent never fetches arbitrary URLs. */
function isOwnUpload(url: unknown): url is string {
  if (typeof url !== "string") return false;
  const base = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/artifacts/uploads/`;
  return url.startsWith(base) && !url.slice(base.length).includes("/");
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : undefined);

export function cleanAttachments(list: unknown): StoredAttachment[] {
  if (!Array.isArray(list)) return [];
  const out: StoredAttachment[] = [];
  for (const a of list.slice(0, MAX_ATTACHMENTS)) {
    if (!a || typeof a.name !== "string") continue;
    const name = a.name.slice(0, 120);
    if (a.kind === "image") {
      if (isOwnUpload(a.url)) out.push({ kind: "image", name, url: a.url });
    } else if (a.kind === "video") {
      if (!isOwnUpload(a.url)) continue;
      out.push({
        kind: "video",
        name,
        url: a.url,
        first_frame_url: isOwnUpload(a.first_frame_url) ? a.first_frame_url : undefined,
        last_frame_url: isOwnUpload(a.last_frame_url) ? a.last_frame_url : undefined,
        seconds: num(a.seconds),
        width: num(a.width),
        height: num(a.height),
      });
    } else if (typeof a.content === "string") {
      const kind = a.kind === "folder" ? "folder" : "text";
      out.push({ kind, name, content: a.content.slice(0, kind === "folder" ? MAX_FOLDER : MAX_TEXT) });
    }
  }
  return out;
}
