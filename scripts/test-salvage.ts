// Regression test for lib/salvage.ts: npx tsx scripts/test-salvage.ts
import { htmlFromText, missingCallNudge, planFromText, replyWithoutCode, salvageToolCall } from "../lib/salvage";

let failed = 0;
const check = (name: string, ok: boolean, extra = "") => { console.log((ok ? "ok   " : "FAIL ") + name + (extra ? "  " + extra : "")); if (!ok) failed++; };

// The shape of the real reply that ended a GPT-OSS planning step: the plan written as chat text.
const plan = { title: "Superbio Invoice Demo", summary: "A single-page printable invoice for Superbio Inc.", direction: "Classical: serif, restrained, gold accent #b68235", sections: [{ name: "Header", detail: "Logo, company address, invoice number" }, { name: "Items", detail: "Five rows with quantities and rates" }], files: ["Superbio Invoice Demo.html"], notes: "Include @page for A4." };
const planReply = `**Planning**  \nI'll build a clean, printable invoice for Superbio Inc. using the Classical design system with serif typography, for a biotech client.\n\n**submit_plan**  \n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\``;
const got = planFromText(planReply);
check("recovers a plan from a fenced json block", !!got && got.title === plan.title && Array.isArray(got.sections));
check("recovers a plan wrapped as {plan: ...}", !!planFromText("Here:\n```json\n" + JSON.stringify({ plan }) + "\n```\n" + "x".repeat(10)));
check("recovers a bare json plan with braces inside strings", !!planFromText(`I think this works: ${JSON.stringify({ ...plan, notes: "use {braces} and \"quotes\" } safely" })} done.`));
check("ignores json that isn't a plan", planFromText("```json\n{\"a\": 1, \"b\": [1,2]}\n```") === null);

const html = `<!doctype html><html><head><title>Invoice</title><style>body{font:14px serif}${"/* filler */".repeat(80)}</style></head><body><h1>Invoice SB-2047</h1><p>${"Line item text. ".repeat(40)}</p></body></html>`;
check("recovers a page from a fenced html block", htmlFromText("Here is the file:\n```html\n" + html + "\n```\nHope it helps.") === html);
check("recovers a page from an unterminated fence (cut off reply)", !!htmlFromText("```html\n" + html.slice(0, html.length - 20)));
check("recovers a bare page", !!htmlFromText("Sure.\n" + html));
check("ignores a short snippet", htmlFromText("```html\n<div>hi</div>\n```") === null);

const ctxPlan = { phase: "plan", hasPlan: false, wroteFile: false, filePath: "Superbio Invoice Demo.html" };
const c1 = salvageToolCall(planReply, ctxPlan);
check("planning reply -> submit_plan call", c1?.name === "submit_plan" && (c1.args as any).files[0] === "Superbio Invoice Demo.html");
check("planning reply is left alone once a plan exists", salvageToolCall(planReply, { ...ctxPlan, hasPlan: true }) === null);
const c2 = salvageToolCall("```html\n" + html + "\n```", { phase: "build", hasPlan: true, wroteFile: false, filePath: "Superbio Invoice Demo.html" });
check("build reply with a page -> write_file call", c2?.name === "write_file" && (c2.args as any).path === "Superbio Invoice Demo.html" && String((c2.args as any).content).startsWith("<!doctype html>"));
check("a page is not salvaged once a file was written", salvageToolCall("```html\n" + html + "\n```", { phase: "build", hasPlan: true, wroteFile: true, filePath: "x.html" }) === null);
check("a page is not salvaged over an existing design (edit step)", salvageToolCall("```html\n" + html + "\n```", { phase: "edit", hasPlan: false, wroteFile: false, filePath: "x.html" }) === null);
check("a normal short reply is never salvaged", salvageToolCall("Done. It's on the canvas.", { phase: "build", hasPlan: true, wroteFile: false, filePath: "x.html" }) === null);

check("plan step with no plan gets a nudge to call submit_plan", /submit_plan/.test(missingCallNudge({ phase: "plan", hasPlan: false, wroteFile: false }) ?? ""));
check("build step with nothing written gets a nudge to call write_file", /write_file/.test(missingCallNudge({ phase: "build", hasPlan: true, wroteFile: false }) ?? ""));
check("no nudge once the work is done", missingCallNudge({ phase: "build", hasPlan: true, wroteFile: true }) === null && missingCallNudge({ phase: "plan", hasPlan: true, wroteFile: false }) === null);

check("code is stripped from the reply once a file was written", replyWithoutCode("I saved it. Here is the code again:\n```html\n" + html + "\n```", true) === "I saved it. Here is the code again:");
check("a reply that was only code becomes one sentence", replyWithoutCode("```html\n" + html + "\n```", true) === "Done. It's on the canvas.");
check("small snippets and prose are kept", replyWithoutCode("Changed the heading:\n```css\nh1{color:red}\n```\nThat's it.", true).includes("h1{color:red}"));
check("nothing is stripped when no file was written", replyWithoutCode("```html\n" + html + "\n```", false).includes("<!doctype"));
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
