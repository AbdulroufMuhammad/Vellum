import type { SupabaseClient } from "@supabase/supabase-js";
import { chat, modelKeyFor, MODELS, type ChatMessage, type ModelKey, type ToolSchema } from "@/lib/gateway";
import { makeEmitter, type AgentEvent, type Emit } from "@/lib/events";
import { FILE_TOOL_SCHEMAS, makeFileTools, cleanPath } from "@/lib/tools/files";
import { SourceRegistry, WEB_TOOL_SCHEMAS } from "@/lib/tools/tavily";
import { makeRepoTools, REPO_TOOL_SCHEMAS } from "@/lib/tools/github";
import { finalizeArtifact, joinModuleScripts, removeEmDashes, unfinishedDocument } from "@/lib/finalize";
import { checkDesign, type CheckResult } from "@/lib/tools/visualCheck";
import { getTemplate } from "@/lib/templates";
import { extractDesignSystem } from "@/lib/extractDesignSystem";
import { ASK_PARAMETERS, cleanQuestions } from "@/lib/questions";
import { DEFAULT_DEPTH, depthFrom, withDepthQuestion } from "@/lib/research";
import { planPreviewHtml, planningPlaceholderHtml } from "@/lib/planPreview";
import { is3DRequest, threeDGuide } from "@/lib/threeD";
import { describeForAgent, fromRow, type DesignSystem } from "@/lib/designSystems";
import { describeImage } from "@/lib/tools/vision";
import { listFiles, readFile } from "@/lib/projectData";

// One invocation must finish inside the route's maxDuration (300s). Past
// this budget the turn pauses and the client resumes it in a fresh
// invocation — see the "continue" event.
const TURN_BUDGET_MS = Number(process.env.TURN_BUDGET_MS ?? 270_000);
const STOP_MARGIN_MS = 20_000;
const MAX_STEPS = 30;
// Well inside STALE_RUN_MS (lib/projectData.ts), after which a silent run counts as dead.
const HEARTBEAT_MS = 10_000;
// A step that has only been thinking this long (nothing written, no tool call) is stopped and told to act on its plan.
// Reasoning models otherwise deliberate for the whole turn: GLM spent 270s planning a business card.
const THINK_LIMIT_MS = Number(process.env.THINK_LIMIT_MS ?? 45_000);
const MAX_THINK_CUTS = 2;
const BUILD_MODEL: ModelKey = "deepseek";

class ThinkLimit extends Error {
  name = "ThinkLimit";
}
const MAX_ACTIVE_FILE_CHARS = 60_000;
// A browser check needs this much turn time left: ~35s to render, ~45s to review, plus the fix that follows.
const CHECK_MIN_MS = 90_000;

const ASK_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "ask_questions",
    description:
      "Ask the user a clarifying form before designing: 1–8 questions, each with the field type that fits it (single choice, multiple choice checkboxes, dropdown, short or long text, number, slider, yes/no toggle). Ends your turn; their answers arrive as the next message.",
    parameters: ASK_PARAMETERS,
  },
};

const PLAN_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "submit_plan",
    description:
      "Hand in the plan for this design. Ends the planning step; the build step then writes the files from exactly this plan, so make it concrete enough to build from without re-thinking.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "What's being made, in a few words" },
        summary: { type: "string", description: "One or two sentences: what it is and who it's for" },
        direction: { type: "string", description: "Visual direction: palette (hex values), Google Fonts pairing, layout, mood" },
        sections: {
          type: "array",
          description: "The parts to build, in order, each with its real content (copy, data, facts with [S#] source IDs)",
          items: { type: "object", properties: { name: { type: "string" }, detail: { type: "string" } }, required: ["name", "detail"] },
        },
        files: { type: "array", items: { type: "string" }, description: 'File names to write, e.g. "Landing Page.html"' },
        notes: { type: "string", description: "Interactions, tweaks and anything else the builder must know" },
      },
      required: ["title", "summary", "direction", "sections"],
    },
  },
};

type Plan = { title: string; summary: string; direction: string; sections: { name: string; detail: string }[]; files: string[]; notes: string };

function cleanPlan(a: any): Plan {
  const str = (v: unknown, n: number) => removeEmDashes(String(v ?? "").trim()).slice(0, n);
  return {
    title: str(a?.title, 120) || "Plan",
    summary: str(a?.summary, 600),
    direction: str(a?.direction, 1500),
    sections: (Array.isArray(a?.sections) ? a.sections : []).slice(0, 20).map((x: any) => ({ name: str(x?.name, 120), detail: str(x?.detail, 1500) })).filter((x: any) => x.name || x.detail),
    files: (Array.isArray(a?.files) ? a.files : []).slice(0, 5).map((f: any) => cleanPath(String(f))),
    notes: str(a?.notes, 1500),
  };
}

function planText(p: Plan) {
  return [
    `${p.title}: ${p.summary}`,
    `Direction: ${p.direction}`,
    ...p.sections.map((x, i) => `${i + 1}. ${x.name}: ${x.detail}`),
    p.files.length ? `Files: ${p.files.join(", ")}` : "",
    p.notes ? `Notes: ${p.notes}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const APPEND_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "append_file",
    description:
      "Add more to a file you're building in parts: write_file the first part, then append_file the rest (sections, then scripts). Appends before the closing </body>. Also continues a partial file you were cut off writing.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  },
};

const CHECK_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "check_design",
    description:
      "Render a design file in a real browser and review it: a vision model looks at screenshots for visual problems, plus automatic checks for JS errors, horizontal overflow (desktop and mobile), broken images, low-contrast and clipped text.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
};

/** Automatic findings as short sentences, for the chat and the agent. */
function automatedFindings(c: CheckResult): string[] {
  const a = c.automated;
  const out: string[] = [];
  if (a.emptyPage) out.push("The page renders almost empty.");
  for (const e of a.jsErrors) out.push(`JavaScript error: ${e}`);
  if (a.horizontalOverflow.desktop > 2) out.push(`Content overflows sideways by ${a.horizontalOverflow.desktop}px at 1280px wide.`);
  if (a.horizontalOverflow.mobile > 4) out.push(`Content overflows sideways by ${a.horizontalOverflow.mobile}px on a 390px phone screen.`);
  if (a.brokenImages) out.push(`${a.brokenImages} image${a.brokenImages > 1 ? "s" : ""} failed to load.`);
  for (const l of a.lowContrast) out.push(`Low contrast ${l.ratio}:1 on “${l.text}” (${l.fg} on ${l.bg}).`);
  for (const t of a.clippedText) out.push(`Text is clipped: “${t}”.`);
  const d = a.threeD;
  if (d && !d.hook) out.push("The 3D scene isn't exposed for inspection: right after building it, set window.__vellum3d = { THREE, scene, camera, renderer } and name the part meshes.");
  if (d?.floating.length) out.push(`These parts float, attached to nothing: ${d.floating.join("; ")}. Attach each to its parent part (touching surfaces, placed within its parent's group).`);
  if (d?.cutOff) out.push("The model is cut off by the frame: fit the camera to the model's bounding box.");
  else if (d?.tiny) out.push(`The model is small in the frame (it spans ${Math.round((d.fill ?? 0) * 100)}% of it on its longer side): move the camera in so it fills about 60 to 75% of the frame, fitting the camera distance to the model's bounding box without extra margin.`);
  const p = a.print;
  if (p?.target && (p.pages < p.target[0] || p.pages > p.target[1])) {
    const want = p.target[0] === p.target[1] ? `exactly ${p.target[0]} page${p.target[0] > 1 ? "s" : ""}` : `${p.target[0]} to ${p.target[1]} pages`;
    out.push(
      p.pages > p.target[1]
        ? `Printed, it runs to ${p.pages} pages but must be ${want}. Make it fit while keeping the designed layout: tighten spacing, line height and type sizes a little, trim wording, and check the @page margins and print styles.`
        : `Printed, it's only ${p.pages} page${p.pages > 1 ? "s" : ""} but should be ${want}. Add real depth (more evidence, analysis, examples) rather than padding.`
    );
  }
  return out;
}

const SAVE_DS_SCHEMA: ToolSchema = {
  type: "function",
  function: {
    name: "save_design_system",
    description:
      "Save a design system (named colors + fonts) so it appears in the design system picker for future projects, and apply it to this one. Use when the user asks you to create or extract a design system.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        colors: {
          type: "array",
          description: "5–10 colors; include roles named Background, Surface, Text and Accent",
          items: { type: "object", properties: { name: { type: "string" }, hex: { type: "string", description: "#rrggbb" } }, required: ["name", "hex"] },
        },
        fonts: {
          type: "array",
          description: "Heading first, then Body (and optionally Mono), as CSS stacks naming Google Fonts families, e.g. 'Fraunces', serif",
          items: { type: "object", properties: { role: { type: "string" }, stack: { type: "string" } }, required: ["role", "stack"] },
        },
      },
      required: ["name", "colors", "fonts"],
    },
  },
};

