import { parse, HTMLElement } from "node-html-parser";
import type { Source } from "@/lib/tools/tavily";

const PARSE = { comment: true, blockTextElements: { script: true, style: true, noscript: true, pre: true, textarea: true } };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const host = (u: string) => u.replace(/^https?:\/\//, "").split("/")[0];

/** Elements Edit mode can select and change; each gets a stable data-el id. */
const EDITABLE = "h1, h2, h3, h4, h5, h6, p, li, blockquote, figcaption, caption, td, th, dt, dd, button, a, label, small";

const CITE_CSS = `sup.cite{font:600 10px/1 ui-monospace,monospace;background:rgba(127,127,127,.18);padding:1px 4px;border-radius:4px;margin-left:2px;cursor:pointer}
#ds-sources{max-width:880px;margin:48px auto 32px;padding:16px 24px 0;border-top:1px solid rgba(127,127,127,.3);font:12px/1.5 ui-sans-serif,system-ui,sans-serif;opacity:.85}
#ds-sources .label{display:block;margin-bottom:8px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.7}
#ds-sources ol{margin:0;padding-left:20px}
#ds-sources .url{opacity:.6;word-break:break-all}`;

function ensureDocument(html: string) {
  let root = parse(html, PARSE);
  if (!root.querySelector("html")) root = parse(`<!doctype html><html><head></head><body>${html}</body></html>`, PARSE);
  const doc = root.querySelector("html")!;
  if (!doc.querySelector("head")) doc.insertAdjacentHTML("afterbegin", "<head></head>");
  if (!doc.querySelector("body")) {
    const head = doc.querySelector("head")!;
    const rest = doc.childNodes.filter((n) => n !== head);
    rest.forEach((n) => doc.removeChild(n));
    const body = parse("<body></body>").querySelector("body")!;
    rest.forEach((n) => body.appendChild(n));
    doc.appendChild(body);
  }
  return root;
}

const EM_DASH = /—|&mdash;|&#8212;|&#x2014;/gi;

/**
 * Models lean on em dashes heavily; the design rules forbid them in copy, and
 * this catches the ones that slip through: a range dash between numbers,
 * a comma anywhere else.
 */
export function removeEmDashes(text: string) {
  if (!EM_DASH.test(text)) return text;
  EM_DASH.lastIndex = 0;
  return text
    .replace(/(\d)\s*(?:—|&mdash;|&#8212;|&#x2014;)\s*(\d)/gi, "$1–$2")
    // A dash opening a line ("— Author") just goes; one with a space before it continues a sentence
    // (often right after <strong>…</strong>, where the text node starts " — from"), so it becomes ", ".
    .replace(/(^|[>\n])(?:—|&mdash;|&#8212;|&#x2014;)\s*/gi, "$1")
    .replace(/\s*(?:—|&mdash;|&#8212;|&#x2014;)\s*/gi, ", ");
}

function cleanCopy(node: HTMLElement) {
  for (const child of node.childNodes) {
    if (child instanceof HTMLElement) {
      if (!["SCRIPT", "STYLE", "TEXTAREA", "PRE", "CODE"].includes(child.tagName)) cleanCopy(child);
    } else if (child.nodeType === 3 && EM_DASH.test(child.rawText)) {
      EM_DASH.lastIndex = 0;
      (child as any).rawText = removeEmDashes(child.rawText);
    }
    EM_DASH.lastIndex = 0;
  }
}

/**
 * In SVG, a CSS `transform` (e.g. from an animation) replaces the element's
 * transform attribute instead of adding to it, so `<g class="dancer"
 * transform="translate(596,258)">` with an animated .dancer jumps to 0,0.
 * Models write this constantly. Fix: move the attribute to a new wrapper
 * group, so the position and the animation compose.
 */
function fixSvgTransforms(root: HTMLElement) {
  const css = root.querySelectorAll("style").map((s) => s.rawText).join("\n");
  if (!css) return;
  const animated = (sel: string) => {
    const re = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])[^{]*\\{[^}]*\\b(animation|transform)\\s*:`);
    return re.test(css);
  };
  for (const el of root.querySelectorAll("svg [transform]")) {
    const transform = el.getAttribute("transform");
    if (!transform || el.tagName === "SVG") continue;
    const classes = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
    const id = el.getAttribute("id");
    const targeted = classes.some((c) => animated(`.${c}`)) || (!!id && animated(`#${id}`));
    if (!targeted) continue;
    el.removeAttribute("transform");
    const wrapper = parse(`<g transform="${transform.replace(/"/g, "&quot;")}"></g>`, PARSE).querySelector("g")!;
    el.parentNode.exchangeChild(el, wrapper);
    wrapper.appendChild(el);
  }
}

function inSvg(el: HTMLElement) {
  return !!el.closest("svg");
}

function assignIds(root: HTMLElement) {
  const used = new Set(root.querySelectorAll("[data-el]").map((e) => e.getAttribute("data-el")!));
  let n = 1;
  for (const el of root.querySelectorAll(EDITABLE)) {
    if (el.getAttribute("data-el") || inSvg(el) || el.closest("#ds-sources")) continue;
    while (used.has(`e${n}`)) n++;
    el.setAttribute("data-el", `e${n}`);
    used.add(`e${n}`);
  }
}

/** [S3] / [S3, S5] → numbered <sup class="cite">, plus a sources list for whatever was cited. */
function citations(root: HTMLElement, sources: Map<string, Source>) {
  const body = root.querySelector("body")!;
  body.querySelectorAll("#ds-sources").forEach((n) => n.remove());
  const walk = (node: HTMLElement) => {
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes[i];
      if (child instanceof HTMLElement) {
        if (!["SCRIPT", "STYLE", "TEXTAREA", "PRE", "CODE", "SVG"].includes(child.tagName)) walk(child);
      } else if (child.nodeType === 3 && /\[S\d+/.test(child.rawText)) {
        const html = child.rawText.replace(/\[(S\d+(?:\s*[,;]\s*S\d+)*)\]/g, (_m, ids: string) =>
          ids
            .split(/[,;]/)
            .map((id) => `<sup class="cite" data-src="${id.trim()}"></sup>`)
            .join("")
        );
        if (html === child.rawText) continue;
        const nodes = parse(html, PARSE).childNodes;
        for (const n of nodes) n.parentNode = node;
        node.childNodes.splice(i, 1, ...nodes);
        i += nodes.length - 1;
      }
    }
  };
  walk(body);

  const order: string[] = [];
  for (const sup of body.querySelectorAll("sup.cite")) {
    const id = sup.getAttribute("data-src") ?? "";
    if (!sources.has(id)) {
      sup.remove();
      continue;
    }
    if (!order.includes(id)) order.push(id);
    sup.set_content(String(order.indexOf(id) + 1));
  }
  const head = root.querySelector("head")!;
  head.querySelectorAll("#ds-cite-css").forEach((n) => n.remove());
  if (!order.length) return;
  const items = order
    .map((id) => {
      const s = sources.get(id)!;
      return `<li data-src="${id}">${esc(s.title || host(s.url))} <span class="url">${esc(s.url)}</span></li>`;
    })
    .join("");
  body.insertAdjacentHTML("beforeend", `<footer id="ds-sources"><span class="label">Sources</span><ol>${items}</ol></footer>`);
  head.insertAdjacentHTML("beforeend", `<style id="ds-cite-css">${CITE_CSS}</style>`);
}

/** Runs on every write of a design file. */
/**
 * A printable design (one with an @page rule) keeps its designed layout on
 * paper. A printed Letter page is only ~690px wide inside its margins, so a
 * phone breakpoint like `@media (max-width: 760px)` also fires in print and
 * collapses a two-column résumé into one long column over several pages.
 * Width-only media queries are therefore limited to screens.
 */
export function screenOnlyBreakpoints(css: string) {
  if (!/@page\b/i.test(css)) return css;
  const feature = String.raw`\(\s*(?:(?:min|max)-)?(?:device-)?width\s*[:<>=][^)]*\)`;
  const query = new RegExp(String.raw`@media\s+(${feature}(?:\s+and\s+${feature})*)\s*\{`, "gi");
  return css.replace(query, "@media screen and $1 {");
}

function printLayout(root: HTMLElement) {
  for (const style of root.querySelectorAll("style")) {
    const css = style.rawText;
    const fixed = screenOnlyBreakpoints(css);
    if (fixed !== css) style.set_content(fixed);
  }
}

const MODULE_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const IMPORT_STMT = /^[ \t]*import\s+(?:[\s\S]*?\s+from\s*)?["'][^"']+["'][ \t]*;?[ \t]*$/gm;
const TOP_DECL = /^(?:export\s+)?(?:const|let|var|class|function\*?|async\s+function\*?)\s+([A-Za-z_$][\w$]*)/gm;

/** The local names a module's import statements bind. */
function importNames(stmt: string) {
  const clause = /import\s+([\s\S]*?)\s+from/.exec(stmt)?.[1] ?? "";
  const names: string[] = [];
  const star = /\*\s+as\s+([\w$]+)/.exec(clause);
  if (star) names.push(star[1]);
  const def = /^\s*([\w$]+)\s*(?:,|$)/.exec(clause);
  if (def) names.push(def[1]);
  const named = /\{([^}]*)\}/.exec(clause)?.[1];
  if (named) for (const part of named.split(",")) { const n = part.trim().split(/\s+as\s+/).pop()?.trim(); if (n) names.push(n); }
  return names;
}

/**
 * A page built in parts sometimes ends up with its code split across several
 * <script type="module"> blocks. Modules don't share variables, so a later one
 * that uses an earlier one's scene, camera or helpers crashes. When that's the
 * case (and merging can't clash), the blocks become one module, with each import
 * kept once, at the last block's place (modules run after parsing either way).
 */
export function joinModuleScripts(html: string): string {
  const blocks: { start: number; end: number; attrs: string; body: string }[] = [];
  for (const m of html.matchAll(MODULE_SCRIPT)) {
    if (!/\btype\s*=\s*["']?module\b/i.test(m[1]) || /\bsrc\s*=/i.test(m[1])) continue;
    blocks.push({ start: m.index!, end: m.index! + m[0].length, attrs: m[1], body: m[2] });
  }
  if (blocks.length < 2) return html;
  const parsed = blocks.map((b) => {
    const imports = b.body.match(IMPORT_STMT) ?? [];
    const code = b.body.replace(IMPORT_STMT, "");
    const decls = [...code.matchAll(TOP_DECL)].map((m) => m[1]);
    for (const m of code.matchAll(/^(?:const|let|var)\s*[{[]([^=]*)[}\]]\s*=/gm)) decls.push(...(m[1].match(/[A-Za-z_$][\w$]*/g) ?? []));
    return { imports: imports.map((i) => i.trim()), code, decls };
  });
  // Only merge when a later block uses something an earlier one declared (so it was meant to share scope).
  const uses = (code: string, name: string) => new RegExp(`(^|[^\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(code);
  const needed = parsed.some((b, j) => parsed.slice(0, j).some((a) => a.decls.some((n) => !b.decls.includes(n) && uses(b.code, n))));
  if (!needed) return html;
  // Refuse if merging would declare a name twice.
  const seen = new Map<string, string>();
  for (const b of parsed) {
    for (const n of b.decls) {
      if (seen.has(n)) return html;
      seen.set(n, "decl");
    }
  }
  const imports: string[] = [];
  const bound = new Map<string, string>();
  for (const b of parsed) {
    for (const stmt of b.imports) {
      const key = stmt.replace(/\s+/g, " ").replace(/;$/, "");
      const names = importNames(stmt);
      if (imports.some((i) => i.replace(/\s+/g, " ").replace(/;$/, "") === key)) continue;
      for (const n of names) {
        if (seen.get(n) === "decl" || bound.has(n)) return html;
        bound.set(n, key);
      }
      imports.push(stmt);
    }
  }
  const merged = `<script${blocks[0].attrs}>\n${imports.join("\n")}\n${parsed.map((b) => b.code.trim()).join("\n\n")}\n</script>`;
  let out = "";
  let at = 0;
  blocks.forEach((b, i) => {
    out += html.slice(at, b.start) + (i === blocks.length - 1 ? merged : "");
    at = b.end;
  });
  return out + html.slice(at);
}

/**
 * A document still being written in parts: a <script> or <style> opened and not
 * yet closed. Parsing one of these drops the open tag (its code turns into page
 * text), so it's stored as written until the part that closes it arrives.
 */
export function unfinishedDocument(html: string) {
  const open = (tag: string) => (html.match(new RegExp(`<${tag}\\b`, "gi")) ?? []).length - (html.match(new RegExp(`</${tag}\\s*>`, "gi")) ?? []).length;
  return open("script") > 0 || open("style") > 0;
}

export function finalizeArtifact(html: string, sources: Map<string, Source>): string {
  if (unfinishedDocument(html)) return html;
  const root = ensureDocument(joinModuleScripts(html));
  const head = root.querySelector("head")!;
  if (!head.querySelector("meta[charset]")) head.insertAdjacentHTML("afterbegin", `<meta charset="utf-8">`);
  if (!head.querySelector("meta[name=viewport]"))
    head.insertAdjacentHTML("beforeend", `<meta name="viewport" content="width=device-width, initial-scale=1">`);
  citations(root, sources);
  cleanCopy(root);
  fixSvgTransforms(root);
  printLayout(root);
  assignIds(root);
  const out = root.toString();
  return /^\s*<!doctype/i.test(out) ? out : `<!doctype html>\n${out}`;
}

function sanitizeFragment(html: string) {
  const frag = parse(`<div>${html}</div>`, PARSE).querySelector("div")!;
  frag.querySelectorAll("script, style, iframe, object, embed, link, meta").forEach((n) => n.remove());
  for (const el of frag.querySelectorAll("*")) {
    for (const name of Object.keys(el.attributes)) {
      const v = el.getAttribute(name) ?? "";
      if (/^on/i.test(name) || (/^(href|src|xlink:href|action)$/i.test(name) && /^\s*javascript:/i.test(v))) el.removeAttribute(name);
    }
  }
  return frag.innerHTML;
}

export type ElementEdit = { id: string; html?: string; style?: Record<string, string | number> };

const STYLE_PROPS: Record<string, (v: string | number) => string> = {
  fontSize: (v) => `font-size:${Number(v)}px`,
  lineHeight: (v) => `line-height:${Number(v)}`,
  letterSpacing: (v) => `letter-spacing:${Number(v)}em`,
  marginBottom: (v) => `margin-bottom:${Number(v)}px`,
  fontWeight: (v) => `font-weight:${Number(v)}`,
  color: (v) => (/^#[0-9a-f]{3,8}$/i.test(String(v)) ? `color:${v}` : ""),
  textAlign: (v) => (/^(left|center|right|justify)$/.test(String(v)) ? `text-align:${v}` : ""),
};
const CSS_NAME: Record<string, string> = {
  fontSize: "font-size",
  lineHeight: "line-height",
  letterSpacing: "letter-spacing",
  marginBottom: "margin-bottom",
  fontWeight: "font-weight",
  color: "color",
  textAlign: "text-align",
};

/** Apply Edit-mode changes (inner HTML and/or a few inline styles) to data-el elements. */
export function applyElementEdits(html: string, edits: ElementEdit[]) {
  const root = parse(html, PARSE);
  for (const edit of edits) {
    const el = root.querySelector(`[data-el="${String(edit.id).replace(/[^\w-]/g, "")}"]`);
    if (!el) throw new Error(`element not found: ${edit.id}`);
    if (typeof edit.html === "string") el.set_content(sanitizeFragment(edit.html));
    if (edit.style) {
      const keys = Object.keys(edit.style).filter((k) => k in STYLE_PROPS);
      const drop = new Set(keys.map((k) => CSS_NAME[k]));
      const decl = (el.getAttribute("style") ?? "")
        .split(";")
        .map((d) => d.trim())
        .filter((d) => d && !drop.has(d.split(":")[0].trim().toLowerCase()));
      for (const k of keys) {
        const d = STYLE_PROPS[k](edit.style[k]);
        if (d) decl.push(d);
      }
      el.setAttribute("style", decl.join(";"));
    }
  }
  return root.toString();
}

export type TweakControl = {
  name: string;
  label?: string;
  type: "color" | "range" | "select" | "toggle" | "text";
  value: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: (string | { label: string; value: string })[];
};

/** Persist tweak values into the file's <script id="tweaks"> block so they survive reloads and exports. */
export function applyTweakValues(html: string, values: Record<string, unknown>) {
  const root = parse(html, PARSE);
  const block = root.querySelector('script#tweaks, script[data-tweaks]');
  if (!block) throw new Error("this file has no tweaks");
  const raw = JSON.parse(block.rawText || "[]");
  const list: TweakControl[] = Array.isArray(raw) ? raw : raw.controls ?? [];
  for (const c of list) if (c && c.name in values) c.value = values[c.name] as any;
  block.set_content(JSON.stringify(Array.isArray(raw) ? list : { ...raw, controls: list }, null, 1).replace(/</g, "\\u003c"));
  return root.toString();
}
