import { chat, type ChatMessage, type ModelKey } from "@/lib/gateway";
import type { ResearchState } from "@/lib/researchOrchestrator";

/**
 * Writing a book (20 to 40 printed pages) one chapter at a time. A single writer call can't hold it: the document is
 * far past one reply's output limit, and a model asked for all of it at once stalls or truncates. So the head (styles,
 * title page, table of contents) is one small call, and each chapter is its own call whose only context is that
 * chapter's own research notes, the plan, the styles to reuse and the end of the chapter before. The pieces are joined
 * into one document; progress is kept in settings.book after every chapter, so a time-limit pause resumes at the next.
 */

export type BookProgress = {
  path: string;
  /** The document so far (head, then each finished chapter). */
  html: string;
  /** Chapters finished. */
  done: number;
};

const FRAGMENT_RULES = `You write part of one self-contained HTML book for Vellum, a design tool. The plan, the styles and the research are given to you: don't reconsider them, just write your part, carefully and in full.

Output: reply with the HTML of your part and nothing else. No commentary, no Markdown code fence, no <html>, <head> or <body> tags unless your part is the head.

The reader is a complete beginner (a donkey being taught): explain every term from zero the first time it appears, use one everyday analogy per idea, go step by step, never skip a step, and never assume the reader already knows something that wasn't taught earlier in the book.
- Every factual sentence ends with its source ID in brackets like [S3] or [S3, S5], using only the IDs that appear in the research notes you are given. Never write URLs. A numbered sources list is added automatically.
- Tables and charts only where there are real numbers from the notes. Diagrams are small inline SVG with a caption, only when they teach something.
- Never use em dashes in the copy; use a comma, colon, period or parentheses.
- No external images. Icons are inline SVG.`;

async function ask(model: ModelKey, system: string, user: string, o: { deadline: number; signal?: AbortSignal; onText?: (soFar: string) => void }) {
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  let soFar = "";
  const r = await chat(model, {
    messages,
    deadline: o.deadline,
    signal: o.signal,
    thinking: "off",
    onToken: (t) => {
      soFar += t;
      o.onText?.(soFar);
    },
  });
  return clean(r.content || soFar);
}

/** The HTML of a reply without a code fence or chatter around it. */
export function clean(text: string): string {
  let out = text.trim().replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  const first = out.search(/<[a-zA-Z!]/);
  if (first > 0) out = out.slice(first);
  return out;
}

/** The styles inside a head, for chapters to reuse (class names and variables), kept short. */
function stylesOf(html: string) {
  return (html.match(/<style[^>]*>([\s\S]*?)<\/style>/i)?.[1] ?? "").trim().slice(0, 7000);
}

/** One title per chapter: the plan's section names when it has one per part, else the researchers' questions. */
export function chapterTitles(research: ResearchState, planSections: string[]) {
  const sameCount = planSections.length === research.questions.length;
  return research.questions.map((q, i) => (sameCount && planSections[i]) || q.question);
}

export type BookOpts = {
  model: ModelKey;
  request: string;
  plan: string;
  direction: string;
  title: string;
  /** The plan's section names, in order. */
  sections: string[];
  research: ResearchState;
  pages: [number, number];
  progress: BookProgress | null;
  path: string;
  deadline: number;
  signal?: AbortSignal;
  /** Called after the head and after every chapter, with the document so far; the caller persists it. */
  onProgress: (p: BookProgress) => Promise<void>;
  onNote: (text: string) => Promise<void>;
  onDraft?: (html: string) => void;
};

/** Writes (or resumes) the book. Returns the finished document, or null when it ran out of time (progress is saved). */
export async function writeBook(o: BookOpts): Promise<string | null> {
  const n = o.research.questions.length;
  const titles = chapterTitles(o.research, o.sections);
  let progress = o.progress ?? { path: o.path, html: "", done: 0 };
  const margin = 20_000;

  if (!progress.html) {
    await o.onNote("Writing the book's cover, contents and styles.");
    const head = await ask(
      o.model,
      FRAGMENT_RULES,
      `${o.request}\n\nThe plan:\n${o.plan}\n\nWrite the START of the document: <!doctype html>, <html>, a <head> (charset, viewport, <title>${o.title}</title>, <meta name="pages" content="${o.pages[0]}-${o.pages[1]}">, Google Fonts links if the plan names fonts, and ONE <style> block holding everything the whole book needs: :root custom properties for the plan's palette, an @page rule for US Letter, typography, and classes for chapters (<section class="chapter">, headings, callouts, tables, figures, captions, analogy boxes, definitions) with break-before: page on .chapter and break-inside: avoid on callouts and figures), then <body>, a full title page, and a table of contents listing exactly these ${n} chapters in order (link each to its chapter id ch1 to ch${n}):\n${titles.map((t, i) => `${i + 1}. ${t}`).join("\n")}\n\nEnd your reply right after the table of contents. Do not write any chapter and do not close <body> or <html>.`,
      { deadline: o.deadline - margin, signal: o.signal, onText: (h) => o.onDraft?.(h) }
    );
    if (!/<style[\s>]/i.test(head)) throw new Error("the book's cover and styles weren't produced");
    progress = { ...progress, html: head, done: 0 };
    await o.onProgress(progress);
  }

  const styles = stylesOf(progress.html);
  while (progress.done < n) {
    if (o.deadline - Date.now() < 75_000) return null;
    if (o.signal?.aborted) return null;
    const i = progress.done;
    const q = o.research.questions[i];
    await o.onNote(`Writing chapter ${i + 1} of ${n}: ${titles[i]}`);
    const tail = progress.html.slice(-900);
    const notes = (q.findings.trim() || "(no findings were saved for this chapter: write it from the plan and general knowledge, and mark any claim you cannot source as unsourced)").slice(0, 60_000);
    const chapter = await ask(
      o.model,
      FRAGMENT_RULES,
      `${o.request}\n\nThe plan for the whole book:\n${o.plan}\n\nThe book's styles (reuse these classes and variables, never add a <style> block):\n${styles}\n\nThe end of the book so far (for continuity, do not repeat it):\n${tail}\n\nWrite chapter ${i + 1} of ${n}: ${titles[i]}.\nIts research question: ${q.question}\n${q.summary ? `The researcher's summary: ${q.summary}\n` : ""}\nAim for about ${Math.max(1, Math.round((o.pages[0] + o.pages[1]) / 2 / n))} printed pages. Reply with exactly one <section class="chapter" id="ch${i + 1}"> element containing an <h2> with the chapter number and title, then the chapter, teaching it from zero in small steps with an everyday analogy for each idea, a worked example, and a short "check yourself" recap at the end. Use these research notes (cite their [S#] IDs):\n"""\n${notes}\n"""`,
      { deadline: o.deadline - margin, signal: o.signal, onText: (c) => o.onDraft?.(progress.html + "\n" + c) }
    );
    if (!/<section[\s>]/i.test(chapter)) throw new Error(`chapter ${i + 1} wasn't produced as HTML`);
    progress = { ...progress, html: `${progress.html}\n${chapter}`, done: i + 1 };
    await o.onProgress(progress);
  }
  return `${progress.html}\n</body>\n</html>`;
}