/**
 * Save a design system to the picker and apply it to this project. A project
 * keeps one saved system: later saves (the spec being revised) update that
 * row instead of adding duplicates, unless it was deleted meanwhile.
 */
async function saveDesignSystem(db: SupabaseClient, projectId: string, settings: ProjectSettings, args: any) {
  const colors = (Array.isArray(args.colors) ? args.colors : [])
    .map((c: any) => ({ name: String(c?.name ?? "Color").slice(0, 40), hex: String(c?.hex ?? "").trim().toLowerCase() }))
    .map((c: any) => (/^#[0-9a-f]{3}$/.test(c.hex) ? { ...c, hex: "#" + [...c.hex.slice(1)].map((ch) => ch + ch).join("") } : c))
    .filter((c: any) => /^#[0-9a-f]{6}$/.test(c.hex))
    .slice(0, 12);
  const fonts = (Array.isArray(args.fonts) ? args.fonts : [])
    .filter((f: any) => f?.stack)
    .slice(0, 4)
    .map((f: any) => ({ role: String(f.role ?? "Body").slice(0, 40), stack: String(f.stack).replace(/"/g, "'").slice(0, 120) }));
  if (colors.length < 2) throw new Error("give at least two colors as #rrggbb hex values");
  if (!fonts.length) throw new Error("give at least one font");
  const name = String(args.name ?? "").trim().slice(0, 60) || "Untitled system";
  const row = { name, tokens: { colors, fonts }, updated_at: new Date().toISOString() };
  let data: any = null;
  if (settings.savedDesignSystemId) {
    const res = await db.from("design_systems").update(row).eq("id", settings.savedDesignSystemId).select("*");
    data = res.data?.[0] ?? null;
  }
  if (!data) {
    const res = await db.from("design_systems").insert({ owner_id: null, ...row }).select("*").single();
    if (res.error || !res.data) throw new Error(`saving the design system failed: ${res.error?.message}`);
    data = res.data;
  }
  settings.savedDesignSystemId = data.id;
  await db.from("projects").update({ design_system_id: data.id, settings }).eq("id", projectId);
  return fromRow(data);
}

function systemPrompt(opts: { templateBrief: string; designSystem: string; codebase: string | null; research: boolean; researchSources: number; threeD: boolean }) {
  return `You are the design agent in Vellum, a design tool where people describe what they want and you make it on a live canvas. You work like a senior product designer who writes production-quality HTML, CSS and JavaScript.

## Files
- Every design is a file in this project: one complete, self-contained HTML document (inline <style> and <script>). External resources only from Google Fonts, cdn.jsdelivr.net, unpkg.com or cdnjs.cloudflare.com. No build step, no frameworks that need compiling.
- Name files for what they are: "Landing Page.html", "Q3 Board Deck.html", "Onboarding Flow.html". Make a new file for a genuinely new artifact or variation; otherwise edit the existing one.
- For targeted edits use str_replace with an exact, unique snippet of the current file. Use write_file to create a file or when most of it changes.
- Each reply can only hold so much. For a large file, write_file the head, styles and first sections, then append_file the rest in one or two more calls, rather than one giant write_file.
- When a file is built in parts, never split its code across several <script> tags: separate <script type="module"> blocks don't share variables, so the page breaks. Write the HTML and CSS in the first parts and all the JavaScript as ONE script in the last part (or one part per call that each stands alone).
- Keep data-el attributes on elements intact; the user's direct edits rely on them.
- Printable documents (résumés, one-pagers, reports, letters) are designed as paper. Set an @page rule with the size and margins, declare the intended page count with <meta name="pages" content="1"> (or a range like "3-5"), and make it print to exactly that. The printed layout must match the screen layout (same columns and sidebar): keep phone-only rules for screens with @media screen and (max-width: …), and use break-inside: avoid on entries (and break-after: avoid on headings) so nothing splits awkwardly. The automatic check prints the file and tells you the real page count; if it's over, tighten spacing and type or trim wording, never let it spill onto an extra page.

## How you work
- Think briefly and practically: decide the direction, then build. Don't deliberate at length over details (exact pixel values, alternatives you won't use); the first version can be refined after it's on the canvas.
- Before each batch of tool calls, write one short line (under 12 words) saying what you're doing, as a present participle, e.g. "Picking a font pairing and accent color." It appears as a progress row.
- If a request leaves important choices open (what it's for, audience, content, features or sections needed, tone, format), call ask_questions with a proper form instead of guessing: ask everything you actually need in one go (usually 3–6 questions), each with the field type that fits. Use single for one-of choices, multi (checkboxes) for picking several, like features, sections or pages needed, select for a long list, text for names and specifics, long for descriptions, number or slider for quantities (e.g. how many screens or slides), and toggle for yes/no. Give concrete options, not vague ones, and preselect a sensible default where one is obvious. If the request is already specific enough, just start designing. Never ask twice in a row; once answered, design with what you have and decide anything left open yourself.
- Every file you write is checked automatically in a real browser before your reply reaches the user, and any real problems come back to you to fix. You can also call check_design yourself mid-way. When problems come back, fix them directly; don't ask the user.
- If the user asks you to create, extract or define a design system, make a visual spec file for it (palette with roles and hex values, type scale, spacing/radius, core components in their states) and call save_design_system so it becomes reusable.
- When the user comments on a specific element, you get its HTML; change that element and leave the rest alone.
- When you're done, reply in 1–3 short sentences: what you made or changed, and optionally one idea for what to refine next. Plain prose; **bold** is fine; no headings, no code. Make no tool calls after that reply.

## Design quality
- Writing style, in the design's copy and in your replies: never use em dashes (—). Use a comma, colon, period or parentheses instead. Use an en dash (–) only for number ranges like 2019–2023.
- Commit to a clear visual direction: a deliberate type pairing (Google Fonts), a restrained palette defined as CSS custom properties on :root, one accent color used with intent, and a consistent spacing scale.
- Strong hierarchy and real, specific content: never lorem ipsum, never "Feature 1". Invent plausible names, numbers and copy when the user didn't provide them.
- Icons are inline SVG (simple 1.5px-stroke line icons), never emoji. Images: use CSS gradients, SVG illustration or shapes rather than external stock photo URLs.
- Layout with CSS grid/flexbox; it must look right at the canvas width and be responsive. Check contrast. Avoid generic "AI" aesthetics: no purple-blue gradients everywhere, no glassmorphism by default, no centered-everything.
- SVG animation: a CSS transform or animation on an SVG element replaces its transform attribute, so never animate an element that is positioned with transform="…". Position with an outer <g transform="translate(…)"> and animate an inner <g> (set transform-box: fill-box and a transform-origin on it). Never run two animations that both set transform on the same element; nest groups instead.
- Printable formats (documents, slides, résumés) include @page and page-break rules so browser print → PDF looks right.

## Tweaks
Expose 2–5 meaningful live controls when they'd help the user explore (accent color, density, speed, which screen to show, a layout variant). Declare them in the file as:
<script type="application/json" id="tweaks">[{"name":"accent","label":"Accent","type":"color","value":"#d9774f"},{"name":"speed","type":"range","min":200,"max":2000,"step":50,"value":700,"unit":"ms"},{"name":"startScreen","type":"select","options":["home","detail"],"value":"home"},{"name":"grid","type":"toggle","value":false}]</script>
The canvas applies every value as a CSS custom property on :root (--accent, --speed with its unit, --grid as 1/0), as an attribute on <html> (data-start-screen="detail"; camelCase names become kebab-case), and fires window.addEventListener("tweak", e => e.detail.name / e.detail.value) on load and on every change. Use var(--name) in CSS or the event in JS.
${opts.threeD ? `\n${threeDGuide()}\n` : ""}${opts.research ? `\n## Research\nSearch with targeted queries, web_fetch the best sources, then write; stop searching once you can answer at the depth the user chose. Cite every factual sentence as [S3] or [S3, S5] using only IDs you were given; a numbered sources list is added automatically. Never write URLs as citations. This turn's research allowance is ${opts.researchSources} searches and fetches.\n` : "\n## Facts\nDraft first. Write the design straight away from what you know; use web_search / web_fetch only for a specific real-world fact you'd otherwise get wrong, and cite it as [S3]. Most design work needs no search at all, and each turn allows at most 6 searches and fetches.\n"}
## This project
Starting template: ${opts.templateBrief}
${opts.designSystem || "No design system selected. Choose a fitting visual direction yourself."}
${opts.codebase ? `\nConnected codebase: ${opts.codebase}. Before designing, use repo_tree / repo_read to study its UI code (components, global CSS, Tailwind/theme config, tokens) and match its visual language, component patterns and real product copy.` : ""}`;
}

/** Decode the JSON string value of `key` from a tool call's partial argument text. */
function validArgs(args: string) {
  try {
    JSON.parse(args || "{}");
    return args || "{}";
  } catch {
    const path = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(args)?.[1];
    return JSON.stringify(path ? { path: path.replace(/\\"/g, '"'), cut_off: true } : { cut_off: true });
  }
}

function partialJsonString(args: string, key: string): string | null {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(args);
  if (!m) return null;
  let i = m.index + m[0].length;
  let out = "";
  while (i < args.length) {
    const ch = args[i];
    if (ch === '"') break;
    if (ch === "\\") {
      const nx = args[i + 1];
      if (nx === undefined) break;
      if (nx === "u") {
        const hex = args.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      out += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" } as Record<string, string>)[nx] ?? nx;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

type ProjectSettings = {
  designSystems?: string[];
  summary?: { upTo: string; text: string };
  partial?: { path: string; content: string };
  /** A file written right before a pause that still needs its browser check. */
  pendingCheck?: string;
  /** Reasoning cut off by the time limit before the model acted on it, handed to the next round so it doesn't start over. */
  partialThought?: string;
  /**
   * A new design runs as three steps, each its own invocation with its own time budget and its own section
   * in the chat: plan (think, research, ask; hand in a plan), build (write the files from the plan) and
   * check (browser check, fixes, reply). Small follow-up edits run as one step.
   */
  phase?: "plan" | "build" | "check";
  plan?: Plan;
  /** The phase this invocation starts fresh (not a time-limit resume within the same phase). */
  phaseFresh?: boolean;
  /** The build step's closing line, used as the reply when the check finds nothing to fix. */
  buildReply?: string;
  /** The model that took over from a reasoning model that deliberated too long; kept for the rest of the request. */
  buildModel?: ModelKey;
  /** File versions this request is still writing (see WorkingVersions); cleared when the request is done. */
  workingVersions?: Record<string, number>;
  /** The design system this project made and saved to the picker, and its spec file; revisions to that file update it. */
  savedDesignSystemId?: string;
  designSystemFile?: string;
};
type HistoryMessage = { id: string; role: string; content: string; meta: any; created_at: string };

const KEEP_RECENT = 12;

function describeSystems(systems: DesignSystem[]) {
  if (!systems.length) return "";
  const [primary, ...rest] = systems;
  return (
    describeForAgent(primary) +
    (rest.length ? `\nAlso draw on these design systems where the user asks for it or it fits:\n${rest.map(describeForAgent).join("\n")}` : "")
  );
}

/** Newly attached images get described once by a vision model; the description is cached on the message. */
async function describeNewImages(db: SupabaseClient, msgs: HistoryMessage[], emit: Emit, opts: { deadline: number; signal?: AbortSignal }) {
  const last = [...msgs].reverse().find((m) => m.role === "user");
  const images = ((last?.meta?.attachments ?? []) as any[]).filter((a) => a.kind === "image" && a.url && !a.description);
  if (!last || !images.length) return;
  for (const [i, a] of images.entries()) {
    const callId = `img-${i}`;
    await emit({ type: "tool-call", payload: { callId, name: "view_image", args: { path: a.name } } });
    try {
      a.description = await describeImage(a.url, { deadline: opts.deadline - 60_000, signal: opts.signal });
      await emit({ type: "tool-result", payload: { callId, name: "view_image", path: a.name, image: a.url } });
    } catch (e) {
      a.description = "(The image couldn't be read by the vision model.)";
      await emit({ type: "tool-result", payload: { callId, name: "view_image", path: a.name, error: e instanceof Error ? e.message : String(e) } });
    }
  }
  await db.from("messages").update({ meta: last.meta }).eq("id", last.id);
}

/** Summarize messages that fell out of the recent window, reusing (and extending) the cached summary. */
async function summarizeOlder(db: SupabaseClient, projectId: string, settings: ProjectSettings, older: HistoryMessage[], deadline: number) {
  if (!older.length) return "";
  const upTo = older[older.length - 1].created_at;
  const cached = settings.summary;
  if (cached?.upTo === upTo) return cached.text;
  const fresh = cached ? older.filter((m) => m.created_at > cached.upTo) : older;
  const transcript = fresh
    .map((m) => `${m.role === "user" ? "User" : "Designer"}: ${describeUserMessage(m, false).slice(0, 1500)}`)
    .join("\n\n");
  let text = "";
  try {
    const r = await chat("glm-flash", {
      messages: [
        {
          role: "system",
          content:
            "Summarize a design conversation for the designer who continues it. Keep: what has been made (file names), design decisions (palette, type, layout), the user's preferences and feedback, and anything still open. Bullet points, under 250 words, no preamble.",
        },
        { role: "user", content: `${cached ? `Summary so far:\n${cached.text}\n\nNewer messages:\n` : ""}${transcript}` },
      ],
      deadline: Math.min(deadline - 60_000, Date.now() + 45_000),
    });
    text = removeEmDashes(r.content.trim());
  } catch {
    // Keep going without a fresh summary; the older cached one (if any) is still useful.
  }
  if (!text) return cached?.text ?? "";
  // Kept on the turn's settings object too, so its later writes (pending check, partial file) don't drop it.
  settings.summary = { upTo, text };
  await db.from("projects").update({ settings }).eq("id", projectId);
  return text;
}

function describeUserMessage(m: { content: string; meta: any }, full: boolean) {
  let text = m.content;
  const meta = m.meta ?? {};
  if (meta.target) {
    const t = meta.target;
    text = `(Comment on the <${t.tag}> element${t.path ? ` in ${t.path}` : ""}${t.id ? ` with data-el="${t.id}"` : ""}:\n${String(t.html ?? t.text ?? "").slice(0, 1500)}\n)\n\n${text}`;
  }
  for (const a of meta.attachments ?? []) {
    if (a.kind === "image") {
      text += `\n\n(Attached image "${a.name}". Use it in the design with <img src="${a.url}"> if it belongs there.${a.description ? ` What it shows: ${a.description}` : ""})`;
    } else if (a.kind === "folder") {
      text += full && a.content ? `\n\nAttached local code folder "${a.name}", the UI files of their codebase. Match its visual language:\n${String(a.content).slice(0, 120000)}` : `\n\n(Attached code folder "${a.name}")`;
    } else {
      text += full && a.content ? `\n\nAttached file "${a.name}":\n${String(a.content).slice(0, 40000)}` : `\n\n(Attached file "${a.name}")`;
    }
  }
  return text;
}

export type TurnOptions = {
  onEvent?: (e: AgentEvent & { id?: string; created_at?: string }) => void;
  signal?: AbortSignal;
  resume?: boolean;
  activeFile?: string | null;
  /** Set by the turn route when it claims the project; this turn stops as soon as the project's run_id changes. */
  runId?: string;
};

export async function runTurn(db: SupabaseClient, projectId: string, opts: TurnOptions = {}) {
  const deadline = Date.now() + TURN_BUDGET_MS;
  const emit = makeEmitter(db, projectId, opts.onEvent);
  // Writes only land while this turn still owns the project, so a stopped or superseded turn can't clobber the new one.
  // Async on purpose: a Supabase query only runs once it's awaited, so a fire-and-forget heartbeat
  // (`void touch()`) on the bare query builder would never reach the database.
  const touch = async (extra: Record<string, unknown> = {}) => {
    const q = db.from("projects").update({ updated_at: new Date().toISOString(), ...extra }).eq("id", projectId);
    await (opts.runId ? q.eq("run_id", opts.runId) : q);
  };
  // Aborts on client disconnect (Stop in this tab) or when the project is stopped/claimed elsewhere.
  const ctrl = new AbortController();
  opts.signal?.addEventListener("abort", () => ctrl.abort());
  const signal = ctrl.signal;
  // The model picker can change mid-run; each step uses whatever is selected now.
  let currentModel: ModelKey = "glm";
  // Set when a reasoning model deliberated past the thinking budget: the rest of the turn builds with a fast,
  // non-reasoning model. Picking a model mid-run clears it.
  let buildModel: ModelKey | null = null;
  let settingsRef: ProjectSettings | null = null;
  const stillOwner = async () => {
    const { data: live } = await db.from("projects").select("status, run_id, model_profile").eq("id", projectId).single();
    const ok = !!live && live.status !== "stopped" && (!opts.runId || live.run_id === opts.runId);
    if (!ok) ctrl.abort();
    else if (live.model_profile && modelKeyFor(live.model_profile) !== currentModel) {
      currentModel = modelKeyFor(live.model_profile);
      buildModel = null;
      if (settingsRef?.buildModel) delete settingsRef.buildModel;
      await emit({ type: "note", payload: { text: `Switched to ${MODELS[currentModel].label}.` } });
    }
    return ok;
  };

  const { data: project } = await db.from("projects").select("*").eq("id", projectId).single();
  if (!project) throw new Error("project not found");
  currentModel = modelKeyFor(project.model_profile);
  await touch({ status: "running" });
  // The heartbeat tells other tabs (and resume logic) this turn is alive. It runs on a timer, not on streamed tokens:
  // a model can sit silent for a minute before its first token, and a turn that looks dead gets taken over.
  const heartbeat = setInterval(() => {
    void touch();
    void stillOwner();
  }, HEARTBEAT_MS);
  let settled = false;
  try {

    const settings = (project.settings ?? {}) as ProjectSettings;
    settingsRef = settings;
    const dsIds = [project.design_system_id, ...(settings.designSystems ?? [])].filter((v, i, a): v is string => !!v && a.indexOf(v) === i);
    const [{ data: dsRows }, { data: history }, files, sources] = await Promise.all([
      dsIds.length ? db.from("design_systems").select("*").in("id", dsIds) : Promise.resolve({ data: [] as any[] }),
      db.from("messages").select("id, role, content, meta, created_at").eq("project_id", projectId).order("created_at", { ascending: false }).limit(400),
      listFiles(db, projectId),
      SourceRegistry.load(db, projectId, project.budget),
    ]);

    const template = getTemplate(project.template);
    // Research is scoped first: the depth the user picks sets the sources read and the report's printed length.
    const userTexts = (history ?? []).filter((m) => m.role === "user").map((m) => String(m.content ?? ""));
    const answeredForm = (history ?? []).some((m) => m.role === "user" && m.meta?.answers);
    const depth = template.id === "research" ? depthFrom(userTexts) ?? (answeredForm ? DEFAULT_DEPTH : null) : null;
    const mustScope = template.id === "research" && !depth && !answeredForm;
    sources.turnLimit = template.id === "research" ? (depth ?? DEFAULT_DEPTH).sources : 6;
    // The printed page count the automatic check holds the design to (a file can also declare its own with <meta name="pages">).
    const printPages: [number, number] | null = template.id === "resume" ? [1, 1] : depth ? depth.pages : null;
    // A new request starts fresh versions; resumed steps of the same request keep updating the same ones.
    if (!opts.resume) delete settings.workingVersions;
    const workingVersions = (settings.workingVersions ??= {});
    const fileTools = makeFileTools(db, projectId, (html) => finalizeArtifact(html, sources.sources), {
      versions: workingVersions,
      save: async () => {
        await db.from("projects").update({ settings }).eq("id", projectId);
      },
    });
    const repo = project.codebase ? makeRepoTools(project.codebase) : null;
    // A new design (or a big request) is split into plan, build and check, each its own invocation.
    const newest = (history ?? []).find((m) => m.role === "user");
    if (!opts.resume) {
      const big = files.length === 0 || template.id === "research" || String(newest?.content ?? "").length > 280;
      const isEdit = !!newest?.meta?.target;
      delete settings.plan;
      delete settings.buildReply;
      delete settings.buildModel;
      if (big && !isEdit && !mustScope) {
        settings.phase = "plan";
        settings.phaseFresh = true;
      } else delete settings.phase;
    }
    const phase = settings.phase;
    // A later step of the same request keeps the model that took over, so it doesn't pay the thinking wait again.
    if (phase && settings.buildModel && !buildModel) buildModel = settings.buildModel;
    const phaseFresh = !!settings.phaseFresh;
    if (phaseFresh) delete settings.phaseFresh;
    const baseTools = [...WEB_TOOL_SCHEMAS, ...(repo ? REPO_TOOL_SCHEMAS : [])];
    const tools: ToolSchema[] =
      // A half-written file always needs the file tools, whatever the step.
      phase === "plan" && !settings.partial
        ? [...baseTools, ASK_SCHEMA, PLAN_SCHEMA]
        : phase
          ? [...FILE_TOOL_SCHEMAS, ...baseTools, APPEND_SCHEMA, SAVE_DS_SCHEMA]
          : [...FILE_TOOL_SCHEMAS, ...baseTools, APPEND_SCHEMA, CHECK_SCHEMA, SAVE_DS_SCHEMA, ASK_SCHEMA];
    if (phaseFresh && phase) await emit({ type: "phase", payload: { name: phase } });
    // The canvas shows something from the first second: the request and a skeleton while planning, then the plan's wireframe.
    if (phaseFresh && phase === "plan" && !files.length) {
      await emit({ type: "draft", payload: { path: cleanPath(project.title ?? "Design"), append: planningPlaceholderHtml(String(newest?.content ?? project.title ?? ""), template.label), reset: true } });
    }
    await db.from("projects").update({ settings }).eq("id", projectId);

    const all = (history ?? []).reverse();
    await describeNewImages(db, all, emit, { deadline, signal });
    // Long chats: the recent messages go in verbatim, everything older as a cached summary.
    const recent = all.slice(-KEEP_RECENT);
    const summary = await summarizeOlder(db, projectId, settings, all.slice(0, -KEEP_RECENT), deadline);
    const systems = dsIds.map((id) => (dsRows ?? []).find((r: any) => r.id === id)).filter(Boolean).map((r: any) => fromRow(r));
    const lastUserIdx = recent.map((m) => m.role).lastIndexOf("user");
    const convo: ChatMessage[] = [
      {
        role: "system",
        content:
          systemPrompt({
            templateBrief: `${template.label}. ${template.brief}`,
            designSystem: describeSystems(systems),
            codebase: project.codebase,
            research: template.id === "research",
            researchSources: sources.turnLimit,
            threeD: is3DRequest(template.id, String(newest?.content ?? project.goal ?? "")),
          }) + (summary ? `\n\n## Earlier in this conversation (summarized)\n${summary}` : ""),
      },
    ];
    recent.forEach((m, i) => {
      if (m.role === "user") convo.push({ role: "user", content: describeUserMessage(m, i === lastUserIdx) });
      else if (m.role === "assistant" && m.content) convo.push({ role: "assistant", content: m.content });
    });

    // Current state of the canvas, so small edits don't need a read_file round trip first.
    const active = files.find((f) => f.path === opts.activeFile) ?? files[0];
    let context = files.length
      ? `\n\n---\nFiles in this project: ${files.map((f) => `"${f.path}" (v${f.version})`).join(", ")}.`
      : "\n\n---\nThe project has no files yet.";
    if (active) {
      const cur = await readFile(db, projectId, active.path);
      if (cur && cur.content.length <= MAX_ACTIVE_FILE_CHARS) {
        context += `\nThe user is looking at "${active.path}". Its current contents (v${cur.version}):\n\`\`\`html\n${cur.content}\n\`\`\``;
      } else if (cur) {
        context += `\nThe user is looking at "${active.path}" (too long to include, so read_file it before editing).`;
      }
    }
    if (mustScope) {
      context +=
        "\n\nThis is a new research request. Before any searching, call ask_questions to scope it: the form always includes how deep to go (which sets the report's length), so add 2 to 4 questions specific to this topic, such as the focus areas to cover (multi), who it's for, the time period or region, and anything to include or leave out.";
    } else if (depth) {
      context += `\n\nResearch depth: ${depth.label}. The report should print to ${depth.pages[0] === depth.pages[1] ? depth.pages[0] : `${depth.pages[0]} to ${depth.pages[1]}`} US Letter page${depth.pages[1] > 1 ? "s" : ""}: declare it with <meta name="pages" content="${depth.pages[0] === depth.pages[1] ? depth.pages[0] : `${depth.pages[0]}-${depth.pages[1]}`}"> and write enough real substance to fill it. Read about ${depth.sources} sources.`;
    }
    const carriedThought = settings.partialThought ?? "";
    if (carriedThought) {
      context += `\n\nThe time limit cut you off while you were still thinking this through, before you acted. Your reasoning so far:\n"""\n${carriedThought}\n"""\n${phase === "plan" ? "Don't start over: take it from there and call submit_plan now, keeping any further thinking brief." : "Don't start over or re-plan: take it from there and start building now (write_file first, append_file for the rest), keeping any further thinking brief."}`;
    }
    if (phase === "plan") {
      context +=
        "\n\n## This step: planning\nThis request is done in three steps, each with its own time: plan (now), build, then a browser check. In this step, understand the request, research anything you need (web_search / web_fetch), ask_questions only if something essential is unclear, then call submit_plan with a concrete plan: the visual direction (palette with hex values, a Google Fonts pairing, layout), every section with its real content, the file names, and any interactions or tweaks. Don't write files in this step.";
    } else if (phase === "build" && settings.plan) {
      context += `\n\n## This step: building\nThe planning step produced this plan:\n"""\n${planText(settings.plan)}\n"""\nBuild it now, faithfully: write_file the design (append_file for the rest if it's long). No need to re-plan; decide any small details as you go. When the files are written, reply in one short sentence; a browser check runs as the next step.`;
    } else if (phase === "check" && settings.plan) {
      context += `\n\n## This step: checking\nThe design was built from this plan:\n"""\n${planText(settings.plan)}\n"""`;
    }
    if (opts.resume && !phaseFresh) context += "\n\nYou were interrupted by a time limit partway through this request. Continue from where the files are now; don't start over.";
    if (settings.pendingCheck && !settings.partial) {
      context += `\n\n"${settings.pendingCheck}" is written; it only still needs its browser check, which runs automatically once you reply. Unless something else is unfinished, just reply in one sentence.`;
    }
    if (settings.partial) {
      const p = settings.partial;
      context += `\n\nThe time limit cut you off while you were writing "${p.path}". The first ${p.content.length} characters are saved. Don't rewrite them: call append_file with path "${p.path}" and ONLY the rest of the document, continuing exactly where this leaves off:\n\`\`\`html\n…${p.content.slice(-1500)}\n\`\`\``;
    }
    const lastUser = [...convo].reverse().find((m) => m.role === "user");
    if (lastUser) lastUser.content = `${lastUser.content ?? ""}${context}`;
    else convo.push({ role: "user", content: `Continue.${context}` });

    const touched = new Map<string, { version: number; created: boolean }>();
    const checks = new Map<string, number>();
    // The last file written this turn that hasn't been through a browser check yet.
    let unchecked: string | null = settings.pendingCheck ?? null;
    let autoChecks = 0;
    // A request for a design system isn't done until it's saved to the picker.
    const latestRequest = [...recent].reverse().find((m) => m.role === "user")?.content ?? "";
    const wantsDesignSystem =
      template.id === "designsystem" ||
      !!settings.savedDesignSystemId ||
      // "make a motion design system", "turn this into a design system"; not "a landing page using my design system".
      /\b(create|make|build|generate|extract|define|set up|into)\s+(me\s+)?(a|an|the|our|my|new)?\s*([\w,'-]+\s+){0,3}design[- ]system/i.test(latestRequest);
    let dsSaved = false;
    let dsNudged = false;
    // The spec file this turn wrote that the saved design system should match, if any.
    const dsSpecFile = () => {
      if (!wantsDesignSystem || dsSaved || !touched.size) return null;
      const known = settings.designSystemFile;
      return known ? (touched.has(known) ? known : null) : [...touched.keys()].pop()!;
    };
    // The model didn't save the design system it made: read the tokens out of the spec file itself.
    const autoSaveDesignSystem = async (path: string) => {
      const callId = `auto-save-ds-${Date.now()}`;
      try {
        const { content } = await fileTools.read_file({ path });
        const tokens = extractDesignSystem(content, project.title ?? latestRequest);
        if (!tokens) return;
        await emit({ type: "tool-call", payload: { callId, name: "save_design_system", args: { name: tokens.name } } });
        settings.designSystemFile = path;
        const saved = await saveDesignSystem(db, projectId, settings, tokens);
        dsSaved = true;
        await emit({ type: "tool-result", payload: { callId, name: "save_design_system", dsName: saved.name, system: saved } });
      } catch (e) {
        await emit({ type: "tool-result", payload: { callId, name: "save_design_system", error: e instanceof Error ? e.message : String(e) } });
      }
    };
    const checkDeferred = !!settings.pendingCheck;
    let badCalls = 0;
    let thinkCuts = 0;
    let status: "ready" | "paused" = "ready";
    // The write_file call being streamed, so a turn cut off by the time limit can hand its partial file to the next round.
    let writing: { path: string; args: string } | null = null;
    const savePartial = async () => {
      const content = writing ? partialJsonString(writing.args, "content") : null;
      if (!writing?.path || !content || content.length < 400) return;
      settings.partial = { path: writing.path, content };
      await db.from("projects").update({ settings }).eq("id", projectId);
    };

    const requestText = () => {
      const latest = [...recent].reverse().find((m) => m.role === "user" && !m.meta?.answers)?.content ?? "";
      return `${project.goal ?? ""}${latest && latest !== project.goal ? `\nLatest request: ${latest}` : ""}`;
    };
    /** Render a file in a browser and review it; shared by the agent's own check_design calls and the automatic check. */
    const runCheck = async (path: string) => {
      const f = await fileTools.read_file({ path });
      checks.set(f.path, (checks.get(f.path) ?? 0) + 1);
      if (unchecked === f.path) unchecked = null;
      const c = await checkDesign(db, projectId, f.content, { deadline, signal, request: requestText(), printPages, renderTimeoutMs: phase === "check" || /three|webgl/i.test(f.content) ? 90_000 : undefined });
      const auto = automatedFindings(c);
      const serious = c.issues.filter((i) => i.severity !== "low");
      const visual = c.issues.map((i) => `${i.severity === "high" ? "High" : i.severity === "medium" ? "Medium" : "Low"}: ${i.where ? `${i.where}: ` : ""}${i.problem}`);
      const needsFix = auto.length > 0 || serious.length > 0;
      return {
        path: f.path,
        needsFix,
        problems: [...auto, ...visual.filter((v) => !v.startsWith("Low"))],
        result: {
          path: f.path,
          version: f.version,
          automated_findings: auto,
          visual_issues: c.issues,
          overall: c.overall,
          note: needsFix ? "Fix the automated findings and the high/medium visual issues." : "Looks good; no fixes needed.",
        },
        summary: { path: f.path, image: c.screenshotUrl, reviewer: c.reviewer, findings: [...auto, ...visual].slice(0, 12), count: auto.length + c.issues.length },
      };
    };

    const finish = async (reply: string | null) => {
      if (settings.phase || settings.plan || settings.buildReply || settings.buildModel || settings.workingVersions) {
        delete settings.phase;
        delete settings.plan;
        delete settings.buildReply;
        delete settings.buildModel;
        // Done (and checked): the versions written in this request are final; the next change starts new ones.
        delete settings.workingVersions;
        await db.from("projects").update({ settings }).eq("id", projectId);
      }
      if (reply) {
        reply = removeEmDashes(reply);
        const meta = { files: [...touched].map(([path, v]) => ({ path, ...v })) };
        const { data: message } = await db
          .from("messages")
          .insert({ project_id: projectId, role: "assistant", content: reply, meta, created_at: new Date().toISOString() })
          .select("id, role, content, meta, created_at")
          .single();
        if (message) await emit({ type: "message", payload: { message } });
      }
    };

    try {
      // The check step starts with the browser check itself, no model call first; the model only comes in to fix.
      let checkedClean = false;
      if (phase === "check" && phaseFresh && unchecked) {
        autoChecks++;
        const path = unchecked;
        const callId = "check-step";
        await emit({ type: "note", payload: { text: "Checking the result in a real browser." } });
        await emit({ type: "tool-call", payload: { callId, name: "check_design", args: { path } } });
        let out: Awaited<ReturnType<typeof runCheck>> | null = null;
        try {
          out = await runCheck(path);
          await emit({ type: "tool-result", payload: { callId, name: "check_design", ...out.summary } });
        } catch (e) {
          unchecked = null;
          await emit({ type: "tool-result", payload: { callId, name: "check_design", path, error: e instanceof Error ? e.message : String(e) } });
        }
        delete settings.pendingCheck;
        await db.from("projects").update({ settings }).eq("id", projectId);
        if (out?.needsFix) {
          convo.push({ role: "assistant", content: settings.buildReply || "Built it." });
          convo.push({
            role: "user",
            content: `An automatic check of "${out.path}" in a real browser found these problems:\n${out.problems.map((p) => `- ${p}`).join("\n")}\nFix them now (str_replace for small fixes), then reply in one or two sentences about what you made. Don't ask the user; just fix it.`,
          });
        } else {
          checkedClean = true;
          await finish(settings.buildReply || "Done. It's on the canvas.");
        }
      }
      for (let step = 0; step < MAX_STEPS && !checkedClean; step++) {
        if (signal.aborted) {
          await finish(touched.size ? "Stopped. What's on the canvas so far is saved." : null);
          break;
        }
        if (deadline - Date.now() < STOP_MARGIN_MS) {
          status = "paused";
          await emit({ type: "continue", payload: {} });
          break;
        }
        if (!(await stillOwner())) {
          await finish(touched.size ? "Stopped. What's on the canvas so far is saved." : null);
          break;
        }

        // base: for append_file, the file so far (undefined until requested, null while loading).
        const drafts = new Map<number, { path: string; sent: number; at: number; base?: string | null }>();
        const stepStart = Date.now();
        let stepReasoning = "";
        // Per-step abort, so a step that only deliberates can be cut without stopping the turn.
        const stepCtrl = new AbortController();
        const onTurnAbort = () => stepCtrl.abort(signal.reason);
        signal.addEventListener("abort", onTurnAbort);
        let acted = false;
        // Re-checked every second once past the limit: slow thinkers may not have written much yet when it's first reached.
        const thinkLimit = THINK_LIMIT_MS * (phase === "plan" ? 4 / 3 : 1);
        const thinkTimer =
          thinkCuts < MAX_THINK_CUTS
            ? setInterval(() => {
                if (!acted && Date.now() - stepStart > thinkLimit && stepReasoning.length > 200) stepCtrl.abort(new ThinkLimit("thought too long without acting"));
              }, 1000)
            : undefined;
        let r;
        try {
          r = await chat(buildModel ?? currentModel, {
            messages: convo,
            tools,
            deadline,
            signal: stepCtrl.signal,
            onToken: (t) => {
              acted = true;
              void emit({ type: "token", payload: { t } });
            },
            onReasoning: (t) => {
              stepReasoning += t;
              void emit({ type: "reasoning", payload: { t } });
            },
            onToolDelta: (index, name, args) => {
              acted = true;
              if (name !== "write_file" && name !== "append_file") return;
              const d = drafts.get(index) ?? { path: "", sent: 0, at: 0 };
              const now = Date.now();
              if (now - d.at < 250) return;
              d.at = now;
              const path = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(args)?.[1];
              const content = partialJsonString(args, "content");
              if (path && !d.path) {
                try {
                  d.path = cleanPath(JSON.parse(`"${path}"`));
                } catch {
                  d.path = cleanPath(path);
                }
              }
              drafts.set(index, d);
              // An added part streams onto what's already written, so the canvas grows live instead of jumping at the end.
              if (name === "append_file") {
                if (!d.path) return;
                if (d.base === undefined) {
                  d.base = null;
                  const target = d.path;
                  const saved = settings.partial?.path === target ? settings.partial.content : null;
                  (saved != null ? Promise.resolve(saved) : fileTools.read_file({ path: target }).then((f) => f.content, () => ""))
                    .then((b) => (d.base = b.replace(/<\/body>\s*<\/html>\s*$/i, "")));
                }
                if (d.base == null || content == null || content.length <= d.sent) return;
                void emit({ type: "draft", payload: { path: d.path, append: d.sent === 0 ? d.base + content : content.slice(d.sent), reset: d.sent === 0 } });
                d.sent = content.length;
                return;
              }
              if (d.path) writing = { path: d.path, args };
              if (!d.path || content == null || content.length <= d.sent) return;
              void emit({ type: "draft", payload: { path: d.path, append: content.slice(d.sent), reset: d.sent === 0 } });
              d.sent = content.length;
            },
          });
        } catch (e) {
          if (signal.aborted) {
            await finish(touched.size ? "Stopped. What's on the canvas so far is saved." : null);
            break;
          }
          if (e instanceof ThinkLimit || (e as any)?.name === "ThinkLimit") {
            thinkCuts++;
            const plan = stepReasoning.trim();
            await emit({ type: "thought", payload: { text: plan.length > 12000 ? "…" + plan.slice(-12000) : plan, ms: Date.now() - stepStart } });
            // Told to act, reasoning models tend to keep deliberating, so a model that doesn't reason builds from the plan.
            if (!buildModel && (buildModel ?? currentModel) !== BUILD_MODEL) {
              buildModel = BUILD_MODEL;
              if (phase) {
                settings.buildModel = BUILD_MODEL;
                await db.from("projects").update({ settings }).eq("id", projectId);
              }
              await emit({
                type: "note",
                payload: {
                  text:
                    phase === "plan"
                      ? `Thought it through; handing the write-up of the plan to ${MODELS[BUILD_MODEL].label}.`
                      : `Plan's ready; handing the build to ${MODELS[BUILD_MODEL].label} so it starts writing now.`,
                },
              });
            }
            convo.push({
              role: "user",
              content:
                phase === "plan"
                  ? `You've thought enough; time to hand in the plan. Your thinking so far:\n"""\n${plan.slice(-6000)}\n"""\nCall submit_plan now with a concrete plan based on it. Keep any further thinking to a few sentences.`
                  : `You've planned enough; time to build. Your plan so far:\n"""\n${plan.slice(-6000)}\n"""\nAct on it now: call write_file with the design (append_file for the rest if it's long). Keep any further thinking to a few sentences; you can refine after the first version is on the canvas.`,
            });
            continue;
          }
          if ((e as any)?.name === "TimeoutError" && deadline - Date.now() < STOP_MARGIN_MS + 5000) {
            await savePartial();
            // Long thinking that ran out the clock is kept (in the chat and for the next round), not thrown away.
            const thought = stepReasoning.trim();
            if (thought.length > 200) {
              await emit({ type: "thought", payload: { text: thought.length > 12000 ? "…" + thought.slice(-12000) : thought, ms: Date.now() - stepStart } });
              settings.partialThought = `${carriedThought ? `${carriedThought}\n\n` : ""}${thought}`.slice(-8000);
              await db.from("projects").update({ settings }).eq("id", projectId);
            }
            status = "paused";
            await emit({ type: "continue", payload: {} });
            break;
          }
          await emit({ type: "error", payload: { message: e instanceof Error ? e.message : String(e) } });
          break;
        } finally {
          clearInterval(thinkTimer);
          signal.removeEventListener("abort", onTurnAbort);
        }

        writing = null;
        if (settings.partialThought) {
          delete settings.partialThought;
          await db.from("projects").update({ settings }).eq("id", projectId);
        }
        const thought = r.reasoning.trim();
        if (thought) await emit({ type: "thought", payload: { text: thought.length > 12000 ? "…" + thought.slice(-12000) : thought, ms: Date.now() - stepStart } });

        const text = r.content.trim();
        if (!r.toolCalls.length) {
          // Never hand back unverified work: check the last written file in a real browser and send real problems back to the model.
          if (dsSpecFile() && !dsNudged) {
            dsNudged = true;
            convo.push({ role: "assistant", content: r.content || "Done." });
            convo.push({
              role: "user",
              content: settings.savedDesignSystemId
                ? "You changed the design system spec, so the saved copy in the design system picker is out of date. Call save_design_system again with the current palette (named colors, as #rrggbb) and fonts, then reply in one sentence."
                : "You haven't saved the design system yet, so it isn't in the design system picker. Call save_design_system now with the palette (named colors including Background, Surface, Text, Accent, as #rrggbb) and the fonts from the spec you made, then reply in one sentence.",
            });
            continue;
          }
          // The build step is done: the browser check runs as its own step, with its own time.
          if (phase === "build" && unchecked) {
            const specFile = dsSpecFile();
            if (specFile) await autoSaveDesignSystem(specFile);
            settings.phase = "check";
            settings.phaseFresh = true;
            settings.pendingCheck = unchecked;
            settings.buildReply = removeEmDashes(text).slice(0, 600);
            await db.from("projects").update({ settings }).eq("id", projectId);
            status = "paused";
            await emit({ type: "continue", payload: {} });
            break;
          }
          const tooLate = deadline - Date.now() < CHECK_MIN_MS;
          // Postpone a check to the next round at most once, so a short round can never pause forever.
          if (unchecked && autoChecks < 2 && !(tooLate && checkDeferred)) {
            if (tooLate) {
              settings.pendingCheck = unchecked;
              await db.from("projects").update({ settings }).eq("id", projectId);
              status = "paused";
              await emit({ type: "continue", payload: {} });
              break;
            }
            autoChecks++;
            const path = unchecked;
            const callId = `auto-check-${step}`;
            await emit({ type: "note", payload: { text: "Checking the result in a real browser." } });
            await emit({ type: "tool-call", payload: { callId, name: "check_design", args: { path } } });
            let out: Awaited<ReturnType<typeof runCheck>> | null = null;
            try {
              out = await runCheck(path);
              await emit({ type: "tool-result", payload: { callId, name: "check_design", ...out.summary } });
            } catch (e) {
              unchecked = null;
              await emit({ type: "tool-result", payload: { callId, name: "check_design", path, error: e instanceof Error ? e.message : String(e) } });
            }
            if (settings.pendingCheck) {
              delete settings.pendingCheck;
              await db.from("projects").update({ settings }).eq("id", projectId);
            }
            if (out?.needsFix) {
              convo.push({ role: "assistant", content: r.content || "Done." });
              convo.push({
                role: "user",
                content: `An automatic check of "${out.path}" in a real browser found these problems:\n${out.problems.map((p) => `- ${p}`).join("\n")}\nFix them now (str_replace for small fixes), then reply in one or two sentences. Don't ask the user; just fix it.`,
              });
              continue;
            }
          }
          if (settings.pendingCheck) {
            delete settings.pendingCheck;
            await db.from("projects").update({ settings }).eq("id", projectId);
          }
          const specFile = dsSpecFile();
          if (specFile) await autoSaveDesignSystem(specFile);
          await finish(text || (touched.size ? "Done. It's on the canvas." : "I couldn't produce anything for that. Try rephrasing?"));
          break;
        }
        if (text) await emit({ type: "note", payload: { text: removeEmDashes(text).slice(0, 240) } });

        convo.push({
          role: "assistant",
          content: r.content || null,
          // Providers reject a request whose history holds invalid JSON arguments, so a cut-off call is replaced by a stub.
          tool_calls: r.toolCalls.map((tc, i) => ({ id: tc.id || `call_${step}_${i}`, type: "function", function: { name: tc.name, arguments: validArgs(tc.args) } })),
        });

        let asked = false;
        let planned = false;
        for (const [i, tc] of r.toolCalls.entries()) {
          const callId = `${step}-${i}-${tc.id || ""}`;
          const toolCallId = tc.id || `call_${step}_${i}`;
          let result: unknown;
          let args: any = {};
          try {
            try {
              args = JSON.parse(tc.args || "{}");
            } catch {
              // A write cut off mid-file keeps what arrived, so the model only has to add the rest.
              const rawPath = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(tc.args)?.[1];
              const partial = tc.name === "write_file" ? partialJsonString(tc.args, "content") : null;
              if (rawPath && partial && partial.length >= 400) {
                const path = cleanPath(rawPath.replace(/\\"/g, '"'));
                settings.partial = { path, content: partial };
                await db.from("projects").update({ settings }).eq("id", projectId);
                throw new Error(
                  `your write_file was cut off after ${partial.length} characters because it was too long for one reply. That part is saved. Call append_file with path "${path}" and ONLY the rest of the document (keep each call under about 20,000 characters), continuing exactly after:\n…${partial.slice(-800)}`
                );
              }
              throw new Error(
                r.finish === "length"
                  ? "your tool call was cut off because it was too long for one reply. Write the file in parts: write_file with the head, styles and first sections, then append_file for the remaining sections and scripts"
                  : "tool arguments were not valid JSON"
              );
            }
            const shown =
              tc.name === "write_file" || tc.name === "append_file" || tc.name === "str_replace" || tc.name === "read_file"
                ? { path: cleanPath(args.path) }
                : tc.name === "check_design"
                  ? { path: cleanPath(args.path) }
                  : tc.name === "ask_questions"
                  ? {}
                  : args;
            await emit({ type: "tool-call", payload: { callId, name: tc.name, args: shown } });

            let summary: Record<string, unknown> = {};
            switch (tc.name) {
              case "write_file":
              case "append_file":
              case "str_replace": {
                let w;
                let merged = false;
                if (tc.name === "append_file") {
                  const path = cleanPath(args.path);
                  // A finished file already ends in </body></html>; new parts go before that, and the parser tidies the rest.
                  const base =
                    settings.partial?.path === path
                      ? settings.partial.content
                      : (await fileTools.read_file({ path })).content.replace(/<\/body>\s*<\/html>\s*$/i, "");
                  const whole = base + String(args.content ?? "");
                  merged = !unfinishedDocument(whole) && joinModuleScripts(whole) !== whole;
                  w = await fileTools.write_file({ path, content: whole });
                } else {
                  w = tc.name === "write_file" ? await fileTools.write_file(args) : await fileTools.str_replace(args);
                }
                if (settings.partial && settings.partial.path === w.path) {
                  delete settings.partial;
                  await db.from("projects").update({ settings }).eq("id", projectId);
                }
                unchecked = w.path;
                const prev = touched.get(w.path);
                touched.set(w.path, { version: w.version, created: prev?.created ?? w.created });
                result = {
                  ok: true,
                  path: w.path,
                  version: w.version,
                  ...(merged ? { note: 'The file had its code in several <script type="module"> blocks that use each other\'s variables; they were merged into one module, so that is already fixed. Carry on, and keep further code in that one script.' } : {}),
                };
                summary = { path: w.path, version: w.version, created: w.created };
                break;
              }
              case "read_file": {
                const f = await fileTools.read_file(args);
                result = f;
                summary = { path: f.path, version: f.version };
                break;
              }
              case "web_search": {
                if (mustScope) throw new Error("scope the research first: call ask_questions (depth, focus areas, audience) and wait for the answers");
                const hits = await sources.search(args);
                result = hits;
                summary = { query: args.query, results: hits.map((h) => ({ id: h.id, title: h.title, url: sources.sources.get(h.id)?.url })) };
                break;
              }
              case "web_fetch": {
                if (mustScope) throw new Error("scope the research first: call ask_questions (depth, focus areas, audience) and wait for the answers");
                const f = await sources.fetch(args);
                result = f;
                summary = { source: { id: f.id, title: f.title, url: sources.sources.get(f.id)?.url } };
                break;
              }
              case "repo_tree":
              case "repo_read": {
                if (!repo) throw new Error("no codebase is connected");
                result = tc.name === "repo_tree" ? await repo.repo_tree(args) : await repo.repo_read(args);
                summary = { path: args.path ?? "" };
                break;
              }
              case "check_design": {
                if ((checks.get(cleanPath(args.path)) ?? 0) >= 2) throw new Error("already checked this file twice this turn, so finish up");
                if (deadline - Date.now() < CHECK_MIN_MS) throw new Error("not enough time left in this turn to run a visual check");
                const out = await runCheck(cleanPath(args.path));
                result = out.result;
                summary = out.summary;
                break;
              }
              case "save_design_system": {
                if (!settings.designSystemFile && touched.size) settings.designSystemFile = [...touched.keys()].pop();
                const saved = await saveDesignSystem(db, projectId, settings, args);
                dsSaved = true;
                result = { ok: true, id: saved.id, note: "Saved. It's now in the design system picker and set as this project's design system." };
                summary = { dsName: saved.name, system: saved };
                break;
              }
              case "submit_plan": {
                const plan = cleanPlan(args);
                settings.plan = plan;
                settings.phase = "build";
                settings.phaseFresh = true;
                await db.from("projects").update({ settings }).eq("id", projectId);
                await emit({ type: "plan", payload: { plan } });
                // The canvas shows the plan's shape right away; the real file streams over it once building starts.
                await emit({ type: "draft", payload: { path: plan.files[0] ?? cleanPath(plan.title), append: planPreviewHtml(plan), reset: true } });
                result = { ok: true, note: "Plan saved. The build step starts next, with its own time." };
                planned = true;
                break;
              }
              case "ask_questions": {
                const cleaned = cleanQuestions(args.questions);
                const questions = template.id === "research" ? withDepthQuestion(cleaned) : cleaned;
                if (!questions.length) throw new Error("no questions given");
                await emit({ type: "questions", payload: { intro: String(args.intro ?? "").slice(0, 300), questions } });
                result = { ok: true, note: "The user will answer in their next message." };
                asked = true;
                break;
              }
              default:
                throw new Error(`unknown tool: ${tc.name}`);
            }
            await emit({ type: "tool-result", payload: { callId, name: tc.name, ...summary } });
            // The limit is on failures in a row: a run that recovers keeps going.
            badCalls = 0;
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            result = { error: message };
            // The chat shows the first line; the model gets the whole message (e.g. the file text to copy from).
            await emit({ type: "tool-result", payload: { callId, name: tc.name, error: message.split("\n")[0] } });
            badCalls++;
          }
          convo.push({ role: "tool", tool_call_id: toolCallId, content: JSON.stringify(result) });
        }
        await touch();
        if (asked) break;
        // The plan is in: this invocation ends and the build step starts fresh, with its own time budget.
        if (planned) {
          status = "paused";
          await emit({ type: "continue", payload: {} });
          break;
        }
        if (badCalls > 5) {
          await emit({ type: "error", payload: { message: "Too many failed tool calls, so I stopped here." } });
          break;
        }
        if (step === MAX_STEPS - 1) await finish("I hit the step limit for one turn. Say “continue” and I'll keep going.");
      }
    } finally {
      settled = true;
      await touch({ status, budget: { ...(project.budget ?? {}), searchesLeft: sources.searchesLeft } });
      await emit({ type: "done", payload: {} });
    }
  } finally {
    clearInterval(heartbeat);
    // Setup failed before the loop: don't leave the project looking busy.
    if (!settled) await touch({ status: "ready" });
  }
}
