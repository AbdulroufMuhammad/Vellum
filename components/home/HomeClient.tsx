"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { TEMPLATES, getTemplate, prefillPrompt, subjectOf } from "@/lib/templates";
import { CLIP_REQUIREMENTS } from "@/lib/cinematic";
import type { DesignSystem } from "@/lib/designSystems";
import type { ModelKey } from "@/lib/gateway";
import TemplateIcon from "@/components/home/TemplateIcon";
import ProjectsBrowser, { type ProjectRow } from "@/components/home/ProjectsBrowser";
import { CodebasePicker, DesignSystemPicker, ModelPicker, type ModelOption } from "@/components/ui/Pickers";
import { AttachButton, AttachmentChips, filesToAttachments, pastedImages, type Attachment } from "@/components/ui/Attachments";
import { IconArrowUp, IconChevronDown, IconChevronUp } from "@/components/ui/Icons";
import AppHeader from "@/components/ui/AppHeader";
import VoiceButton from "@/components/ui/VoiceButton";

export default function HomeClient({
  systems,
  models,
  projects,
  initialDs,
}: {
  systems: DesignSystem[];
  models: ModelOption[];
  projects: ProjectRow[];
  initialDs: string | null;
}) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [template, setTemplate] = useState("blank");
  const [dsId, setDsId] = useState<string | null>(initialDs);
  const [dsExtra, setDsExtra] = useState<string[]>([]);
  const [model, setModel] = useState<ModelKey>("glm");
  const [codebase, setCodebase] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [templatesOpen, setTemplatesOpen] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const selectAfter = useRef<[number, number] | null>(null);

  // Grow the box with a prefilled prompt (field-sizing isn't supported everywhere), then select the example subject.
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    if (selectAfter.current) {
      el.focus();
      el.setSelectionRange(...selectAfter.current);
      selectAfter.current = null;
    }
  }, [prompt]);

  // Picking a template writes its full prompt and process into the box, keeping
  // what the user already said it's for; their own longer writing is never overwritten.
  function chooseTemplate(id: string) {
    setTemplate(id);
    const subject = subjectOf(prompt);
    const t = getTemplate(id);
    if (subject === null) return ta.current?.focus();
    const next = prefillPrompt(t, subject || undefined);
    // Blank has no prompt of its own: it clears an untouched prefill and leaves anything edited alone.
    if (!next) {
      if (subject === "") setPrompt("");
      return ta.current?.focus();
    }
    setPrompt(next.text);
    selectAfter.current = [next.start, next.end];
  }

  useEffect(() => {
    try {
      const saved = localStorage.getItem("ds:model") as ModelKey | null;
      if (saved && models.some((m) => m.key === saved)) setModel(saved);
    } catch {}
  }, [models]);

  function chooseModel(k: ModelKey) {
    setModel(k);
    try {
      localStorage.setItem("ds:model", k);
    } catch {}
  }

  async function submit() {
    const text = prompt.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text, template, model, design_system_id: dsId, design_systems: dsExtra, codebase, attachments }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Couldn't create the project");
      router.push(`/project/${data.project.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  return (
    <div className="home">
      <AppHeader />
      <main className="home-main">
        <h1 className="home-title">What should we create?</h1>

        <div className="home-composer-wrap">
          <div className="home-composer">
            <textarea
              ref={ta}
              className="home-textarea"
              placeholder={getTemplate(template).placeholder ?? "Describe what you want to create…"}
              value={prompt}
              rows={2}
              onChange={(e) => setPrompt(e.target.value)}
              onPaste={async (e) => {
                const imgs = pastedImages(e);
                if (!imgs.length) return;
                e.preventDefault();
                try {
                  const added = await filesToAttachments(imgs);
                  setAttachments((cur) => [...cur, ...added].slice(0, 6));
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <AttachmentChips items={attachments} onRemove={(i) => setAttachments((a) => a.filter((_, j) => j !== i))} />
            <div className="home-composer-row">
              <div className="row-left">
                <AttachButton onAdd={(a) => setAttachments((cur) => [...cur, ...a].slice(0, 6))} className="square-btn" />
                <DesignSystemPicker
                  systems={systems}
                  value={dsId}
                  extra={dsExtra}
                  onChange={(primary, extra) => {
                    setDsId(primary);
                    setDsExtra(extra);
                  }}
                />
                <CodebasePicker value={codebase} onChange={setCodebase} />
              </div>
              <div className="row-right">
                <VoiceButton className="square-btn" onText={(t) => setPrompt((cur) => (cur.trim() ? `${cur.trimEnd()} ${t}` : t))} />
                <ModelPicker models={models} value={model} onChange={chooseModel} />
                <button type="button" className="send-square" onClick={submit} disabled={!prompt.trim() || submitting} aria-label="Create">
                  {submitting ? <span className="spinner" /> : <IconArrowUp size={20} />}
                </button>
              </div>
            </div>
          </div>

          <div className={`template-panel${templatesOpen ? "" : " collapsed"}`}>
            <button type="button" className="template-panel-head" onClick={() => setTemplatesOpen((v) => !v)}>
              Choose a template {templatesOpen ? <IconChevronUp size={13} /> : <IconChevronDown size={13} />}
            </button>
            {templatesOpen && (
              <div className="template-grid">
                {TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`template-tile${template === t.id ? " selected" : ""}`}
                    onClick={() => chooseTemplate(t.id)}
                  >
                    <TemplateIcon id={t.id} />
                    <span>{t.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {template === "cinematic" && (
            <details className="clip-guide" open>
              <summary>Have your own footage? Attach the clips with + and it's built from them</summary>
              <ul>
                {CLIP_REQUIREMENTS.map((r) => (
                  <li key={r.title}>
                    <strong>{r.title}.</strong> {r.detail}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
        {error && <p className="form-error">{error}</p>}

        <ProjectsBrowser projects={projects} systems={systems} onUseSystem={(id) => setDsId(id)} />
      </main>
    </div>
  );
}
