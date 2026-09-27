"use client";

import { useRef, useState } from "react";
import Popover, { MenuItem } from "@/components/ui/Popover";
import { IconClose, IconCode, IconFile, IconPlus } from "@/components/ui/Icons";

/** Text files carry `content`; images and videos carry a public `url` the agent can also use in designs. */
export type Attachment = {
  name: string;
  kind?: "text" | "image" | "folder" | "video";
  content?: string;
  url?: string;
  first_frame_url?: string;
  last_frame_url?: string;
  seconds?: number;
  width?: number;
  height?: number;
};

const MAX_TEXT_BYTES = 200_000;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|html?|css|scss|less|jsx?|tsx?|mjs|svg|xml|ya?ml|toml|vue|svelte|astro)$/i;
const IMAGE_TYPES = /^image\/(png|jpeg|webp|gif)$/;
const VIDEO_TYPES = /^video\/(mp4|webm|quicktime)$/;
const MAX_FILES = 12;
const MAX_IMAGE_SIDE = 1600;

// A local codebase: only the files that describe how the UI looks, within a size budget.
const FOLDER_SKIP = /(^|\/)(node_modules|\.git|\.next|dist|build|out|coverage|vendor|\.turbo|\.vercel)(\/|$)/;
const FOLDER_KEEP = /(\.(css|scss|less|tsx|jsx|vue|svelte|astro|html)$)|((tailwind|theme|tokens)[^/]*\.(js|ts|cjs|mjs|json)$)|(package\.json$)/i;
const FOLDER_MAX_FILES = 60;
const FOLDER_MAX_CHARS = 300_000;

async function downscale(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  // PNG keeps transparency (logos, icons); photos are smaller as JPEG.
  return file.type === "image/png" ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.85);
}

async function uploadDataUrl(name: string, dataUrl: string): Promise<{ name: string; url: string }> {
  const res = await fetch("/api/uploads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, dataUrl }) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Upload failed");
  return { name: data.name ?? name, url: data.url };
}

async function uploadImage(file: File): Promise<Attachment> {
  const up = await uploadDataUrl(file.name || "pasted-image.png", await downscale(file));
  return { kind: "image", name: up.name, url: up.url };
}

/**
 * A clip's length, size and first and last frames, read in this browser. If the browser can't play it, neither
 * can most visitors', so it's rejected with a fix rather than uploaded.
 */
