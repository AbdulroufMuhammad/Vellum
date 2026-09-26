import type { SupabaseClient } from "@supabase/supabase-js";
import { removeEmDashes } from "@/lib/finalize";

export const BUCKET = "artifacts";

/** File names are what the user sees ("Landing Page.html"); always one flat, .html name. */
export function cleanPath(raw: string) {
  const base = String(raw ?? "")
    .split(/[\\/]/)
    .pop()!
    .replace(/[^\p{L}\p{N} ._()+-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const name = base.replace(/\.html?$/i, "").trim() || "index";
  return `${name}.html`;
}

// Each write gets its own object (rev), even when it updates a working version, so no cache can serve an old copy.
const storageKey = (projectId: string, version: number, path: string, rev?: number) =>
  `${projectId}/${version}/${rev ? `${rev}-` : ""}${path.replace(/[^A-Za-z0-9._-]+/g, "-")}`;

/**
 * The versions an agent request is still working on, per file. Writes during a request update that one
 * working version instead of adding a version per edit; the version is final once the request is done
 * and verified (the caller then clears this). The next request, or the user's own edit, starts a new one.
 */
export type WorkingVersions = { versions: Record<string, number>; save: () => Promise<unknown> };

/**
 * `text` with whitespace runs collapsed to one space and the data-el ids the app
 * adds left out, plus, for each character kept, where it came from in `text`.
 */
function loosen(text: string) {
  let out = "";
  const from: number[] = [];
  for (let i = 0; i < text.length; ) {
    const id = /^\s+data-el="[^"]*"/.exec(text.slice(i, i + 40));
    if (id) {
      i += id[0].length;
      continue;
    }
    if (/\s/.test(text[i])) {
      let j = i;
      while (j < text.length && /\s/.test(text[j])) j++;
      out += " ";
      from.push(i);
      i = j;
      continue;
    }
    out += text[i];
    from.push(i);
    i++;
  }
  return { out, from };
}

/**
 * Where old_str is in the file: exactly, or, since stored files are tidied on
 * every write (ids added, em dashes replaced, spacing), ignoring those
 * differences. Null when it isn't there, or isn't there just once.
 */
export function locate(content: string, oldStr: string): { start: number; end: number } | "many" | null {
  const variants = [...new Set([oldStr, removeEmDashes(oldStr)])];
  for (const v of variants) {
    const at = content.indexOf(v);
    if (at >= 0) return content.indexOf(v, at + v.length) >= 0 ? "many" : { start: at, end: at + v.length };
  }
  const file = loosen(content);
  for (const v of variants) {
    const needle = loosen(v).out.trim();
    if (needle.length < 8) continue;
    const at = file.out.indexOf(needle);
    if (at < 0) continue;
    if (file.out.indexOf(needle, at + needle.length) >= 0) return "many";
    const last = at + needle.length - 1;
    return { start: file.from[at], end: file.from[last] + 1 };
  }
  return null;
}

/** The part of the file closest to what old_str was meant to match, to copy from. */
export function nearestText(content: string, oldStr: string) {
  const lines = oldStr.split("\n").map((l) => l.trim()).filter((l) => l.length >= 10);
  const fileLoose = loosen(content);
  for (const line of lines.sort((a, b) => b.length - a.length)) {
    const at = fileLoose.out.indexOf(loosen(line).out.trim());
    if (at < 0) continue;
    const pos = fileLoose.from[at];
    const start = content.lastIndexOf("\n", Math.max(0, pos - 400)) + 1;
    const end = content.indexOf("\n", Math.min(content.length, pos + oldStr.length + 400));
    return content.slice(start, end < 0 ? content.length : end);
  }
  return null;
}

export type FileWrite = { path: string; version: number; url: string; created: boolean };

/**
 * Artifact files: bytes in Supabase Storage, one immutable object per
 * version, with the `files` table as the version index. `transform` runs on
 * every write (see lib/finalize.ts).
 */
export function makeFileTools(db: SupabaseClient, projectId: string, transform?: (content: string) => string, working?: WorkingVersions) {
  async function latest(path: string) {
    const { data } = await db
      .from("files")
      .select("version, storage_path")
      .eq("project_id", projectId)
      .eq("path", path)
      .order("version", { ascending: false })
      .limit(1);
    return data?.[0] ?? null;
  }

  async function write_file({ path, content }: { path: string; content: string }): Promise<FileWrite> {
    if (/\.(js|mjs|css|json|ts|tsx|jsx)$/i.test(String(path ?? "").trim()))
      throw new Error("each design is one self-contained HTML file; put scripts and styles inline in it instead of separate files");
    path = cleanPath(path);
    if (typeof content !== "string" || !content.trim()) throw new Error("content is empty");
    if (transform) content = transform(content);
    const prev = await latest(path);
    const reuse = !!working && !!prev && working.versions[path] === prev.version;
    const version = reuse ? prev!.version : (prev?.version ?? 0) + 1;
    const key = storageKey(projectId, version, path, reuse ? Date.now() : undefined);
    const { error } = await db.storage
      .from(BUCKET)
      .upload(key, new Blob([content], { type: "text/html" }), { contentType: "text/html; charset=utf-8", upsert: true });
    if (error) throw new Error(`storage upload failed: ${error.message}`);
    if (reuse) {
      const { error: rowErr } = await db
        .from("files")
        .update({ storage_path: key, created_at: new Date().toISOString() })
        .eq("project_id", projectId)
        .eq("path", path)
        .eq("version", version);
      if (rowErr) throw new Error(`saving file failed: ${rowErr.message}`);
    } else {
      const { error: rowErr } = await db
        .from("files")
        .insert({ project_id: projectId, path, version, storage_path: key, content_type: "text/html" });
      if (rowErr) throw new Error(`saving file failed: ${rowErr.message}`);
      if (working) {
        working.versions[path] = version;
        await working.save();
      }
    }
    return { path, version, url: db.storage.from(BUCKET).getPublicUrl(key).data.publicUrl, created: !prev };
  }

  async function read_file({ path, version }: { path: string; version?: number }) {
    path = cleanPath(path);
    let q = db.from("files").select("version, storage_path").eq("project_id", projectId).eq("path", path);
    q = version ? q.eq("version", version) : q.order("version", { ascending: false });
    const { data } = await q.limit(1);
    const row = data?.[0];
    if (!row) throw new Error(`file not found: ${path}`);
    const { data: blob, error } = await db.storage.from(BUCKET).download(row.storage_path);
    if (error || !blob) throw new Error(`storage download failed: ${error?.message}`);
    return { path, version: row.version as number, content: await blob.text() };
  }

  async function str_replace({ path, old_str, new_str }: { path: string; old_str: string; new_str: string }) {
    const current = await read_file({ path });
    if (!old_str) throw new Error("old_str is empty; copy the exact text to replace from the file");
    const found = locate(current.content, old_str);
    if (found === "many") throw new Error("old_str appears more than once; include more surrounding text");
    if (!found) {
      const near = nearestText(current.content, old_str);
      throw new Error(
        near
          ? `old_str isn't in the file as written. The closest part of the file (version ${current.version}) is below; copy the text to replace from it exactly:\n${near.slice(0, 2500)}`
          : "old_str not found in the file; read_file it again and copy the exact text"
      );
    }
    const content = current.content.slice(0, found.start) + String(new_str ?? "") + current.content.slice(found.end);
    return write_file({ path, content });
  }

  return { write_file, read_file, str_replace };
}

export const FILE_TOOL_SCHEMAS = [
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description:
        'Create a design file or replace it entirely. One complete, self-contained HTML document per file. Use a short descriptive name like "Landing Page.html".',
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string", description: "The full HTML document" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "str_replace",
      description: "Replace one exact, unique substring in an existing file. Best for targeted edits.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, old_str: { type: "string" }, new_str: { type: "string" } },
        required: ["path", "old_str", "new_str"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read the latest version of a file in this project.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
];
