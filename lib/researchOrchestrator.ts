import { chat, MODELS, type ChatMessage, type ChatResult, type ModelKey, type ToolSchema } from "@/lib/gateway";
import { WEB_TOOL_SCHEMAS, type SourceRegistry } from "@/lib/tools/search";
import { PRIMARY_SOURCES } from "@/lib/research-skill";
import type { ResearchDepth } from "@/lib/research";
import type { AgentEvent } from "@/lib/events";

/**
 * Research as an orchestrator and researchers. After the scoping form, the orchestrator (the design agent in its "split"
 * step) breaks the request into parts with split_research. Each part then gets its own researcher: a fresh conversation of
 * the same model that searches and reads, with no limit, until that part is answered, saving cited notes as it goes. The
 * researchers run strictly one after another, and each makes one tool call per reply. Their notes are what the report is
 * planned and written from.
 *
 * Every call is saved to the project's settings as it happens, so the 300-second invocation limit only ever pauses a
 * researcher: the next invocation rebuilds its conversation from what it already ran, read and noted, and carries on.
 */

export type SubQuestion = {
  id: string;
  question: string;
  /** What this part has to cover, from the orchestrator. */
  focus: string;
  status: "pending" | "done";
  /** The researcher's own two-or-three sentence answer (finish_part). */
  summary: string;
  /** Cited notes ([S#]), appended by add_findings. */
  findings: string;
  queries: string[];
  /** Source IDs this researcher has read in full. */
  read: string[];
  /** Search/fetch calls in a row that turned up nothing new (the stall guard). */
  idle: number;
};

export type ResearchState = { questions: SubQuestion[]; current: number };

export const SPLIT_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "split_research",
    description:
      "Break the research request into the parts that will each be researched on their own, in order, by a dedicated researcher. Together the parts must cover everything the user asked for, without overlap. Ends this step.",
    parameters: {
      type: "object",
      properties: {
        parts: {
          type: "array",
          description: "The parts, in the order the report will present them",
          items: {
            type: "object",
            properties: {
              question: { type: "string", description: "The sub-question this part answers" },
              focus: { type: "string", description: "What the researcher must cover for it: subtopics, numbers, examples, comparisons" },
            },
            required: ["question"],
          },
        },
      },
      required: ["parts"],
    },
  },
};

const ADD_FINDINGS: ToolSchema = {
  type: "function",
  function: {
    name: "add_findings",
    description:
      "Save notes from what you just read: facts, numbers, definitions, examples and explanations, each sentence ending with its source ID like [S3]. They're kept for the report even if this session is interrupted. Call it after every source worth reading.",
    parameters: { type: "object", properties: { notes: { type: "string" } }, required: ["notes"] },
  },
};

const FINISH: ToolSchema = {
  type: "function",
  function: {
    name: "finish_part",
    description: "This part is fully answered and your findings are saved. Ends your session; the next part's researcher starts.",
    parameters: { type: "object", properties: { summary: { type: "string", description: "Two or three sentences: the answer to this part" } }, required: ["summary"] },
  },
};

const RESEARCHER_TOOLS = [...WEB_TOOL_SCHEMAS, ADD_FINDINGS, FINISH] as ToolSchema[];

const THINK_CUT_MS = Number(process.env.RESEARCHER_THINK_MS ?? 45_000);
class ResearcherThinkCut extends Error {
  name = "ResearcherThinkCut";
}

/** Tool calls in a row with nothing new before the researcher is told to finish, and then closed. */
const STALL_LIMIT = 15;
/** Everything the researchers noted, as handed to the planner and writer; enough for a whole book, and still inside the model's context. */
const MAX_FINDINGS_CHARS = 200_000;
/** Older fetched pages are cut to this once read; their content lives on in the notes. */
const OLD_RESULT_CHARS = 600;

export const ONE_AT_A_TIME = "Make exactly one tool call per reply, then wait for its result before deciding the next. Never put several tool calls in one reply.";

