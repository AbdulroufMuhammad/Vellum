/** Text-level math fixes shared by the write pipeline (lib/finalize.ts) and the canvas's streamed drafts. */

// A \( \) or \[ \] span on one line that doesn't cross a closing tag.
const MATH_SPAN = /\\\((?:(?!\\\)|<\/)[^\n]){0,400}?\\\)|\\\[(?:(?!\\\]|<\/)[^\n]){0,400}?\\\]/g;

/**
 * Inequalities written tight, like \(0<x<2\), read as HTML ("<x" opens a tag) and swallow the rest of the math before
 * KaTeX sees it. Inside math spans, < and > become entities (KaTeX reads the decoded text); scripts and styles are left
 * alone, where < is code.
 */
// No lookbehind (older Safari can't parse one, and this also runs in the browser): <br> is set aside, then restored.
function escapeSpan(m: string) {
  const brs: string[] = [];
  return m
    .replace(/<br\s*\/?>/gi, (b) => `\u0000${brs.push(b) - 1}\u0000`)
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\u0000(\d+)\u0000/g, (_, n) => brs[Number(n)]);
}

export function escapeMathAngles(html: string) {
  return html
    .split(/(<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>)/i)
    .map((part, i) => (i % 2 ? part : part.replace(MATH_SPAN, escapeSpan)))
    .join("");
}
