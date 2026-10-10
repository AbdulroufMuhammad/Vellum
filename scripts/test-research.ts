/** Checks the research depth logic: the template's own steps never pick a depth, and only the form sets one. */
import assert from "node:assert/strict";
import { depthFromAnswers, depthHint, withDepthQuestion, RESEARCH_DEPTHS } from "@/lib/research";
import { getTemplate } from "@/lib/templates";
import { cleanSplit, findingsText } from "@/lib/researchOrchestrator";
import { salvageToolCall } from "@/lib/salvage";

const steps = getTemplate("research").prefill?.steps ?? [];
const [quick, standard, deep, book] = RESEARCH_DEPTHS;

// The request that skipped the form: the template's steps mention "a quick overview".
const request = `Research .create an extensive book on system design like it would be used to teach a donkey full book no skipping .\n\nProcess:\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
assert.equal(depthHint(request, steps)?.key, "book");
assert.equal(depthHint(`Research remote work.\n\n${steps.join("\n")}`, steps), null);
assert.equal(depthHint("a quick look at EV sales", steps)?.key, "quick");
assert.equal(depthHint("about 8 pages", steps)?.key, "deep");
assert.equal(depthHint("an in-depth review", steps)?.key, "deep");

// Only form answers set the depth; old labels still count.
assert.equal(depthFromAnswers([]), null);
assert.equal(depthFromAnswers([{ depth: book.label }])?.key, "book");
assert.equal(depthFromAnswers([{ depth: "Standard report (3–5 pages, about 10 sources)" }])?.key, "standard");
assert.equal(depthFromAnswers([{ depth: "a whole book please" }])?.key, "book");
assert.equal(depthFromAnswers([{ focus: "Caching" }]), null);

// The form always leads with the standard depth question, preselecting the hint.
const form = withDepthQuestion([{ id: "level", question: "How detailed should it be?", type: "single", options: ["a", "b"] } as any, { id: "focus", question: "Focus areas?", type: "multi", options: ["x"] } as any], book);
assert.equal(form[0].id, "depth");
assert.equal(form[0].default, book.label);
assert.equal(form.length, 2);
assert.equal(withDepthQuestion([], null)[0].default, standard.label);

// The orchestrator's split.
const st = cleanSplit({ parts: [{ question: "What is caching?", focus: "CDNs" }, "How do load balancers work?", { question: "" }] }, deep);
assert.equal(st.questions.length, 2);
assert.equal(st.questions[1].question, "How do load balancers work?");
assert.throws(() => cleanSplit({ parts: [] }, quick));
st.questions[0].findings = "Caches store copies [S1].";
assert.match(findingsText(st), /Part 1: What is caching\?\nCaches store copies \[S1\]\./);
assert.match(findingsText(st), /no findings saved/);

// Parts listed in the chat are recovered.
const listed = salvageToolCall(`Here is the split for this request, chapter by chapter, so each researcher knows its scope:\n1. What is system design and why it matters?\n2. Scaling: vertical vs horizontal\n3. Caching strategies and CDNs\n4. Databases, replication and sharding`, { phase: "split", hasPlan: false, wroteFile: false, filePath: "x.html" });
assert.equal(listed?.name, "split_research");
assert.equal((listed?.args.parts as any[]).length, 4);

console.log("research tests passed");