export function cleanSplit(args: any, depth: ResearchDepth | null): ResearchState {
  const str = (v: unknown, n: number) => String(v ?? "").replace(/\s*—\s*/g, ", ").trim().slice(0, n);
  const max = Math.max(depth?.parts[1] ?? 8, 3) + 5;
  const parts = (Array.isArray(args?.parts) ? args.parts : [])
    .map((p: any) => (typeof p === "string" ? { question: p } : p))
    .map((p: any) => ({ question: str(p?.question, 400), focus: str(p?.focus, 1200) }))
    .filter((p: { question: string }) => p.question)
    .slice(0, max);
  if (!parts.length) throw new Error("give at least one part, each with a question");
  return {
    current: 0,
    questions: parts.map((p: { question: string; focus: string }, i: number) => ({ id: `P${i + 1}`, ...p, status: "pending", summary: "", findings: "", queries: [], read: [], idle: 0 })),
  };
}

/** Generic chapters, for padding a split that came back too thin. */
const SKELETON = [
  "The big picture: what it is, why it exists and the words you need",
  "How it works, step by step, from the very beginning",
  "Worked examples built up in small steps",
  "Trade-offs, common mistakes and how to avoid them",
  "The building blocks, one at a time, each with a picture in words",
  "How the pieces talk to each other and what happens when one breaks",
  "Doing it at larger scale: what changes when there is more of everything",
  "Real-world case studies, explained step by step",
  "Putting it together: a complete walk-through and what to learn next",
];

/**
 * A split built from the user's own answers, for when the model gave no usable one: each focus area they ticked becomes
 * a part, padded with generic chapters up to the depth's minimum. Never "the whole request as one part".
 */
export function fallbackSplit(request: string, focusAreas: string[], depth: ResearchDepth | null): ResearchState {
  const topic = request.replace(/\s+/g, " ").trim().slice(0, 160);
  const parts = focusAreas.map((f) => ({ question: `${f} (for: ${topic})`, focus: "" }));
  for (const g of SKELETON) if (parts.length < (depth?.parts[0] ?? 3)) parts.push({ question: `${g} (for: ${topic})`, focus: "" });
  return cleanSplit({ parts }, depth);
}

type Parts = { question: string; focus?: string }[];

/** Numbered or bulleted lines of a plain-text answer, as parts. */
function partsFromText(text: string): Parts {
  return text
    .split("\n")
    .map((l) => /^\s*(?:\d+[.)]|[-*•])\s+(?:\*\*)?(.{8,400}?)(?:\*\*)?\s*$/.exec(l)?.[1])
    .filter((l): l is string => !!l)
    .map((question) => ({ question }));
}

/**
 * The orchestrator's split, as one small focused call instead of a turn of the full agent loop: a fresh session of the
 * model with only the request, the scoping answers and the instructions, thinking off. In the loop, a reasoning model
 * spent the whole invocation deliberating over a task that is a single short tool call.
 */
export async function runSplit(o: {
  model: ModelKey;
  brief: string;
  depth: ResearchDepth | null;
  focusAreas: string[];
  deadline: number;
  signal: AbortSignal;
  emit: Emit;
}): Promise<ResearchState> {
  const system = `You are the orchestrator of a research team. Your only job is to break a research request into parts that dedicated researchers will each cover. ${ONE_AT_A_TIME}${splitInstructions(o.depth)}`;
  const user = `${o.brief}\n\nCall split_research now with the parts.`;
  const ask = async (messages: ChatMessage[], tools: ToolSchema[] | undefined) => {
    // Bounded on its own, well inside the invocation: if the model dithers, the fallbacks below take over.
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort(o.signal.reason);
    o.signal.addEventListener("abort", onAbort);
    const timer = setTimeout(() => ctrl.abort(new Error("split timed out")), Number(process.env.SPLIT_TIMEOUT_MS ?? 60_000));
    try {
      return await chat(o.model, { messages, tools, deadline: o.deadline, signal: ctrl.signal, thinking: "off", maxTokens: 3000 });
    } finally {
      clearTimeout(timer);
      o.signal.removeEventListener("abort", onAbort);
    }
  };
  const base: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  try {
    const r = await ask(base, [SPLIT_SCHEMA]);
    const tc = r.toolCalls.find((t) => t.name === "split_research");
    if (tc) return cleanSplit(JSON.parse(tc.args || "{}"), o.depth);
    const listed = partsFromText(r.content);
    if (listed.length >= 2) return cleanSplit({ parts: listed }, o.depth);
    // One retry in plain text.
    const again = await ask([...base, { role: "assistant", content: r.content.slice(0, 1500) || "…" }, { role: "user", content: "Reply with only the numbered list of parts, one per line, each a specific question." }], undefined);
    const text = partsFromText(again.content);
    if (text.length >= 2) return cleanSplit({ parts: text }, o.depth);
  } catch (e) {
    if (o.signal.aborted) throw e;
  }
  await o.emit({ type: "note", payload: { text: "The model gave no usable split; using your focus areas as the parts." } });
  return fallbackSplit(o.brief.split("\n")[0] ?? "", o.focusAreas, o.depth);
}

