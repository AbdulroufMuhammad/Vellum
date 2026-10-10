import { chat, type ChatMessage, type ModelKey } from "@/lib/gateway";

/**
 * A fresh writing session. Reasoning models (GLM 5.3 especially) think well but stall when, right after thinking, they have to
 * produce a whole page: re-asked inside the full agent conversation (a long system prompt, the chat, the current file, every
 * tool) they start thinking over from scratch, and a page squeezed into a tool call's JSON string (every quote and newline
 * escaped) is the hardest way to write a long document. Here the same model gets a small, new context holding only what the
 * writing needs (the request, the plan or the thinking notes, the current file for an edit, the output rules) and replies
 * with the page as plain HTML text, which is saved as the file.
 */

const WRITER_RULES = `You write one complete, self-contained HTML document for Vellum, a design tool. The thinking and the design decisions are already done (they're given to you below): don't reconsider them, just write the page they describe, carefully and in full.

Output: reply with the complete HTML document and nothing else. Start with <!doctype html> and end with </html>. No commentary, no explanation and no Markdown code fence around it.

Rules for the file:
- Inline <style> and <script>. External resources only from Google Fonts, cdn.jsdelivr.net, unpkg.com or cdnjs.cloudflare.com. No frameworks that need compiling. Put all JavaScript in ONE <script> (a module if it imports).
- Real, specific content: never lorem ipsum or "Item 1". Invent plausible names, numbers and copy where none were given.
- A restrained palette as CSS custom properties on :root, a deliberate Google Fonts pairing, one accent used with intent, a consistent spacing scale, good contrast (body text at least 4.5:1 against its background).
- Icons are inline SVG line icons, never emoji. Never use an external stock photo URL; use only image URLs given below, or CSS and SVG.
- Responsive: it must look right at the canvas width and on a 390px phone without sideways scrolling.
- Never use em dashes in the copy; use a comma, colon, period or parentheses.
- Keep any data-el attributes that are already in the current file.
- Printable documents (invoices, résumés, reports, letters) are designed as paper: an @page rule with size and margins, <meta name="pages" content="N"> with the intended page count, and a print layout that matches the screen layout and fits that count.
- Optional live controls: <script type="application/json" id="tweaks">[{"name":"accent","label":"Accent","type":"color","value":"#b68235"}]</script>; the canvas sets each as a CSS custom property on :root (var(--accent)).`;

export type WriteDocumentOpts = {
  model: ModelKey;
  /** What the user asked for (the request and the latest message). */
  request: string;
  /** The plan, as text, when there is one. */
  plan?: string | null;
  /** A research report's findings, saved by its researchers with [S#] citations. */
  research?: string | null;
  /** The thinking that led here (the full reasoning, not just its end). */
  notes?: string | null;
  /** For an edit: the file as it is now. */
  currentFile?: { path: string; content: string } | null;
  /** The design system, as described to the agent. */
  designSystem?: string | null;
  /** Extra playbook text the page needs (3D, physics, research report rules). */
  guides?: string | null;
  /** Images or clips already generated for this request, to use instead of inventing URLs. */
  media?: string | null;
  deadline: number;
  signal?: AbortSignal;
  /** The document so far, each time more of it arrives (for the live canvas). */
  onText?: (soFar: string) => void;
  /** Reasoning, if the model thinks before writing. */
  onReasoning?: (t: string) => void;
  /** The start of the document, written by an earlier session that ran out of time: only the rest is written. */
  resumeFrom?: string | null;
};

/** `html` is always a whole document (closed if need be); `written` is exactly what was written, for resuming when `complete` is false. */
export type WriteDocumentResult = { html: string; calls: number; complete: boolean; written: string };

const MAX_NOTES = 12_000;

function clip(s: string, n: number) {
  return s.length > n ? `…${s.slice(-n)}` : s;
}

