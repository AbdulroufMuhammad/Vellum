import type { Question } from "@/lib/questions";

/**
 * How deep a research report goes. The user picks it in the scoping form the agent always asks first; it sets
 * how many parts the orchestrator splits the question into (each researched on its own, one after another) and
 * the page count the printed report is checked against. It never caps how much is read: each researcher reads
 * until its part is answered.
 */
export type ResearchDepth = { key: string; label: string; pages: [number, number]; parts: [number, number] };

export const RESEARCH_DEPTHS: ResearchDepth[] = [
  { key: "quick", label: "Quick overview (1–2 pages)", pages: [1, 2], parts: [2, 3] },
  { key: "standard", label: "Standard report (3–5 pages)", pages: [3, 5], parts: [3, 5] },
  { key: "deep", label: "Deep dive (6–10 pages)", pages: [6, 10], parts: [5, 8] },
  { key: "book", label: "Full book (20–40 pages, every topic, no skipping)", pages: [20, 40], parts: [8, 15] },
];

export const DEFAULT_DEPTH = RESEARCH_DEPTHS[1];

/** The question every research scoping form includes; `preferred` (read from the request) is preselected. */
export function depthQuestion(preferred: ResearchDepth | null = null): Question {
  return {
    id: "depth",
    question: "How deep should the research go?",
    type: "single",
    options: RESEARCH_DEPTHS.map((d) => d.label),
    help: "This sets how many parts the question is split into and how many pages the report runs. There's no limit on how much is read.",
    other: true,
    default: (preferred ?? DEFAULT_DEPTH).label,
  };
}

/** Research forms always ask about depth, with the standard question (the model's own wording can't be read back reliably). */
export function withDepthQuestion(questions: Question[], preferred: ResearchDepth | null = null): Question[] {
  const rest = questions.filter((q) => !/\b(deep|depth|detail\w*|thorough|how (long|far)|length|pages?)\b/i.test(q.question));
  return [depthQuestion(preferred), ...rest].slice(0, 8);
}

/**
 * The template's own steps are pasted into the request ("Ask me how deep to go (a quick overview, a standard
 * report or a deep dive)…"): they describe the process, not the user's choice, so they're never read as one.
 */
function withoutTemplateSteps(text: string, steps: string[]) {
  let out = text;
  for (const s of steps) out = out.split(s).join(" ");
  return out.replace(/how deep to go\s*\([^)]*\)/gi, " ");
}

/** A depth named in free text, used only to preselect the form's answer (it never skips the form). */
export function depthHint(text: string, templateSteps: string[] = []): ResearchDepth | null {
  const t = withoutTemplateSteps(text, templateSteps);
  const pages = /\b(\d{1,2})\s*(?:(?:-|–|to)\s*(\d{1,2})\s*)?pages?\b/i.exec(t);
  if (pages) {
    const hi = Math.max(Number(pages[1]), Number(pages[2] ?? pages[1]));
    return RESEARCH_DEPTHS.find((d) => hi <= d.pages[1]) ?? RESEARCH_DEPTHS[3];
  }
  if (/\b(book|textbook|handbook|extensive|exhaustive|no skipping|full guide|complete guide|everything about)\b/i.test(t)) return RESEARCH_DEPTHS[3];
  if (/\b(in[- ]depth|comprehensive|deep[- ]dive|thorough)\b/i.test(t)) return RESEARCH_DEPTHS[2];
  if (/\b(quick|brief|short)\b/i.test(t)) return RESEARCH_DEPTHS[0];
  return null;
}

/**
 * The depth the user chose in the scoping form (newest answers first): one of its options, or what they typed
 * under "Other" ("about 8 pages", "a whole book"). Null when no form has been answered.
 */
export function depthFromAnswers(answerSets: Record<string, string>[]): ResearchDepth | null {
  for (const answers of answerSets) {
    const values = Object.values(answers ?? {}).map(String);
    // By name too, so forms answered before the labels changed still count.
    for (const v of values) for (const d of RESEARCH_DEPTHS) if (v.includes(d.label) || v.trim().startsWith(d.label.split(" (")[0])) return d;
    const typed = answers?.depth;
    if (typed) {
      const hint = depthHint(typed);
      if (hint) return hint;
    }
  }
  return null;
}
