/**
 * Runs the real agent loop (lib/agent.ts runTurn) locally, with no network and no real database: an in-memory stand-in for
 * Supabase, and a fake OpenAI-style model server that behaves the way real models were seen to misbehave.
 *
 *   npx tsx scripts/simulate-turn.ts [scenario]
 *
 * Scenarios:
 *   good          the model calls submit_plan and write_file properly
 *   dumps-text    the model writes the plan, then the whole page, into the chat instead of calling the tools
 *   dumps-forever the model pastes the plan and page as chat text every time, even when nudged (recovered each time)
 *   prose-only    the model only ever answers in prose, never a tool call or code (the nudges must give up cleanly, no loop)
 *   edit-reasons  an existing invoice, then "Make the UI better"; every call reasons for REASON_MS (default 3s, longer than the
 *                 test's 2s think limits) before it acts, ignoring "thinking off", the way GLM 5.3 behaves. Must end with a new
 *                 version of the file, not an endless run of cuts.
 *   thinks-then-writes  GLM's worst case: in the normal tool loop the model only ever reasons (never acts within any limit),
 *                 but asked by the fresh writing session it writes the page. Covers a new build and an edit (EDIT_MESSAGE).
 *   thinks-long   the model reasons for a long time in the plan step before calling submit_plan
 *   glm-build     GLM 5.3, whose endpoint sends a tool call only once it's complete (minutes of silence, nothing on the canvas):
 *                 the page must be written by the fresh writing session, which streams it, not as a write_file call.
 *   stalls-mid-answer  the endpoint goes quiet halfway through streaming write_file (NVIDIA does, now and then): the part written
 *                 is kept and the next round appends the rest. Must end with the whole page, not "model stopped responding".
 *
 * The check step really renders the page in headless Chromium (set CHROMIUM_PATH to a Chromium binary).
 *
 * The tool-loop scenarios run as GPT-OSS (a model whose endpoint streams tool calls); MODEL overrides it.
 *
 * Real models: npx tsx scripts/simulate-turn.ts real   (needs NVIDIA_API_KEY; MODEL=glm by default, EDIT_MESSAGE for an edit,
 * OUT_DIR to save the final page, BASE_FILE for the page an edit starts from). The real agent loop and real model, only the database is the in-memory stand-in. Real limits.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";

const scenario = process.argv[2] ?? "dumps-text";
const real = scenario === "real";
const PORT = 8790 + Math.floor(Math.random() * 100);

// ───────────── in-memory Supabase ─────────────
type Row = Record<string, any>;
const tables: Record<string, Row[]> = { projects: [], messages: [], events: [], files: [], sources: [], design_systems: [] };
const storage = new Map<string, string>();

class Query implements PromiseLike<{ data: any; error: any }> {
  private op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private filters: ((r: Row) => boolean)[] = [];
  private orders: { col: string; asc: boolean }[] = [];
  private lim = Infinity;
  private payload: any = null;
  private returning = true;
  private mode: "many" | "single" | "maybe" = "many";
  constructor(private table: string) {}
  select() { if (this.op === "select") this.returning = true; return this; }
  insert(p: any) { this.op = "insert"; this.payload = p; return this; }
  update(p: any) { this.op = "update"; this.payload = p; return this; }
  upsert(p: any) { this.op = "upsert"; this.payload = p; return this; }
  delete() { this.op = "delete"; return this; }
  eq(c: string, v: any) { this.filters.push((r) => r[c] === v); return this; }
  in(c: string, vs: any[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
  order(c: string, o?: { ascending?: boolean }) { this.orders.push({ col: c, asc: o?.ascending !== false }); return this; }
  limit(n: number) { this.lim = n; return this; }
  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybe"; return this; }
  then<T1, T2>(ok?: (v: { data: any; error: any }) => T1 | PromiseLike<T1>, bad?: (e: any) => T2 | PromiseLike<T2>) { return Promise.resolve(this.run()).then(ok, bad); }
  private run() {
    const rows = tables[this.table];
    const matches = () => rows.filter((r) => this.filters.every((f) => f(r)));
    let out: Row[] = [];
    if (this.op === "insert" || this.op === "upsert") {
      for (const p of Array.isArray(this.payload) ? this.payload : [this.payload]) {
        const row = { id: randomUUID(), created_at: new Date().toISOString(), ...p };
        const dupe = this.op === "upsert" && rows.find((r) => (r.id && r.id === row.id) || (r.project_id && r.short_id && r.project_id === row.project_id && r.short_id === row.short_id));
        if (dupe) Object.assign(dupe, p);
        else rows.push(row);
        out.push(dupe ?? row);
      }
    } else if (this.op === "update") {
      out = matches();
      for (const r of out) Object.assign(r, this.payload);
    } else if (this.op === "delete") {
      out = matches();
      tables[this.table] = rows.filter((r) => !out.includes(r));
    } else out = matches();
    for (const { col, asc } of [...this.orders].reverse()) out = [...out].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (asc ? 1 : -1));
    if (this.lim !== Infinity) out = out.slice(0, this.lim);
    const clone = JSON.parse(JSON.stringify(out));
    if (this.mode === "single") return { data: clone[0] ?? null, error: clone[0] ? null : { message: "no row" } };
    if (this.mode === "maybe") return { data: clone[0] ?? null, error: null };
    return { data: clone, error: null };
  }
}
const fakeDb: any = {
  from: (t: string) => new Query(t),
  storage: {
    from: () => ({
      upload: async (key: string, blob: Blob | string) => { storage.set(key, typeof blob === "string" ? blob : await blob.text()); return { data: { path: key }, error: null }; },
      download: async (key: string) => (storage.has(key) ? { data: new Blob([storage.get(key)!]), error: null } : { data: null, error: { message: "not found" } }),
      getPublicUrl: (key: string) => ({ data: { publicUrl: `http://fake.local/${key}` } }),
    }),
  },
};

// ───────────── fake model server ─────────────
const planObj = {
  title: "Superbio Invoice Demo", summary: "A single-page printable invoice for Superbio.", direction: "Classical: serif type, restrained, gold accent #b68235 on warm white.",
  sections: [{ name: "Header", detail: "Superbio Studio, address, invoice SB-2047" }, { name: "Items", detail: "Five rows with quantity, rate and amount" }, { name: "Totals", detail: "Subtotal, tax, deposit, balance due" }],
  files: ["Superbio Invoice Demo.html"], notes: "One page, @page A4.",
};
const pageHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Superbio Invoice</title><style>body{font:15px/1.5 Georgia,serif;margin:0;padding:32px;background:#fbf9f4;color:#1f1b16}h1{font-size:28px;margin:0 0 4px}table{width:100%;border-collapse:collapse;margin-top:24px}td,th{padding:10px 6px;border-bottom:1px solid #d9d2c3;text-align:left}.n{text-align:right}.due{margin-top:24px;padding:16px;border:1px solid #b68235;background:#f4ead4;display:flex;justify-content:space-between;font-size:20px}</style></head><body><h1>Superbio Studio</h1><p>418 Meridian Lane, Portland, OR 97209 · Invoice SB-2047 · Issued 9 Oct 2026 · Due 8 Nov 2026</p><table><thead><tr><th>Description</th><th class="n">Qty</th><th class="n">Rate</th><th class="n">Amount</th></tr></thead><tbody><tr><td>Brand identity refinement</td><td class="n">1</td><td class="n">$4,780.00</td><td class="n">$4,780.00</td></tr><tr><td>Compostable pouch dieline</td><td class="n">3</td><td class="n">$950.00</td><td class="n">$2,850.00</td></tr><tr><td>Label artwork per SKU</td><td class="n">4</td><td class="n">$420.00</td><td class="n">$1,680.00</td></tr></tbody></table><div class="due"><span>Balance due</span><strong>$7,310.00</strong></div><p>${"Payment is due within thirty days of the issue date by bank transfer, card or check. ".repeat(6)}</p></body></html>`;

const requests: { kind: string; reply: string }[] = [];
function sse(res: http.ServerResponse, chunks: any[]) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const c of chunks) res.write(`data: ${JSON.stringify({ choices: [{ delta: c, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
  res.end();
}
/** Streams reasoning for `ms`, then the given chunks: a model that always thinks before acting. */
async function sseReasoning(res: http.ServerResponse, ms: number, chunks: any[]) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const end = Date.now() + ms;
  while (Date.now() < end && !res.destroyed) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Let me think about the layout and the palette. " }, finish_reason: null }] })}\n\n`);
    await new Promise((r) => setTimeout(r, 150));
  }
  if (res.destroyed) return false;
  for (const c of chunks) res.write(`data: ${JSON.stringify({ choices: [{ delta: c, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  res.end();
  return true;
}
const toolCall = (name: string, args: object) => [{ tool_calls: [{ index: 0, id: "call_" + randomUUID().slice(0, 8), type: "function", function: { name, arguments: JSON.stringify(args) } }] }];
const modelServer = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", async () => {
    const body = JSON.parse(b);
    const msgs: any[] = body.messages ?? [];
    const text = msgs.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
    const last = String(msgs[msgs.length - 1]?.content ?? "");
    const toolNames: string[] = (body.tools ?? []).map((t: any) => t.function.name);
    const reply = (kind: string, chunks: any[], note = "") => { requests.push({ kind, reply: note }); sse(res, chunks); };
    // the fresh writing session: no tools, its own short system prompt, the page comes back as plain HTML
    const writer = !toolNames.length && String(msgs[0]?.content ?? "").startsWith("You write one complete, self-contained HTML document");
    if (writer) {
      const better = pageHtml.replace("<h1>Superbio Studio</h1>", "<h1>Superbio Studio</h1><p class=\"tag\">Redesigned</p>");
      requests.push({ kind: "writer", reply: `${JSON.stringify(body).length} chars in` });
      if (scenario === "thinks-then-writes" || scenario === "edit-reasons") { await sseReasoning(res, 1000, [{ content: better }]); return; }
      return sse(res, [{ content: better }]);
    }
    // reviewer (screenshots, no tools)
    if (!toolNames.length) return reply("review", [{ content: JSON.stringify({ issues: [], overall: "Looks good." }) }], "json review");
    const planning = text.includes("## This step: planning");
    const building = text.includes("## This step: building");
    const checking = text.includes("## This step: checking") || text.includes("An automatic check");
    const nudged = /You answered in text|Stop thinking and write|You've thought enough/.test(last);
    if (scenario === "thinks-then-writes") {
      if (planning) return reply("plan", toolCall("submit_plan", { ...planObj, files: ["Invoice Demo.html"] }), "submit_plan tool call");
      // building or editing inside the full conversation: it never stops reasoning
      const finished = await sseReasoning(res, 60_000, [{ content: "…" }]);
      requests.push({ kind: finished ? "reasoned" : "cut", reply: "" });
      return;
    }
    if (scenario === "edit-reasons") {
      const ms = Number(process.env.REASON_MS ?? 3000);
      const afterTool = msgs[msgs.length - 1]?.role === "tool";
      const better = pageHtml.replace("background:#fbf9f4", "background:#f6f1e6").replace("<h1>Superbio Studio</h1>", "<h1>Superbio Studio</h1><p class=\"tag\">Redesigned</p>");
      const [kind, chunks] = afterTool ? ["done", [{ content: "Redesigned the invoice." }]]
        : planning ? ["plan", toolCall("submit_plan", { ...planObj, files: ["Invoice Demo.html"] })]
        : ["write", toolCall("write_file", { path: "Invoice Demo.html", content: better })];
      const finished = await sseReasoning(res, ms, chunks as any[]);
      requests.push({ kind: finished ? kind : "cut", reply: "" });
      return;
    }
    if (scenario === "prose-only") return reply("prose", [{ content: "Sure, I will design a classic invoice with a serif look and a gold accent, and it will print on one page." }], "prose only");
    if (planning) {
      if (scenario === "thinks-long" && !nudged) { await new Promise((r) => setTimeout(r, 3500)); }
      if ((scenario === "dumps-text" || scenario === "dumps-forever") && (scenario === "dumps-forever" || !nudged))
        return reply("plan", [{ content: "**Planning**  \nI'll build a clean printable invoice.\n\n**submit_plan**  \n```json\n" + JSON.stringify(planObj, null, 2) + "\n```" }], "plan as chat text");
      return reply("plan", toolCall("submit_plan", planObj), "submit_plan tool call");
    }
    const afterTool = msgs[msgs.length - 1]?.role === "tool";
    if (building && afterTool) {
      // after saving the file, a careless model pastes it again in its final answer
      if (scenario === "dumps-text") return reply("build-done", [{ content: "I saved it. Here is the code again:\n```html\n" + pageHtml + "\n```" }], "page pasted again after saving");
      return reply("build-done", [{ content: "Built the invoice." }], "done");
    }
    if (scenario === "stalls-mid-answer" && building && !afterTool) {
      const resumed = /The first (\d+) characters are saved/.exec(text);
      if (resumed) return reply("append-rest", toolCall("append_file", { path: "Superbio Invoice Demo.html", content: pageHtml.slice(Number(resumed[1])) }), "append_file with the rest");
      // half of the write_file call, then silence (the connection stays open)
      requests.push({ kind: "stall", reply: "" });
      const args = JSON.stringify({ path: "Superbio Invoice Demo.html", content: pageHtml });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_stall", type: "function", function: { name: "write_file", arguments: "" } }] }, finish_reason: null }] })}\n\n`);
      for (let i = 0; i < Math.floor(args.length * 0.6); i += 300) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(i, Math.min(i + 300, Math.floor(args.length * 0.6))) } }] }, finish_reason: null }] })}\n\n`);
        await new Promise((r) => setTimeout(r, 300));
      }
      return;
    }
    if (building && !toolNames.includes("check_design")) {
      if (scenario === "dumps-text" || scenario === "dumps-forever") return reply("build", [{ content: "Here is the invoice:\n\n```html\n" + pageHtml + "\n```\n\nLet me know if you want changes." }], "page as chat text");
      return reply("build", toolCall("write_file", { path: "Superbio Invoice Demo.html", content: pageHtml }), "write_file tool call");
    }
    if (building && /Superbio Invoice Demo/.test(text) && /write_file|append_file/.test(text)) return reply("build-done", [{ content: "Built the invoice." }], "done");
    void checking;
    return reply("other", [{ content: "Looks good. The invoice is on the canvas." }], "short reply");
  });
});

// ───────────── drive the real agent ─────────────
async function main() {
  if (real) {
    if (!process.env.NVIDIA_API_KEY) throw new Error("set NVIDIA_API_KEY to run against real models");
  } else {
    await new Promise<void>((r) => modelServer.listen(PORT, r));
    process.env.NVIDIA_BASE_URL = `http://localhost:${PORT}`; process.env.NVIDIA_API_KEY = "test";
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://fake.local"; process.env.SUPABASE_SERVICE_ROLE_KEY = "test";
  process.env.CHROMIUM_PATH ??= "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (scenario === "stalls-mid-answer") { process.env.IDLE_TIMEOUT_MS ??= "3000"; process.env.TOOL_IDLE_TIMEOUT_MS ??= "3000"; }
  if (!real) { process.env.THINK_LIMIT_MS ??= "2000"; process.env.WRITER_THINK_MS ??= "2000"; process.env.PLAN_THINK_MS ??= "30000"; }
  // A short turn budget so a loop shows up in seconds rather than minutes (each invocation is one "turn").
  if (scenario === "edit-reasons" || scenario === "thinks-then-writes") process.env.TURN_BUDGET_MS ??= process.env.EDIT_MESSAGE ? "130000" : "45000";
  const { runTurn } = await import("../lib/agent");

  const projectId = randomUUID();
  tables.projects.push({ id: projectId, title: "Create an invoice demo for Superbio", template: "blank", model_profile: process.env.MODEL ?? (["thinks-then-writes", "edit-reasons", "glm-build", "real"].includes(scenario) ? "glm" : "gpt-oss"), design_system_id: null, goal: "Create an invoice demo for Superbio", status: "idle", budget: { tokensLeft: 200000, searchesLeft: 40, rounds: 0, maxRounds: 3 }, settings: {}, codebase: null, run_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  tables.messages.push({ id: randomUUID(), project_id: projectId, role: "user", content: "Create an invoice demo for Superbio", meta: {}, created_at: new Date(Date.now() - 2000).toISOString() });
  tables.messages.push({ id: randomUUID(), project_id: projectId, role: "user", content: "How deep should this go?\n→ Standard", meta: { answers: { scope: "Standard" } }, created_at: new Date(Date.now() - 1000).toISOString() });
  if (scenario === "edit-reasons" || ((scenario === "thinks-then-writes" || real) && process.env.EDIT_MESSAGE)) {
    // The invoice already exists (v1); the user then asks for a redesign, as in the GLM project.
    storage.set(`${projectId}/v1.html`, process.env.BASE_FILE ? (await import("node:fs")).readFileSync(process.env.BASE_FILE, "utf8") : pageHtml);
    tables.files.push({ id: randomUUID(), project_id: projectId, path: "Invoice Demo.html", version: 1, storage_path: `${projectId}/v1.html`, content_type: "text/html", created_at: new Date(Date.now() - 900).toISOString() });
    tables.messages.push({ id: randomUUID(), project_id: projectId, role: "assistant", content: "Built the invoice.", meta: {}, created_at: new Date(Date.now() - 800).toISOString() });
    tables.messages.push({ id: randomUUID(), project_id: projectId, role: "user", content: process.env.EDIT_MESSAGE ?? "Make the UI better", meta: {}, created_at: new Date(Date.now() - 700).toISOString() });
  }

  const t0 = Date.now();
  const log: string[] = [];
  let invocations = 0, resume = false;
  const maxInvocations = scenario === "edit-reasons" || scenario === "thinks-then-writes" ? 3 : real ? 6 : 8;
  for (; invocations < maxInvocations; invocations++) {
    let sawContinue = false, sawError = false;
    await runTurn(fakeDb, projectId, {
      resume,
      onEvent: (e) => {
        if (e.type === "continue") sawContinue = true;
        if (real) log.push(`  [${((Date.now() - t0) / 1000).toFixed(0)}s]`);
        if (e.type === "error") { sawError = true; log.push(`  ! error: ${(e.payload as any).message}`); }
        if (["phase", "note", "plan", "tool-call", "tool-result", "thought"].includes(e.type)) {
          const p: any = e.payload;
          log.push(`  ${e.type}${p?.name ? " " + p.name : ""}${p?.text ? ": " + String(p.text).slice(0, 90).replace(/\s+/g, " ") : ""}${p?.error ? " ERROR " + String(p.error).slice(0, 80) : ""}`);
        }
      },
    });
    log.push(`-- invocation ${invocations + 1} ended (${sawContinue ? "continue" : sawError ? "error" : "done"})`);
    if (!sawContinue) break;
    resume = true;
  }

  const files = tables.files.filter((f) => f.project_id === projectId);
  const final = tables.messages.filter((m) => m.role === "assistant").pop();
  console.log(`\n=== scenario: ${scenario} ===`);
  console.log(log.join("\n"));
  console.log(`\nmodel requests: ${requests.map((r) => r.kind).join(" > ")}`);
  console.log(`files written: ${files.length ? files.map((f) => `${f.path} v${f.version} (${storage.get(f.storage_path)?.length ?? 0} chars)`).join(", ") : "NONE"}`);
  console.log(`final chat reply: ${JSON.stringify((final?.content ?? "").slice(0, 140))}`);
  console.log(`took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const newest = [...files].sort((a, b) => b.version - a.version)[0];
  if (process.env.OUT_DIR && newest) {
    const fs = await import("node:fs");
    fs.writeFileSync(`${process.env.OUT_DIR}/${newest.path.replace(/[^\w.-]+/g, "_")}`, storage.get(newest.storage_path) ?? "");
    for (const f of files) fs.writeFileSync(`${process.env.OUT_DIR}/v${f.version}-${f.path.replace(/[^\w.-]+/g, "_")}`, storage.get(f.storage_path) ?? "");
  }
  if (real) {
    console.log(`final page: ${newest ? `${newest.path} v${newest.version}, ${(storage.get(newest.storage_path) ?? "").length} chars, ends with </html>: ${/<\/html>\s*$/i.test(storage.get(newest.storage_path) ?? "")}` : "NONE"}`);
    process.exit(newest ? 0 : 1);
  }
  const isEdit = scenario === "edit-reasons" || (scenario === "thinks-then-writes" && !!process.env.EDIT_MESSAGE);
  const wrote = scenario === "edit-reasons" || scenario === "thinks-then-writes" ? !!newest && newest.version >= (isEdit ? 2 : 1) && /Redesigned/.test(storage.get(newest.storage_path) ?? "") : files.length > 0 && (storage.get(files[0].storage_path)?.length ?? 0) > 1000;
  const chatHasCode = /```|<!doctype/i.test(final?.content ?? "");
  modelServer.close();
  const expectFile = scenario !== "prose-only";
  // (saving adds a viewport meta tag and data-el attributes; otherwise the page must be exactly the one the model wrote, in two parts)
  const whole = scenario !== "stalls-mid-answer" || (storage.get(newest?.storage_path ?? "") ?? "").replace(/<meta name="viewport"[^>]*>/, "").replace(/ data-el="[^"]*"/g, "") === pageHtml;
  if (!whole) { const got = (storage.get(newest?.storage_path ?? "") ?? "").replace(/<meta name="viewport"[^>]*>/, "").replace(/ data-el="[^"]*"/g, ""); let i = 0; while (got[i] === pageHtml[i]) i++; console.log(`the saved page isn't the whole page: ${got.length} vs ${pageHtml.length}, at ${i}: ${JSON.stringify(got.slice(i - 30, i + 60))} vs ${JSON.stringify(pageHtml.slice(i - 30, i + 60))}`); }
  const viaWriter = scenario !== "glm-build" || (requests.some((r) => r.kind === "writer") && !requests.some((r) => r.kind === "build"));
  if (!viaWriter) console.log("GLM's page didn't go through the writing session");
  const ok = (expectFile ? wrote && !chatHasCode : !chatHasCode) && whole && viaWriter;
  console.log(ok ? "RESULT: ok" : "RESULT: FAILED (" + (!wrote && expectFile ? "no file saved" : "code was left in the chat") + ")");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
