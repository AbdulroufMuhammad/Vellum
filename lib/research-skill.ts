/**
 * Real research (targeted search, primary sources, citations), available to any
 * template when the request calls for it — not just the dedicated Research
 * template. Same shape as lib/threeD.ts / lib/cinematic.ts: a detector plus a
 * guide, composed into the system prompt only when it applies.
 */

/** A flat, generous-but-bounded allowance for a template that picked up the skill by heuristic rather than through the Research template's own depth-scoping form. */
export const SKILL_RESEARCH_SOURCES = 12;

/** Whether a request needs real research, regardless of which template it's built in. */
export function wantsResearch(templateId: string, request: string) {
  return (
    templateId === "research" ||
    /\b(research|investigat\w*|compar(e|ison|ing)|competitiv(e|ors?)|analy[sz]e|analysis|benchmark\w*|due diligence|evaluat\w*|\bis\b.{0,40}\b(a good|a bad|worth it|worth buying|safe to|legit)\b|should (i|we)\b|pros and cons|fact[- ]check\w*|survey of|state of the|landscape of|deep dive)\b/i.test(request)
  );
}

/** The agent's playbook for real research: targeted search, primary sources, citations. */
export function researchGuide(sources: number) {
  return `## Research
Search with targeted queries, web_fetch the best sources, then write; stop searching once you can answer at the depth the user chose. Cite every factual sentence as [S3] or [S3, S5] using only IDs you were given; a numbered sources list is added automatically. Never write URLs as citations. This turn's research allowance is ${sources} searches and fetches.
Prefer the primary source over secondhand retellings of it: the original document, paper, filing, dataset, ruling, spec or firsthand statement that the blogs and social posts are themselves summarizing — whatever form that takes for this particular topic (a company's own filing or press release for a business/finance question; the paper itself, not a press writeup, for a scientific one; the statute, ruling or docket for a legal one; the standard or spec for a technical one; a primary account for a historical one). If the first searches return mostly blogs, aggregators and social posts, refine the query toward where the original would actually live — the regulator or registry, the publisher or preprint server, the court or agency, the standards body, the subject's own domain — rather than settling for coverage of coverage. web_fetch reads PDFs as well as HTML, so don't skip a result just because it's a PDF — primary documents very often are.`;
}