/** The split step's instructions to the orchestrator. */
export function splitInstructions(depth: ResearchDepth | null) {
  const [lo, hi] = depth?.parts ?? [3, 5];
  return `\n\n## This step: splitting the research\nYou are the orchestrator. Don't search or write anything yet. Break this request into ${lo} to ${hi} parts with split_research${
    depth?.key === "book" ? " (this is a full book: one part per chapter, ordered so each builds on the last, covering every topic the subject needs, with nothing skipped)" : ""
  }. Each part is researched on its own by a dedicated researcher, one after another, with no limit on how much it reads, so make each part specific and give it a focus listing exactly what it must cover. Use the scoping answers above. Call split_research now, alone.`;
}

/** The researchers' notes, grouped by part, for the planner and writer. */
export function findingsText(state: ResearchState): string {
  const per = Math.floor(MAX_FINDINGS_CHARS / Math.max(1, state.questions.length));
  return state.questions
    .map((q, i) => {
      const notes = q.findings.trim() || "(no findings saved)";
      return `### Part ${i + 1}: ${q.question}\n${notes.length > per ? `${notes.slice(0, per)}\n…` : notes}`;
    })
    .join("\n\n");
}

/** A short outline of the research for the planner: each part's question, its researcher's summary and the start of its notes. */
export function outlineText(state: ResearchState): string {
  return state.questions
    .map((q, i) => `### Part ${i + 1}: ${q.question}\n${q.summary ? `${q.summary}\n` : ""}${q.findings.trim().slice(0, 600)}${q.findings.length > 600 ? "…" : ""}\n(${q.read.length} sources read)`)
    .join("\n\n");
}

type Emit = (e: AgentEvent) => Promise<unknown>;

export type ResearchRunOpts = {
  state: ResearchState;
  /** Persists the state (it lives on the project's settings). */
  save: () => Promise<void>;
  model: () => ModelKey;
  sources: SourceRegistry;
  emit: Emit;
  /** Absolute ms by which this invocation must stop calling the model. */
  deadline: number;
  signal: AbortSignal;
  /** The request and the scoping answers. */
  brief: string;
  depth: ResearchDepth | null;
  /** False once the project was stopped or taken over. */
  stillOwner: () => Promise<boolean>;
};

/** "done": every part is researched. "paused": out of time, the next invocation carries on. "stopped": the user stopped it. */
export type ResearchOutcome = { outcome: "done" | "paused" | "stopped"; progressed: boolean };

function researcherSystem(o: ResearchRunOpts, q: SubQuestion, index: number) {
  const others = o.state.questions.map((x, i) => `${i + 1}. ${x.question}${i === index ? "  ← yours" : ""}`).join("\n");
  return `You are researcher ${index + 1} of ${o.state.questions.length} in a research team. An orchestrator split the user's request into parts; you research only yours, thoroughly, and save what you find. Another model writes the report from the notes of every researcher, so your notes are the only thing that reaches it.

## The request
${o.brief}
${o.depth ? `Depth chosen: ${o.depth.label}.` : ""}

## All parts (the others are covered by other researchers; don't research them)
${others}

## Your part
${q.question}${q.focus ? `\nCover: ${q.focus}` : ""}

## How you work
- ${ONE_AT_A_TIME}
- There is no limit on how much you search and read. Run targeted web_search queries, web_fetch every source that looks substantial, and keep going until your part is fully covered${o.depth?.key === "book" ? " at the level of a book chapter that teaches it from zero, step by step, with no step skipped: definitions, how it works, worked examples, numbers, trade-offs and common mistakes" : ""}. Stop when more reading stops adding anything new.
- After reading each useful source, call add_findings with detailed notes from it: the facts, numbers, definitions, examples and explanations the writer will need, every sentence ending with its source ID like [S3]. Write notes the writer can use without the source in front of them. Never cite an ID you weren't given, never write URLs.
- When your part is covered and your notes are saved, call finish_part.
- ${PRIMARY_SOURCES}`;
}

