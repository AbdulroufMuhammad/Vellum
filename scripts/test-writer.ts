// Tests for lib/writer.ts against a fake model server: npx tsx scripts/test-writer.ts
import http from "node:http";

let failed = 0;
const check = (name: string, ok: boolean, extra = "") => { console.log((ok ? "ok   " : "FAIL ") + name + (extra ? "  " + extra : "")); if (!ok) failed++; };

const page = `<!doctype html><html><head><meta charset="utf-8"><title>Invoice</title><style>body{font:15px Georgia,serif}${"/* style */".repeat(60)}</style></head><body><h1>Superbio Studio</h1>${"<p>Line item and payment terms text.</p>".repeat(40)}</body></html>`;
type Mode = "plain" | "fenced" | "prose-then-html" | "truncated" | "reasons-first" | "restates-overlap" | "hangs";
let mode: Mode = "plain";
const seen: any[] = [];
const server = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", async () => {
    const body = JSON.parse(b); seen.push(body);
    const last = String(body.messages[body.messages.length - 1].content);
    const continuing = last.includes("the reply stopped before the end");
    const reminded = last.startsWith("Reply with the complete HTML document only");
    const cut = Math.floor(page.length * 0.55);
    let reasoning = "", text = page;
    if (mode === "fenced") text = "Here it is:\n```html\n" + page + "\n```\nEnjoy.";
    if (mode === "prose-then-html") text = reminded ? page : "I'll create a lovely invoice with a serif header and gold accents.";
    if (mode === "truncated") text = continuing ? page.slice(cut) : page.slice(0, cut);
    if (mode === "restates-overlap") text = continuing ? page.slice(cut - 60) : page.slice(0, cut); // repeats the anchor it was given
    if (mode === "reasons-first") reasoning = "Thinking about the layout. ".repeat(30);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (mode === "hangs") {
      // writes the first part, then goes on so long the turn's deadline is reached
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: page.slice(0, cut) } }] })}\n\n`);
      setTimeout(() => res.end(), 5000);
      return;
    }
    if (reasoning) res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning } }] })}\n\n`);
    for (let i = 0; i < text.length; i += 400) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + 400) } }] })}\n\n`);
    const truncatedFirst = (mode === "truncated" || mode === "restates-overlap") && !continuing;
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: truncatedFirst ? "length" : "stop" }] })}\n\ndata: [DONE]\n\n`);
    res.end();
  });
});

async function main() {
  await new Promise<void>((r) => server.listen(8781, r));
  process.env.NVIDIA_BASE_URL = "http://localhost:8781"; process.env.NVIDIA_API_KEY = "test";
  const { writeDocument, joinContinuation, documentPart } = await import("../lib/writer");
  const run = async (m: Mode, extra: { deadlineMs?: number; resumeFrom?: string } = {}) => {
    mode = m; seen.length = 0;
    let streamed = 0;
    const out = await writeDocument({ model: "glm", request: "Create an invoice demo for Superbio", plan: "Superbio invoice: header, items, totals", notes: "Decided: serif type, gold accent #b68235.", deadline: Date.now() + (extra.deadlineMs ?? 60_000), resumeFrom: extra.resumeFrom, onText: () => streamed++ });
    return { out, streamed, requests: seen.length, first: seen[0] };
  };

  let r = await run("plain");
  check("plain HTML reply is the document", r.out.html === page && r.out.complete && r.requests === 1);
  check("the context is fresh and small: one system and one user message, no tools", r.first.messages.length === 2 && !r.first.tools && r.first.messages[0].role === "system" && JSON.stringify(r.first).length < 8000, `${JSON.stringify(r.first).length} chars`);
  check("the notes and the plan are in the message", /gold accent/.test(r.first.messages[1].content) && /header, items, totals/.test(r.first.messages[1].content));
  check("asks for no thinking (reasoning_effort low is the switch GLM 5.3 honours)", r.first.chat_template_kwargs?.enable_thinking === false && r.first.reasoning_effort === "low");
  check("streams the page to the canvas as it arrives", r.streamed > 3, `${r.streamed} updates`);
  r = await run("fenced");
  check("a fenced reply is unwrapped", r.out.html === page);
  r = await run("prose-then-html");
  check("prose instead of a page gets one reminder, then the page", r.out.html === page && r.requests === 2);
  r = await run("truncated");
  check("a reply cut off by the output limit is continued in a fresh call", r.out.html === page && r.requests === 2 && r.out.complete);
  check("the continuation call is also small and fresh", seen[1].messages.length === 2 && !seen[1].tools);
  r = await run("restates-overlap");
  check("a continuation that repeats the anchor is joined exactly", r.out.html === page, `${r.out.html.length} vs ${page.length}`);
  r = await run("reasons-first");
  check("reasoning before the page is fine", r.out.html === page);
  const cut = Math.floor(page.length * 0.55);
  r = await run("hangs", { deadlineMs: 1500 });
  check("out of time partway: what's written is kept, marked incomplete", !r.out.complete && r.out.written === page.slice(0, cut), `${r.out.written.length} chars`);
  r = await run("truncated", { resumeFrom: page.slice(0, cut) });
  check("resuming carries on from the saved part without starting over", r.out.html === page && r.out.complete && r.requests === 1 && /stopped before the end/.test(r.first.messages[1].content));

  const head = page.slice(0, 1000), rest = page.slice(1000);
  check("repeating rows don't fool the join (no anchor repeated -> appended as is)", joinContinuation(head, rest) === page);
  check("joinContinuation keeps a restarted full document instead of nesting it", joinContinuation("<!doctype html><html><body><p>a", page) === page);
  check("documentPart drops trailing commentary", documentPart(page + "\nHope this helps!") === page);
  server.close();
  console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
