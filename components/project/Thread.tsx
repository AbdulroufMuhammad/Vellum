"use client";

import { useEffect, useRef, useState } from "react";
import type { Row } from "@/lib/thread";
import { answersMessage, formatAnswer, type Answer, type Question } from "@/lib/questions";
import Markdown from "@/components/ui/Markdown";
import { AttachmentChips } from "@/components/ui/Attachments";
import { IconBolt, IconSparkle, IconChevronDown, IconChevronRight, IconComment, IconExternal, IconFile, IconThumbDown, IconThumbUp } from "@/components/ui/Icons";

function UserMessage({ row }: { row: Extract<Row, { kind: "user" }> }) {
  const meta = row.meta ?? {};
  const anchor = `msg-${row.key.slice(1)}`;
  if (meta.answers) {
    // "Question\n→ answer" blocks (older messages: "id: answer" lines).
    const blocks = row.text.includes("\n→ ")
      ? row.text.split(/\n{2,}/).map((b) => {
          const [q, ...a] = b.split("\n→ ");
          return { q, a: a.join(" ") };
        })
      : row.text.split("\n").map((line) => {
          const at = line.indexOf(": ");
          return at > 0 ? { q: line.slice(0, at), a: line.slice(at + 2) } : { q: "", a: line };
        });
    return (
      <div className="msg-user brief" id={anchor}>
        {blocks.map((b, i) => (
          <div key={i} className="brief-item">
            {b.q && <div className="brief-q">{b.q}</div>}
            <div className="brief-a">{b.a}</div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="msg-user" id={anchor}>
      {meta.target && (
        <div className="msg-target">
          <IconComment size={12} /> {meta.resolved ? "Resolved · " : ""}On &lt;{meta.target.tag}&gt;
          {meta.target.text ? ` “${String(meta.target.text).slice(0, 60)}${String(meta.target.text).length > 60 ? "…" : ""}”` : ""}
        </div>
      )}
      <div className="msg-user-text">{row.text}</div>
      {meta.attachments?.length > 0 && <AttachmentChips items={meta.attachments} />}
    </div>
  );
}

function Activity({ row }: { row: Extract<Row, { kind: "activity" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`activity${row.active ? " active" : ""}${open ? " open" : ""}`}>
      <button type="button" className="activity-head" onClick={() => setOpen((v) => !v)}>
        <IconBolt size={13} />
        <span className="activity-title">{row.title}</span>
        {row.tools.length > 0 && (open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />)}
      </button>
      {open && row.tools.length > 0 && (
        <ul className="activity-tools">
          {row.tools.map((t) => (
            <li key={t.callId} className={t.error ? "err" : ""}>
              <span>{t.label}</span>
              {t.error && <span className="tool-err">{t.error}</span>}
              {t.image && (
                <a href={t.image} target="_blank" rel="noreferrer" className="check-shot">
                  <img src={t.image} alt="Screenshot of the design as rendered" loading="lazy" />
                </a>
              )}
              {t.findings && t.findings.length > 0 && (
                <ul className="findings">
                  {t.findings.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              )}
              {t.links?.slice(0, 6).map((l) =>
                l.url ? (
                  <a key={l.url} href={l.url} target="_blank" rel="noreferrer">
                    {l.title}
                  </a>
                ) : null
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const secs = (ms: number) => (ms >= 1000 ? `${Math.round(ms / 1000)}s` : "a moment");

/** The model's reasoning for one step, collapsed to a "Thought for Ns" row that opens to the full text. */
function Thought({ text, ms }: { text: string; ms: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`activity thought${open ? " open" : ""}`}>
      <button type="button" className="activity-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <IconSparkle size={13} />
        <span className="activity-title">Thought for {secs(ms)}</span>
        {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
      </button>
      {open && <div className="thought-text">{text}</div>}
    </div>
  );
}

/** The live "Thinking" row: click it to watch the reasoning (or the reply) stream in. */
function LiveThinking({ reasoning, text, open, setOpen }: { reasoning: string; text: string; open: boolean; setOpen: (fn: (v: boolean) => boolean) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const body = reasoning || text;
  useEffect(() => {
    if (open && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [open, body]);
  return (
    <div className={`activity active thought${open ? " open" : ""}`}>
      <button type="button" className="activity-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <IconSparkle size={13} />
        <span className="activity-title">Thinking</span>
        {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
      </button>
      {open && (
        <div className="thought-text live" ref={box}>
          {body || <span className="muted">Waiting for the model… This model may not share its reasoning; its progress notes will appear here as it works.</span>}
        </div>
      )}
    </div>
  );
}

/** One field of the clarifying form, rendered by its type. */
function QuestionField({ q, value, onChange }: { q: Question; value: Answer; onChange: (v: Answer) => void }) {
  const [other, setOther] = useState("");
  switch (q.type) {
    case "single":
    case "multi": {
      const multi = q.type === "multi";
      const picked = multi ? (Array.isArray(value) ? value : []) : typeof value === "string" ? value : "";
      const isOn = (o: string) => (multi ? (picked as string[]).includes(o) : picked === o);
      const toggle = (o: string) => {
        if (multi) {
          const list = picked as string[];
          onChange(list.includes(o) ? list.filter((x) => x !== o) : [...list, o]);
        } else {
          setOther("");
          onChange(picked === o ? null : o);
        }
      };
      const typedOther = multi ? (picked as string[]).find((x) => !q.options.includes(x)) : !q.options.includes(picked as string) ? (picked as string) : "";
      return (
        <>
          <div className="question-options" role={multi ? "group" : "radiogroup"}>
            {q.options.map((o) => (
              <button key={o} type="button" role={multi ? "checkbox" : "radio"} aria-checked={isOn(o)} className={`opt${multi ? " check" : ""}${isOn(o) ? " on" : ""}`} onClick={() => toggle(o)}>
                {multi && <span className="opt-box" aria-hidden>{isOn(o) ? "✓" : ""}</span>}
                {o}
              </button>
            ))}
          </div>
          {q.other && (
            <input
              className="question-other"
              placeholder={multi ? "Anything else? Type it here" : "Or type your own…"}
              value={other || typedOther || ""}
              onChange={(e) => {
                const t = e.target.value;
                setOther(t);
                if (multi) {
                  const known = (picked as string[]).filter((x) => q.options.includes(x));
                  onChange(t.trim() ? [...known, t] : known);
                } else onChange(t.trim() ? t : null);
              }}
            />
          )}
        </>
      );
    }
    case "select":
      return (
        <select className="question-input" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">Choose…</option>
          {q.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case "long":
      return <textarea className="question-input long" rows={3} placeholder={q.placeholder ?? "Type your answer…"} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />;
    case "number":
      return (
        <input
          className="question-input short"
          type="number"
          min={q.min}
          max={q.max}
          step={q.step}
          placeholder={q.placeholder ?? ""}
          value={typeof value === "number" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
      );
    case "slider": {
      const min = q.min ?? 0;
      const max = q.max ?? 10;
      const v = typeof value === "number" ? value : null;
      return (
        <div className="question-slider">
          <span className="muted">{min}</span>
          <input type="range" min={min} max={max} step={q.step ?? 1} value={v ?? Math.round((min + max) / 2)} onChange={(e) => onChange(Number(e.target.value))} className={v == null ? "unset" : ""} />
          <span className="muted">{max}</span>
          <span className="question-slider-value">{v ?? "Your call"}</span>
        </div>
      );
    }
    case "toggle":
      return (
        <div className="question-options" role="radiogroup">
          {["yes", "no"].map((o) => (
            <button key={o} type="button" role="radio" aria-checked={value === o} className={`opt${value === o ? " on" : ""}`} onClick={() => onChange(value === o ? null : o)}>
              {o === "yes" ? "Yes" : "No"}
            </button>
          ))}
        </div>
      );
    default:
      return <input className="question-input" placeholder={q.placeholder ?? "Type your answer…"} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />;
  }
}

function QuestionsCard({ row, disabled, onAnswer }: { row: Extract<Row, { kind: "questions" }>; disabled: boolean; onAnswer: (text: string, answers: Record<string, string>) => void }) {
  const [answers, setAnswers] = useState<Record<string, Answer>>(() => Object.fromEntries(row.questions.map((q) => [q.id, (q.default as Answer) ?? null])));

  if (row.answered) {
    return (
      <div className="questions done">
        {row.intro && <p className="questions-intro">{row.intro}</p>}
        <ul>
          {row.questions.map((q) => (
            <li key={q.id}>{q.question}</li>
          ))}
        </ul>
      </div>
    );
  }
  const answeredCount = row.questions.filter((q) => formatAnswer(q, answers[q.id] ?? null) !== "Your call").length;
  function submit(skip = false) {
    const out: Record<string, string> = {};
    for (const q of row.questions) out[q.id] = skip ? "Your call" : formatAnswer(q, answers[q.id] ?? null);
    onAnswer(answersMessage(row.questions, answers, skip), out);
  }
  return (
    <form
      className="questions"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled) submit();
      }}
    >
      {row.intro && <p className="questions-intro">{row.intro}</p>}
      {row.questions.map((q, i) => (
        <div key={q.id} className="question">
          <div className="question-label">
            <span className="question-num">{i + 1}</span>
            {q.question}
            {q.type === "multi" && <span className="question-kind">Pick any</span>}
          </div>
          {q.help && <div className="question-help">{q.help}</div>}
          <QuestionField q={q} value={answers[q.id] ?? null} onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))} />
        </div>
      ))}
      <div className="questions-actions">
        <span className="questions-progress">
          {answeredCount} of {row.questions.length} answered
        </span>
        <button type="button" className="btn-ghost" disabled={disabled} onClick={() => submit(true)}>
          Skip, use your judgement
        </button>
        <button type="submit" className="btn-accent" disabled={disabled}>
          Continue
        </button>
      </div>
    </form>
  );
}

const PHASES: Record<string, string> = { split: "Splitting the research", research: "Researching", plan: "Planning", build: "Building", check: "Checking and fixing" };

function PhaseDivider({ name }: { name: string }) {
  return (
    <div className="phase-divider">
      <span>{PHASES[name] ?? name}</span>
    </div>
  );
}

/** The plan the planning step handed in: the summary shows, the rest opens on click. */
function PlanCard({ plan }: { plan: Extract<Row, { kind: "plan" }>["plan"] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`plan-card${open ? " open" : ""}`}>
      <button type="button" className="plan-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="plan-label">Plan</span>
        <span className="plan-title">{plan.title}</span>
        {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
      </button>
      {plan.summary && <p className="plan-summary">{plan.summary}</p>}
      {open && (
        <div className="plan-body">
          {plan.direction && (
            <p>
              <strong>Direction.</strong> {plan.direction}
            </p>
          )}
          {plan.sections.length > 0 && (
            <ol>
              {plan.sections.map((x, i) => (
                <li key={i}>
                  <strong>{x.name}</strong>
                  {x.detail ? `: ${x.detail}` : ""}
                </li>
              ))}
            </ol>
          )}
          {plan.files.length > 0 && <p className="muted">Files: {plan.files.join(", ")}</p>}
          {plan.notes && <p className="muted">{plan.notes}</p>}
        </div>
      )}
    </div>
  );
}

function Reply({ row }: { row: Extract<Row, { kind: "reply" }> }) {
  const [vote, setVote] = useState<0 | 1 | -1>(0);
  const files = [row.created && `Created ${row.created} file${row.created > 1 ? "s" : ""}`, row.edited && `Edited ${row.edited} file${row.edited > 1 ? "s" : ""}`].filter(Boolean);
  return (
    <div className="msg-agent">
      <div className="prose">
        <Markdown text={row.text} />
      </div>
      <div className="msg-foot">
        <button type="button" className={`icon-btn xs${vote === 1 ? " on" : ""}`} onClick={() => setVote(vote === 1 ? 0 : 1)} aria-label="Good response">
          <IconThumbUp size={13} />
        </button>
        <button type="button" className={`icon-btn xs${vote === -1 ? " on" : ""}`} onClick={() => setVote(vote === -1 ? 0 : -1)} aria-label="Bad response">
          <IconThumbDown size={13} />
        </button>
        {files.length > 0 && <span>{files.join(" · ")}</span>}
      </div>
    </div>
  );
}

export default function Thread({
  rows,
  running,
  liveText,
  liveReasoning,
  activePath,
  onOpenFile,
  onAnswer,
}: {
  rows: Row[];
  running: boolean;
  liveText: string;
  liveReasoning: string;
  activePath: string | null;
  onOpenFile: (path: string) => void;
  onAnswer: (text: string, answers: Record<string, string>) => void;
}) {
  const last = rows[rows.length - 1];
  // Kept here so the row stays open across steps while the user is watching it.
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const showThinking = running && (!!liveReasoning || (!liveText && !(last?.kind === "activity" && last.active)));
  return (
    <div className="thread">
      {rows.map((row) => {
        switch (row.kind) {
          case "user":
            return <UserMessage key={row.key} row={row} />;
          case "thought":
            return <Thought key={row.key} text={row.text} ms={row.ms} />;
          case "activity":
            return <Activity key={row.key} row={row} />;
          case "file":
            return (
              <button key={row.key} type="button" className={`file-chip${row.path === activePath ? " current" : ""}`} onClick={() => onOpenFile(row.path)}>
                <IconFile size={14} />
                <span className="file-chip-name">{row.path}</span>
                <span className="file-chip-v">v{row.version}</span>
                <IconExternal size={13} />
              </button>
            );
          case "phase":
            return <PhaseDivider key={row.key} name={row.name} />;
          case "plan":
            return <PlanCard key={row.key} plan={row.plan} />;
          case "questions":
            return <QuestionsCard key={row.key} row={row} disabled={running} onAnswer={onAnswer} />;
          case "reply":
            return <Reply key={row.key} row={row} />;
          case "error":
            return (
              <div key={row.key} className="msg-error">
                {row.text}
              </div>
            );
        }
      })}
      {showThinking && <LiveThinking reasoning={liveReasoning} text={liveText} open={thinkingOpen} setOpen={setThinkingOpen} />}
      {running && liveText && (
        <div className="msg-agent live">
          <div className="prose">
            <Markdown text={liveText.length > 1200 ? "…" + liveText.slice(-1200) : liveText} />
          </div>
        </div>
      )}
    </div>
  );
}