function researcherOpening(q: SubQuestion, sources: SourceRegistry) {
  const lines = [`Research your part now: ${q.question}`];
  if (q.queries.length) lines.push(`You already searched for:\n${q.queries.map((x) => `- ${x}`).join("\n")}`);
  if (q.read.length) lines.push(`You already read: ${q.read.map((id) => `${id} (${sources.sources.get(id)?.title ?? "untitled"})`).join(", ")}`);
  if (q.findings) lines.push(`Your notes so far (saved):\n${q.findings.slice(-6000)}`);
  if (q.queries.length || q.read.length) lines.push("You were paused by a time limit. Carry on from here without repeating what you already did.");
  return lines.join("\n\n");
}

/** Keeps a long researcher conversation small: pages read a while ago are cut down (what mattered is in the notes). */
function compact(convo: ChatMessage[]) {
  const tools = convo.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  for (const i of tools.slice(0, -2)) {
    const c = convo[i].content;
    if (typeof c === "string" && c.length > OLD_RESULT_CHARS) convo[i] = { ...convo[i], content: `${c.slice(0, OLD_RESULT_CHARS)}… (cut; your notes hold what mattered)` };
  }
}

/** Runs the researchers, one after another, from the current part on, until all are done or the time runs out. */
export async function runResearchers(o: ResearchRunOpts): Promise<ResearchOutcome> {
  const { state, sources, emit } = o;
  let progressed = false;
  const total = state.questions.length;

  while (state.current < total) {
    const index = state.current;
    const q = state.questions[index];
    await emit({ type: "note", payload: { text: `Researcher ${index + 1} of ${total}: ${q.question}` } });
    const convo: ChatMessage[] = [
      { role: "system", content: researcherSystem(o, q, index) },
      { role: "user", content: researcherOpening(q, sources) },
    ];
    let nudges = 0;
    let stalls = 0;
    let finished = false;

    for (let step = 0; !finished; step++) {
      if (o.signal.aborted || !(await o.stillOwner())) return { outcome: "stopped", progressed };
      if (o.deadline - Date.now() < 15_000) return { outcome: "paused", progressed };
      compact(convo);
      let r: ChatResult;
      // A reply that only reasons (no text, no tool call) for this long is cut and asked again: a researcher's next move
      // is one search or fetch, and a model that ignores "thinking off" can otherwise deliberate through the whole invocation.
      const stepCtrl = new AbortController();
      const onAbort = () => stepCtrl.abort(o.signal.reason);
      o.signal.addEventListener("abort", onAbort);
      let acted = false;
      const started = Date.now();
      const thinkTimer = setInterval(() => {
        if (!acted && Date.now() - started > THINK_CUT_MS) stepCtrl.abort(new ResearcherThinkCut());
      }, 1000);
      try {
        r = await chat(o.model(), {
          messages: convo,
          tools: RESEARCHER_TOOLS,
          deadline: o.deadline,
          signal: stepCtrl.signal,
          thinking: "off",
          onToken: () => (acted = true),
          onToolDelta: () => (acted = true),
        });
      } catch (e) {
        if (o.signal.aborted) return { outcome: "stopped", progressed };
        if (e instanceof ResearcherThinkCut || (e as any)?.name === "ResearcherThinkCut") {
          if (stalls++ >= 3) break;
          await emit({ type: "note", payload: { text: `Researcher ${index + 1} was thinking too long; asking again.` } });
          convo.push({ role: "user", content: "Stop thinking. Make your next tool call now (web_search, web_fetch, add_findings or finish_part), with no more than a sentence of reasoning." });
          continue;
        }
        const msg = e instanceof Error ? e.message : String(e);
        if ((e as any)?.name === "TimeoutError" && o.deadline - Date.now() < 30_000) return { outcome: "paused", progressed };
        // An endpoint that went quiet is asked again a couple of times; the notes are saved, so nothing is lost either way.
        if (/stopped responding|gateway 5\d\d|ECONNRESET|fetch failed/i.test(msg) && stalls < 3) {
          stalls++;
          await emit({ type: "note", payload: { text: `${MODELS[o.model()].label} stopped responding; asking researcher ${index + 1} again.` } });
          continue;
        }
        throw e;
      } finally {
        clearInterval(thinkTimer);
        o.signal.removeEventListener("abort", onAbort);
      }

      if (r.reasoning.trim()) await emit({ type: "thought", payload: { text: r.reasoning.trim().slice(-12000), ms: 0 } });
      if (!r.toolCalls.length) {
        // It answered in prose: that's its notes, if it wrote any; then it's told the session only ends with finish_part.
        const text = r.content.trim();
        if (text.length > 200 && /\[S\d+/.test(text)) {
          q.findings += `${q.findings ? "\n\n" : ""}${text}`;
          await o.save();
          progressed = true;
        }
        if (nudges++ >= 2) finished = true;
        else {
          convo.push({ role: "assistant", content: text.slice(0, 4000) || "…" });
          convo.push({ role: "user", content: "Use the tools: web_search / web_fetch to keep researching, add_findings to save notes, finish_part when your part is covered. One tool call per reply." });
        }
        continue;
      }

      // One action at a time: only the first call runs; any others are answered without running.
      const [tc, ...extra] = r.toolCalls;
      const ids = r.toolCalls.map((t, i) => t.id || `r${index}_${step}_${i}`);
      convo.push({
        role: "assistant",
        content: r.content || null,
        tool_calls: r.toolCalls.map((t, i) => ({ id: ids[i], type: "function", function: { name: t.name, arguments: validJson(t.args) } })),
      });
      const callId = `research-${index}-${step}`;
      let result: unknown;
      let fresh = false;
      try {
        const args = JSON.parse(tc.args || "{}");
        switch (tc.name) {
          case "web_search": {
            const known = new Set(sources.sources.keys());
            await emit({ type: "tool-call", payload: { callId, name: "web_search", args: { query: args.query } } });
            const hits = await sources.search(args);
            q.queries.push(String(args.query ?? ""));
            fresh = hits.some((h) => !known.has(h.id));
            result = hits;
            await emit({ type: "tool-result", payload: { callId, name: "web_search", query: args.query, results: hits.map((h) => ({ id: h.id, title: h.title, url: sources.sources.get(h.id)?.url })) } });
            break;
          }
          case "web_fetch": {
            await emit({ type: "tool-call", payload: { callId, name: "web_fetch", args } });
            const f = await sources.fetch(args);
            fresh = !q.read.includes(f.id);
            if (fresh) q.read.push(f.id);
            result = f;
            await emit({ type: "tool-result", payload: { callId, name: "web_fetch", source: { id: f.id, title: f.title, url: sources.sources.get(f.id)?.url } } });
            break;
          }
          case "add_findings": {
            const notes = String(args.notes ?? "").trim();
            if (!notes) throw new Error("notes are empty");
            q.findings += `${q.findings ? "\n\n" : ""}${notes}`;
            fresh = true;
            result = { ok: true, saved_chars: q.findings.length };
            break;
          }
          case "finish_part": {
            if (!q.findings.trim() && !q.read.length && nudges++ < 2) throw new Error("you haven't researched or saved anything yet: search, read and add_findings first");
            q.summary = String(args.summary ?? "").trim().slice(0, 800);
            finished = true;
            result = { ok: true };
            break;
          }
          default:
            throw new Error(`unknown tool: ${tc.name}; use web_search, web_fetch, add_findings or finish_part`);
        }
      } catch (e) {
        result = { error: e instanceof Error ? e.message : String(e) };
      }
      convo.push({ role: "tool", tool_call_id: ids[0], content: JSON.stringify(result) });
      extra.forEach((t, i) =>
        convo.push({
          role: "tool",
          tool_call_id: ids[i + 1],
          content: JSON.stringify({ error: "Not run: one action at a time. Make this call in your next reply if you still need it." }),
        })
      );

      // The stall guard: the only thing that ends a researcher besides finish_part.
      if (fresh) {
        q.idle = 0;
        progressed = true;
      } else if (tc.name === "web_search" || tc.name === "web_fetch") q.idle++;
      if (q.idle === STALL_LIMIT) convo.push({ role: "user", content: "Your last searches and reads found nothing new. Save any last notes with add_findings, then call finish_part." });
      if (q.idle >= STALL_LIMIT + 3) finished = true;
      await o.save();
    }

    q.status = "done";
    state.current = index + 1;
    progressed = true;
    await o.save();
    await emit({ type: "note", payload: { text: `Researched ${index + 1} of ${total}: ${q.question} (${q.read.length} sources read).` } });
  }
  return { outcome: "done", progressed };
}

function validJson(args: string) {
  try {
    JSON.parse(args || "{}");
    return args || "{}";
  } catch {
    return "{}";
  }
}