async function readClip(file: File) {
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  v.playsInline = true;
  const src = URL.createObjectURL(file);
  v.src = src;
  try {
    await new Promise<void>((res, rej) => {
      v.onloadeddata = () => res();
      v.onerror = () => rej(new Error(`"${file.name}" won't play in this browser, so visitors couldn't see it either. Export it as MP4 (H.264) and try again.`));
      setTimeout(() => rej(new Error(`Reading "${file.name}" timed out`)), 30000);
    });
    const grab = async (t: number) => {
      await new Promise<void>((res) => {
        v.onseeked = () => res();
        v.currentTime = t;
      });
      const scale = Math.min(1, 1920 / Math.max(v.videoWidth, v.videoHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(v.videoWidth * scale);
      c.height = Math.round(v.videoHeight * scale);
      c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.88);
    };
    const first = await grab(0);
    const last = await grab(Math.max(0, v.duration - 0.05));
    return { seconds: Math.round(v.duration * 100) / 100, width: v.videoWidth, height: v.videoHeight, first, last };
  } finally {
    URL.revokeObjectURL(src);
  }
}

/** Videos go straight from the browser to storage through a signed URL: far too big for a serverless request body. */
async function uploadVideo(file: File): Promise<Attachment> {
  const clip = await readClip(file);
  const res = await fetch("/api/uploads/video", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name, type: file.type, size: file.size }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Upload failed");
  const put = await fetch(data.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
  if (!put.ok) throw new Error(`Uploading "${file.name}" failed (${put.status})`);
  const base = file.name.replace(/\.[^.]+$/, "");
  const [first, last] = await Promise.all([uploadDataUrl(`${base}-first.jpg`, clip.first), uploadDataUrl(`${base}-last.jpg`, clip.last)]);
  return {
    kind: "video",
    name: data.name ?? file.name,
    url: data.url,
    first_frame_url: first.url,
    last_frame_url: last.url,
    seconds: clip.seconds,
    width: clip.width,
    height: clip.height,
  };
}

/** Turn picked, dropped or pasted files into attachments: images and videos are uploaded, text files are read. */
export async function filesToAttachments(files: File[]): Promise<Attachment[]> {
  const out: Attachment[] = [];
  // Clips keep the order they're picked in, sorted by name so "01-…", "02-…" land in scene order.
  const sorted = [...files].sort((a, b) => (VIDEO_TYPES.test(a.type) && VIDEO_TYPES.test(b.type) ? a.name.localeCompare(b.name, undefined, { numeric: true }) : 0));
  for (const f of sorted.slice(0, MAX_FILES)) {
    if (IMAGE_TYPES.test(f.type)) out.push(await uploadImage(f));
    else if (VIDEO_TYPES.test(f.type)) out.push(await uploadVideo(f));
    else if (TEXT_EXT.test(f.name) && f.size <= MAX_TEXT_BYTES) out.push({ kind: "text", name: f.name, content: await f.text() });
  }
  return out;
}

async function folderToAttachment(files: File[]): Promise<Attachment | null> {
  const picked = files
    .map((f) => ({ f, path: (f as any).webkitRelativePath || f.name }))
    .filter(({ path, f }) => !FOLDER_SKIP.test(path) && FOLDER_KEEP.test(path) && f.size <= MAX_TEXT_BYTES)
    .sort((a, b) => a.path.length - b.path.length)
    .slice(0, FOLDER_MAX_FILES);
  if (!picked.length) return null;
  let content = "";
  for (const { f, path } of picked) {
    const text = await f.text();
    if (content.length + text.length > FOLDER_MAX_CHARS) break;
    content += `\n\n===== ${path} =====\n${text}`;
  }
  const root = String(picked[0].path).split("/")[0] || "folder";
  return { kind: "folder", name: `${root}/ (${picked.length} UI files)`, content: content.trim() };
}

export function AttachButton({ onAdd, className = "icon-btn" }: { onAdd: (a: Attachment[]) => void; className?: string }) {
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function handle(list: File[], asFolder: boolean) {
    if (!list.length) return;
    setBusy(true);
    try {
      if (asFolder) {
        const a = await folderToAttachment(list);
        if (a) onAdd([a]);
        else alert("No UI files (CSS, components, theme or Tailwind config) were found in that folder.");
      } else {
        onAdd(await filesToAttachments(list));
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Popover
        side="top"
        panelClassName="menu"
        trigger={(_o, toggle) => (
          <button type="button" className={className} title="Attach images, files or a code folder" onClick={toggle} disabled={busy}>
            {busy ? <span className="spinner" /> : <IconPlus size={18} />}
          </button>
        )}
        render={(close) => (
          <>
            <MenuItem
              onClick={() => {
                close();
                files.current?.click();
              }}
              hint="PNG, JPG, MP4, text"
            >
              <IconFile size={14} /> Images, videos or files
            </MenuItem>
            <MenuItem
              onClick={() => {
                close();
                folder.current?.click();
              }}
              hint="local codebase"
            >
              <IconCode size={14} /> Code folder
            </MenuItem>
          </>
        )}
      />
      <input
        ref={files}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime,.txt,.md,.csv,.tsv,.json,.html,.htm,.css,.js,.jsx,.ts,.tsx,.svg,.xml,.yaml,.yml"
        hidden
        onChange={(e) => {
          handle([...(e.target.files ?? [])], false);
          e.target.value = "";
        }}
      />
      <input
        ref={folder}
        type="file"
        hidden
        // @ts-expect-error non-standard but supported by every current browser
        webkitdirectory=""
        onChange={(e) => {
          handle([...(e.target.files ?? [])], true);
          e.target.value = "";
        }}
      />
    </>
  );
}

/** Paste images straight into a composer. */
export function pastedImages(e: React.ClipboardEvent): File[] {
  return [...e.clipboardData.files].filter((f) => IMAGE_TYPES.test(f.type));
}

export function AttachmentChips({ items, onRemove }: { items: Attachment[]; onRemove?: (i: number) => void }) {
  if (!items.length) return null;
  return (
    <div className="attach-chips">
      {items.map((a, i) =>
        (a.kind === "image" && a.url) || (a.kind === "video" && a.first_frame_url) ? (
          <span key={i} className={`attach-chip image${a.kind === "video" ? " video" : ""}`} title={a.kind === "video" ? `${a.name} · ${a.seconds}s · ${a.width}×${a.height}` : a.name}>
            <a href={a.url} target="_blank" rel="noreferrer">
              <img src={a.kind === "video" ? a.first_frame_url : a.url} alt={a.name} />
              {a.kind === "video" && <em className="attach-chip-dur">{Math.round(a.seconds ?? 0)}s</em>}
            </a>
            {onRemove && (
              <button type="button" onClick={() => onRemove(i)} aria-label={`Remove ${a.name}`}>
                <IconClose size={11} />
              </button>
            )}
          </span>
        ) : (
          <span key={i} className="attach-chip">
            {a.kind === "folder" ? <IconCode size={13} /> : <IconFile size={13} />}
            {a.name}
            {onRemove && (
              <button type="button" onClick={() => onRemove(i)} aria-label={`Remove ${a.name}`}>
                <IconClose size={11} />
              </button>
            )}
          </span>
        )
      )}
    </div>
  );
}
