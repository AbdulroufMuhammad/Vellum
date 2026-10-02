"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FileEntry, StoredMessage } from "@/lib/projectData";
import type { Attachment } from "@/components/ui/Attachments";
import { IconClose, IconFile, IconRefresh } from "@/components/ui/Icons";

type Upload = { name: string; kind: "image" | "text" | "folder" | "video" | "data"; url?: string; poster?: string; at: string; pending?: boolean };

function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/**
 * Every file in the project in one place: the pages the agent made (open one
 * on the canvas), what's been uploaded as context (images, sketches, text,
 * folders), plus new pages, sketches, pasting and dropping files in.
 */
export default function FilesBrowser({
  projectId,
  files,
  messages,
  pending,
  activePath,
  onOpen,
  onNewPage,
  onNewSketch,
  onPaste,
  onDropFiles,
  onRefresh,
  onClose,
}: {
  projectId: string;
  files: FileEntry[];
  messages: StoredMessage[];
  pending: Attachment[];
  activePath: string | null;
  onOpen: (path: string) => void;
  onNewPage: () => void;
  onNewSketch: () => void;
  onPaste: () => void;
  onDropFiles: (files: File[]) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<{ type: "page"; path: string } | { type: "upload"; index: number } | null>(activePath ? { type: "page", path: activePath } : null);
  const [dragging, setDragging] = useState(false);
  // The page preview renders at 1280px wide and is scaled to fit the pane.
  const thumb = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = thumb.current;
    if (!el) return;
    const fit = () => el.style.setProperty("--fb-scale", String(el.clientWidth / 1280));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  });

  const uploads = useMemo<Upload[]>(() => {
    const out: Upload[] = [];
    for (const m of messages) {
      for (const a of (m.meta?.attachments ?? []) as Attachment[]) out.push({ name: a.name, kind: a.kind ?? "text", url: a.url, poster: a.first_frame_url, at: m.created_at });
    }
    for (const a of pending) out.push({ name: a.name, kind: a.kind ?? "text", url: a.url, poster: a.first_frame_url, at: new Date().toISOString(), pending: true });
    return out.reverse();
  }, [messages, pending]);

  const pages = [...files].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  const sel = selected?.type === "page" ? pages.find((p) => p.path === selected.path) : null;
  const up = selected?.type === "upload" ? uploads[selected.index] : null;

  return (
    <div
      className={`files-browser${dragging ? " dragging" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const list = Array.from(e.dataTransfer.files ?? []);
        if (list.length) onDropFiles(list);
      }}
    >
      <div className="fb-bar">
        <button type="button" className="icon-btn" title="Refresh" onClick={onRefresh}>
          <IconRefresh size={15} />
        </button>
        <span className="fb-crumb">project</span>
        <span className="grow" />
        <button type="button" className="btn-ghost sm" onClick={onNewPage}>
          + New page
        </button>
        <button type="button" className="btn-ghost sm" onClick={onNewSketch}>
          ✎ New sketch
        </button>
        <button type="button" className="btn-ghost sm" onClick={onPaste}>
          Paste
        </button>
        <button type="button" className="icon-btn" title="Back to the canvas" onClick={onClose}>
          <IconClose size={15} />
        </button>
      </div>
      <div className="fb-body">
        <div className="fb-list">
          <div className="fb-section">Pages</div>
          {pages.length === 0 && <p className="fb-empty">No pages yet. Describe a design in the chat, or start a new page.</p>}
          {pages.map((f) => (
            <button
              key={f.path}
              type="button"
              className={`fb-row${selected?.type === "page" && selected.path === f.path ? " on" : ""}`}
              onClick={() => setSelected({ type: "page", path: f.path })}
              onDoubleClick={() => onOpen(f.path)}
            >
              <span className="fb-icon page">
                <IconFile size={15} />
              </span>
              <span className="fb-name">
                {f.path}
                <small>HTML page · v{f.version}</small>
              </span>
              <span className="fb-time" suppressHydrationWarning>
                {ago(f.updated_at)}
              </span>
            </button>
          ))}
          <div className="fb-section">Uploads and sketches</div>
          {uploads.length === 0 && <p className="fb-empty">Nothing uploaded yet. Drop images or files here, paste, or make a sketch.</p>}
          {uploads.map((u, i) => (
            <button key={`${u.name}-${i}`} type="button" className={`fb-row${selected?.type === "upload" && selected.index === i ? " on" : ""}`} onClick={() => setSelected({ type: "upload", index: i })}>
              <span className={`fb-icon ${u.kind}`}>{u.kind === "image" && u.url ? <img src={u.url} alt="" /> : u.kind === "video" && u.poster ? <img src={u.poster} alt="" /> : <IconFile size={15} />}</span>
              <span className="fb-name">
                {u.name}
                <small>{u.kind === "image" ? (/^sketch/i.test(u.name) ? "Sketch" : "Image") : u.kind === "folder" ? "Code folder" : u.kind === "video" ? "Video clip" : u.kind === "data" ? "Data file" : "Text"}{u.pending ? " · attached to your next message" : ""}</small>
              </span>
              <span className="fb-time" suppressHydrationWarning>
                {u.pending ? "" : ago(u.at)}
              </span>
            </button>
          ))}
          <div className="fb-drop">
            <strong>Drop files here</strong>
            <span>Images, docs, references or folders: the agent will use them as context.</span>
          </div>
        </div>
        <div className="fb-preview">
          {sel ? (
            <>
              <div className="fb-thumb" ref={thumb}>
                <iframe title={sel.path} src={`/api/projects/${projectId}/render?path=${encodeURIComponent(sel.path)}&thumb=1&v=${sel.version}`} sandbox="" loading="lazy" />
              </div>
              <div className="fb-meta">
                <strong>{sel.path.replace(/\.html$/, "")}</strong>
                <span className="muted" suppressHydrationWarning>
                  Version {sel.version} · edited {ago(sel.updated_at)}
                </span>
              </div>
              <button type="button" className="btn-accent" onClick={() => onOpen(sel.path)}>
                Open on canvas
              </button>
            </>
          ) : up ? (
            <>
              <div className="fb-thumb image">{up.kind === "image" && up.url ? <img src={up.url} alt={up.name} /> : up.kind === "video" && up.url ? <video src={up.url} poster={up.poster} controls muted playsInline /> : <IconFile size={28} />}</div>
              <div className="fb-meta">
                <strong>{up.name}</strong>
                <span className="muted">{up.pending ? "Attached to your next message" : "Sent to the agent as context"}</span>
              </div>
            </>
          ) : (
            <p className="muted">Select a file to preview</p>
          )}
        </div>
      </div>
    </div>
  );
}
