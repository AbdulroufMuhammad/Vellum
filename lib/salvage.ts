/**
 * Models sometimes answer a step by writing its result into the chat instead of calling the tool: the plan as a JSON code
 * block ("submit_plan ```json {...}```"), or the whole HTML document as a code block. Treated as a finished reply, that
 * ends the request with code in the chat and no file. These helpers recover the intended tool call from such a reply, so the
 * rest of the pipeline sees what it would have seen had the model called the tool properly.
 */

export type SalvagedCall = { name: "submit_plan" | "write_file" | "split_research"; args: Record<string, unknown>; why: string };

/** A balanced {...} starting at `start`, ignoring braces inside strings; null if it never closes. */
function balancedObject(text: string, start: number): string | null {
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** A plan object (title, summary, direction, sections) written into the text, as a fenced block or bare. */
export function planFromText(text: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  for (const m of text.matchAll(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/g)) candidates.push(m[1]);
  candidates.push(text);
  for (const body of candidates) {
    for (let i = body.indexOf("{"); i >= 0 && i < body.length; i = body.indexOf("{", i + 1)) {
      const raw = balancedObject(body, i);
      if (!raw) continue;
      try {
        const obj = JSON.parse(raw);
        // The model may wrap it: { "submit_plan": {...} } or { "plan": {...} } or { "arguments": {...} }.
        for (const o of [obj, obj?.plan, obj?.arguments, obj?.submit_plan, obj?.args]) {
          if (o && typeof o === "object" && Array.isArray(o.sections) && o.sections.length && (o.title || o.summary || o.direction)) return o as Record<string, unknown>;
        }
      } catch {
        // not JSON: keep looking
      }
    }
  }
  return null;
}

/** A complete HTML document written into the text, as a fenced block or bare. Null when it looks partial or too short to be one. */
export function htmlFromText(text: string): string | null {
  const fenced = [...text.matchAll(/```(?:html|HTML|htm)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]).sort((a, b) => b.length - a.length)[0];
  // An unterminated fence (the reply was cut off) still carries the document so far.
  const open = /```(?:html|HTML|htm)?\s*\n([\s\S]*)$/.exec(text)?.[1];
  const bare = /(<!doctype html[\s\S]*|<html[\s\S]*)/i.exec(text)?.[1];
  for (const c of [fenced, open, bare]) {
    if (!c) continue;
    let doc = c.trim();
    const start = doc.search(/<!doctype html|<html[\s>]/i);
    if (start < 0) continue;
    doc = doc.slice(start);
    if (doc.length < 1200 || !/<body[\s>]/i.test(doc)) continue;
    return doc;
  }
  return null;
}

/**
 * What the model should have called, recovered from its text reply. Only when the step really needed a call: planning with no
 * plan yet, or building with nothing written yet. `filePath` is where a recovered document goes.
 */
export function salvageToolCall(text: string, ctx: { phase?: string; hasPlan: boolean; wroteFile: boolean; filePath: string }): SalvagedCall | null {
  if (!text || text.length < 200) return null;
  if (ctx.phase === "split") {
    // The parts listed in the chat: numbered or bulleted lines, each a question or a topic.
    const parts = text
      .split("\n")
      .map((l) => /^\s*(?:\d+[.)]|[-*•])\s+(?:\*\*)?(.{8,400}?)(?:\*\*)?\s*$/.exec(l)?.[1])
      .filter((l): l is string => !!l)
      .map((question) => ({ question }));
    if (parts.length >= 2) return { name: "split_research", args: { parts }, why: "The parts were listed in the chat instead of being submitted; submitting them." };
    return null;
  }
  if (ctx.phase === "plan" && !ctx.hasPlan) {
    const plan = planFromText(text);
    if (plan) return { name: "submit_plan", args: plan, why: "The plan was written into the chat instead of being submitted; submitting it." };
    return null;
  }
  if (!ctx.wroteFile && (ctx.phase === "build" || ctx.phase === undefined)) {
    const doc = htmlFromText(text);
    if (doc) return { name: "write_file", args: { path: ctx.filePath, content: doc }, why: `The page was written into the chat instead of being saved; saving it as "${ctx.filePath}".` };
  }
  return null;
}

/** When no call can be recovered: whether the reply is the kind a step must never end with, and what to tell the model. */
export function missingCallNudge(ctx: { phase?: string; hasPlan: boolean; wroteFile: boolean }): string | null {
  if (ctx.phase === "split")
    return "You answered in text, but this step ends only when you call the split_research tool. Call split_research now with the parts (each a question and a focus), and nothing else.";
  if (ctx.phase === "plan" && !ctx.hasPlan)
    return "You answered in text, but this step ends only when you call the submit_plan tool. Do not write the plan into the chat: call submit_plan now with title, summary, direction, sections (each with name and detail) and files.";
  if (ctx.phase === "build" && !ctx.wroteFile)
    return "You answered in text, but nothing has been saved yet: the file is only created by calling the write_file tool. Do not paste code into the chat. Call write_file now with the path and the first part of the document (the head, styles and first sections), then append_file for the rest.";
  return null;
}

/**
 * The reply shown in the chat once a file has been written: the file is on the canvas, so a copy of its code in the chat is
 * noise (and a model that pastes the page again after saving it would otherwise bury its answer under it). Removes fenced code
 * blocks of any real size and a bare HTML document; when nothing but code was there, says what happened in a sentence.
 */
export function replyWithoutCode(text: string, wroteFile: boolean): string {
  if (!wroteFile || !text) return text;
  let out = text.replace(/```[a-zA-Z]*\s*\n[\s\S]*?(```|$)/g, (block) => (block.length > 300 ? "" : block));
  const bare = out.search(/<!doctype html|<html[\s>]/i);
  if (bare >= 0 && out.length - bare > 600) out = out.slice(0, bare);
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  return out.length >= 12 ? out : "Done. It's on the canvas.";
}
