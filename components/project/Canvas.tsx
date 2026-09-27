"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { buildSrcDoc, DRAFT_SHELL, type BridgeOut, type CanvasMode } from "@/lib/canvasBridge";
import { escapeMathAngles } from "@/lib/mathText";

export type CanvasHandle = { post: (msg: Record<string, unknown>) => void; frame: () => HTMLIFrameElement | null };

type Props = {
  html: string | null;
  /** Changes whenever the shown document should be reloaded (file, version, manual refresh). */
  docKey: string;
  draft: string | null;
  mode: CanvasMode;
  zoom: number;
  onMessage: (m: BridgeOut) => void;
};

/**
 * The live canvas. Designs run in an iframe sandboxed without
 * allow-same-origin, so model-written code can never reach the app; all
 * interaction goes through lib/canvasBridge.ts over postMessage. While the
 * agent is writing, the frame holds a bare shell and each streamed draft
 * replaces its DOM in place, so the page builds up without reloading.
 */
const Canvas = forwardRef<CanvasHandle, Props>(function Canvas({ html, docKey, draft, mode, zoom, onMessage }, ref) {
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const lastDraftPost = useRef(0);
  const pendingDraft = useRef<string | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout>>();
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const drafting = draft != null;
  const srcDoc = useMemo(() => (drafting ? DRAFT_SHELL : html != null ? buildSrcDoc(escapeMathAngles(html)) : null), [drafting, html, docKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const post = (msg: Record<string, unknown>) => frame.current?.contentWindow?.postMessage({ ...msg, __ds: 1 }, "*");
  useImperativeHandle(ref, () => ({ post, frame: () => frame.current }));

  useEffect(() => {
    ready.current = false;
  }, [srcDoc]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow || !e.data?.__ds) return;
      const m = e.data as BridgeOut;
      if (m.t === "ready") {
        ready.current = true;
        post({ t: "mode", mode: modeRef.current });
        if (pendingDraft.current != null) flushDraft();
      }
      onMessageRef.current(m);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  useEffect(() => {
    if (ready.current) post({ t: "mode", mode });
  }, [mode]);

  function flushDraft() {
    if (!ready.current || pendingDraft.current == null) return;
    post({ t: "draft", html: escapeMathAngles(pendingDraft.current) });
    pendingDraft.current = null;
    lastDraftPost.current = Date.now();
  }

  useEffect(() => {
    if (draft == null) return;
    pendingDraft.current = draft;
    const wait = Math.max(0, 350 - (Date.now() - lastDraftPost.current));
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(flushDraft, wait);
  }, [draft]);

  if (srcDoc == null) return null;
  const scale = zoom / 100;
  return (
    <div className="canvas-viewport">
      <div className="canvas-scaler" style={{ width: `${100 / scale}%`, height: `${100 / scale}%`, transform: `scale(${scale})` }}>
        <iframe
          ref={frame}
          key={drafting ? "draft" : docKey}
          className="canvas-frame"
          title="Design canvas"
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
          srcDoc={srcDoc}
        />
      </div>
    </div>
  );
});

export default Canvas;