/** The HTML part of a reply: from the doctype (or <html>) on, without a code fence or trailing commentary. */
export function documentPart(text: string): string | null {
  const start = text.search(/<!doctype html|<html[\s>]/i);
  if (start < 0) return null;
  let doc = text.slice(start);
  const end = doc.search(/<\/html>/i);
  if (end >= 0) doc = doc.slice(0, end + "</html>".length);
  else doc = doc.replace(/\n?```\s*$/, "");
  return doc;
}

/** The last characters of the first part, which the continuation is asked to repeat first so the join point is exact. */
export const anchorOf = (head: string) => head.slice(-60);

/**
 * A continuation joined onto the first part. Guessing an overlap is unsafe (rows of a table repeat, so the end of the first
 * part can match the start of the continuation by coincidence), so the continuation is asked to begin by repeating an exact
 * anchor: if it did, everything up to the anchor's end is dropped; if it didn't, it's appended as it is.
 */
export function joinContinuation(head: string, tail: string, anchor = anchorOf(head)): string {
  let t = tail.replace(/^\s*```[a-zA-Z]*\s*\n/, "").replace(/\n?```\s*$/, "");
  // a continuation that restarted the whole document isn't a continuation: keep the longer of the two documents
  if (/^\s*(<!doctype html|<html[\s>])/i.test(t)) return t.length > head.length ? t : head;
  // only at the very start (whitespace aside): that's where the model was asked to put it
  const lead = t.length - t.trimStart().length;
  if (anchor && t.startsWith(anchor, lead)) t = t.slice(lead + anchor.length);
  const end = t.search(/<\/html>/i);
  if (end >= 0) t = t.slice(0, end + "</html>".length);
  return head + t;
}

const isComplete = (doc: string) => /<\/html>\s*$/i.test(doc);

function closeDocument(doc: string) {
  let out = doc.trimEnd();
  if (!/<\/body>/i.test(out)) out += "\n</body>";
  if (!/<\/html>/i.test(out)) out += "\n</html>";
  return out;
}

function firstMessage(o: WriteDocumentOpts) {
  const parts = [`What the user asked for:\n${o.request.trim()}`];
  if (o.plan) parts.push(`The plan (follow it faithfully):\n${o.plan}`);
  if (o.research?.trim()) parts.push(`The research findings to write it from (use them in full and cite the [S#] IDs exactly as given; never invent one):\n${o.research.trim()}`);
  if (o.notes?.trim()) parts.push(`Your design thinking for this, already done (use these decisions; don't redo them):\n"""\n${clip(o.notes.trim(), MAX_NOTES)}\n"""`);
  if (o.designSystem?.trim()) parts.push(`Design system:\n${o.designSystem.trim()}`);
  if (o.media?.trim()) parts.push(`Already generated for this (use these URLs as they are):\n${o.media.trim()}`);
  if (o.currentFile)
    parts.push(
      `The current "${o.currentFile.path}", which you are changing. Keep everything the request doesn't ask to change (content, data-el attributes, scripts that work) and reply with the whole updated document:\n${o.currentFile.content}`
    );
  parts.push(`Now reply with the complete HTML document${o.currentFile ? ` for "${o.currentFile.path}"` : ""}, starting with <!doctype html>.`);
  return parts.join("\n\n");
}

/** Writes the document in a fresh, small context; continues it (in another fresh call) if a reply stops early. */
export async function writeDocument(o: WriteDocumentOpts): Promise<WriteDocumentResult> {
  const system = o.guides?.trim() ? `${WRITER_RULES}\n\n${o.guides.trim()}` : WRITER_RULES;
  const ask = async (messages: ChatMessage[], prefix: string) => {
    let soFar = "";
    const r = await chat(o.model, {
      messages,
      deadline: o.deadline,
      signal: o.signal,
      thinking: "off",
      onReasoning: o.onReasoning,
      onToken: (t) => {
        soFar += t;
        if (!o.onText) return;
        // first call: the document so far; a continuation: the earlier part with this one joined on
        const doc = prefix ? joinContinuation(prefix, soFar) : documentPart(soFar);
        if (doc) o.onText(doc);
      },
    }).catch((e) => {
      // Out of time partway through the document: what's written is kept (and resumed later), not thrown away.
      if (e instanceof Error && /deadline/.test(e.message) && (prefix || documentPart(soFar))) return { content: soFar, reasoning: "", toolCalls: [], finish: "deadline", usage: null };
      throw e;
    });
    return r;
  };

  let calls = 0;
  let doc: string | null = o.resumeFrom?.trim() ? o.resumeFrom : null;
  const first: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: firstMessage(o) },
  ];
  if (!doc) {
    const r = await ask(first, "");
    calls++;
    doc = documentPart(r.content);
    if (!doc && r.finish !== "deadline") {
      // It answered with prose (or only reasoned): one plain reminder of the only thing this session is for.
      const again = await ask([...first, { role: "assistant", content: r.content.slice(0, 2000) || "…" }, { role: "user", content: "Reply with the complete HTML document only, starting with <!doctype html>. No other text." }], "");
      calls++;
      doc = documentPart(again.content);
    }
  }
  if (!doc) throw new Error("the writing session didn't return an HTML document");

  // A reply that stopped before </html> (the output limit, usually) is continued from where it stopped, in fresh calls.
  for (let i = 0; i < 3 && !isComplete(doc) && o.deadline - Date.now() > 20_000; i++) {
    const head = doc;
    const cont = await ask(
      [
        { role: "system", content: system },
        {
          role: "user",
          content: `You were writing this HTML document and the reply stopped before the end. Here is how it ends:\n"""\n${head.slice(-1500)}\n"""\nContinue it through the closing </html>. Begin your reply by repeating exactly these last characters, then carry on straight after them:\n${anchorOf(head)}\nNo commentary. The plan it follows:\n${o.plan ?? clip(o.notes ?? o.request, 4000)}`,
        },
      ],
      head
    );
    calls++;
    doc = joinContinuation(head, cont.content);
    o.onText?.(doc);
  }
  const complete = isComplete(doc);
  return { html: complete ? doc : closeDocument(doc), calls, complete, written: doc };
}
