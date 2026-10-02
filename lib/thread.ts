import type { StoredEvent, StoredMessage } from "@/lib/projectData";
import { cleanQuestions, type Question } from "@/lib/questions";

export type ToolRow = {
  callId: string;
  name: string;
  label: string;
  active: boolean;
  error?: string;
  links?: { title: string; url: string }[];
  image?: string | null;
  findings?: string[];
};
export type { Question };

export type Row =
  | { kind: "user"; key: string; text: string; meta: any }
  | { kind: "thought"; key: string; text: string; ms: number }
  | { kind: "activity"; key: string; title: string; tools: ToolRow[]; active: boolean }
  | { kind: "file"; key: string; path: string; version: number }
  | { kind: "questions"; key: string; intro: string; questions: Question[]; answered: boolean }
  | { kind: "phase"; key: string; name: string }
  | { kind: "plan"; key: string; plan: { title: string; summary: string; direction: string; sections: { name: string; detail: string }[]; files: string[]; notes: string } }
  | { kind: "reply"; key: string; text: string; created: number; edited: number }
  | { kind: "error"; key: string; text: string };

const host = (u: string) => u.replace(/^https?:\/\//, "").split("/")[0];

function toolLabel(name: string, p: any, done: boolean): string {
  switch (name) {
    case "web_search":
      return `${done ? "Searched" : "Searching"} “${p.query ?? p.args?.query ?? ""}”`;
    case "web_fetch":
      return `${done ? "Read" : "Reading"} ${p.source?.title ?? p.args?.source_id ?? "a source"}`;
    case "read_file":
      return `${done ? "Read" : "Reading"} ${p.path ?? p.args?.path ?? "a file"}`;
    case "write_file":
      return `${done ? "Wrote" : "Writing"} ${p.path ?? p.args?.path ?? "a file"}`;
    case "append_file":
      return `${done ? "Finished writing" : "Finishing"} ${p.path ?? p.args?.path ?? "a file"}`;
    case "str_replace":
      return `${done ? "Edited" : "Editing"} ${p.path ?? p.args?.path ?? "a file"}`;
    case "repo_tree":
      return `${done ? "Browsed" : "Browsing"} the codebase${p.args?.path || p.path ? ` · ${p.args?.path ?? p.path}` : ""}`;
    case "repo_read":
      return `${done ? "Read" : "Reading"} ${p.args?.path ?? p.path ?? "a file"} from the codebase`;
    case "view_image":
      return `${done ? "Looked at" : "Looking at"} ${p.path ?? p.args?.path ?? "the image"}`;
    case "check_design":
      if (!done) return `Checking ${p.args?.path ?? p.path ?? "the design"} in a browser`;
      return `Checked ${p.path ?? "the design"} · ${p.count ? `${p.count} finding${p.count > 1 ? "s" : ""}` : "looks good"}`;
    case "save_design_system":
      return done ? `Saved design system “${p.dsName ?? p.args?.name ?? ""}”` : `Saving design system “${p.args?.name ?? ""}”`;
    case "ask_questions":
      return done ? "Asked a few questions" : "Writing a few questions";
    case "run_code":
      if (!done) return "Running code";
      return `Ran code · ${p.exitCode === 0 ? "succeeded" : `exit ${p.exitCode}`}`;
    default:
      return name;
  }
}

/**
 * Turns messages + agent events into chat rows. Each "note" (the agent's
 * one-line narration) opens an activity group that collects the tool calls
 * after it; a file write closes the group with a file chip, like the
 * reference: activity → file → activity → reply.
 */
export function buildThread(messages: StoredMessage[], events: StoredEvent[], running: boolean): Row[] {
  const items = [
    ...messages.map((m) => ({ ts: m.created_at, m, e: null as StoredEvent | null })),
    ...events.map((e) => ({ ts: e.created_at, m: null as StoredMessage | null, e })),
  ].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.m && !b.m ? -1 : 0));

  const rows: Row[] = [];
  let group: Extract<Row, { kind: "activity" }> | null = null;
  const tools = new Map<string, { group: Extract<Row, { kind: "activity" }>; idx: number }>();

  for (const it of items) {
    if (it.m) {
      const m = it.m;
      group = null;
      if (m.role === "user") rows.push({ kind: "user", key: "m" + m.id, text: m.content, meta: m.meta ?? {} });
      else if (m.role === "assistant") {
        const files: { path: string; created: boolean }[] = m.meta?.files ?? [];
        rows.push({
          kind: "reply",
          key: "m" + m.id,
          text: m.content,
          created: files.filter((f) => f.created).length,
          edited: files.filter((f) => !f.created).length,
        });
      }
      continue;
    }
    const e = it.e!;
    const p = e.payload ?? {};
    if (e.type === "thought") {
      group = null;
      rows.push({ kind: "thought", key: "e" + e.id, text: String(p.text ?? ""), ms: Number(p.ms) || 0 });
    } else if (e.type === "note") {
      group = { kind: "activity", key: "e" + e.id, title: String(p.text ?? ""), tools: [], active: false };
      rows.push(group);
    } else if (e.type === "tool-call") {
      if (p.name === "ask_questions") continue;
      if (!group) {
        group = { kind: "activity", key: "e" + e.id, title: "", tools: [], active: false };
        rows.push(group);
      }
      const row: ToolRow = { callId: String(p.callId), name: p.name, label: toolLabel(p.name, p, false), active: true };
      tools.set(row.callId, { group, idx: group.tools.length });
      group.tools.push(row);
    } else if (e.type === "tool-result") {
      const ref = tools.get(String(p.callId));
      if (ref) {
        const t = ref.group.tools[ref.idx];
        ref.group.tools[ref.idx] = {
          ...t,
          active: false,
          label: toolLabel(t.name, { ...p, args: undefined }, true) || t.label,
          error: p.error,
          image: p.image,
          findings: p.findings,
          links: p.results?.map((r: any) => ({ title: r.title ?? host(r.url ?? ""), url: r.url })) ?? (p.source ? [{ title: p.source.title ?? host(p.source.url ?? ""), url: p.source.url }] : undefined),
        };
      }
      if ((p.name === "write_file" || p.name === "append_file" || p.name === "str_replace") && !p.error && p.path) {
        const last = rows[rows.length - 1];
        if (last?.kind === "file" && last.path === p.path) last.version = p.version;
        else rows.push({ kind: "file", key: "f" + e.id, path: p.path, version: p.version });
        group = null;
      }
    } else if (e.type === "phase") {
      group = null;
      rows.push({ kind: "phase", key: "e" + e.id, name: String(p.name ?? "") });
    } else if (e.type === "plan" && p.plan) {
      group = null;
      rows.push({ kind: "plan", key: "e" + e.id, plan: p.plan });
    } else if (e.type === "questions") {
      group = null;
      rows.push({ kind: "questions", key: "e" + e.id, intro: String(p.intro ?? ""), questions: cleanQuestions(p.questions), answered: false });
    } else if (e.type === "error") {
      rows.push({ kind: "error", key: "e" + e.id, text: String(p.message ?? "Something went wrong") });
    } else if (e.type === "say") {
      // Narration from the previous pipeline, kept so older projects still read sensibly.
      rows.push({ kind: "reply", key: "e" + e.id, text: String(p.text ?? ""), created: 0, edited: 0 });
    }
  }

  // A form stays open until it's answered or the agent moves on; a plain follow-up message ("call it Koroba") doesn't close it.
  let movedOn = false;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.kind === "questions") {
      r.answered = movedOn;
      movedOn = true;
    } else if ((r.kind === "user" && r.meta?.answers) || r.kind === "reply" || r.kind === "file") movedOn = true;
  }
  for (const r of rows) {
    if (r.kind !== "activity") continue;
    if (!r.title) r.title = r.tools.map((t) => t.label).slice(-1)[0] ?? "Working";
    r.active = r.tools.some((t) => t.active);
  }
  if (running) {
    const last = rows[rows.length - 1];
    if (last?.kind === "activity") last.active = true;
  }
  return rows;
}
