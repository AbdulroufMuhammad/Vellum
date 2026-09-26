import type { SupabaseClient } from "@supabase/supabase-js";
import { chat, type ContentPart, type ModelKey } from "@/lib/gateway";
import { BUCKET } from "@/lib/tools/files";
import { launchBrowser, openDesign } from "@/lib/tools/browser";

const WIDTH = 1280;
const TILE = 1100;
const MAX_TILES = 3;
const REVIEWERS: ModelKey[] = ["omni", "muse"];

export type Automated = {
  jsErrors: string[];
  horizontalOverflow: { desktop: number; mobile: number };
  brokenImages: number;
  lowContrast: { text: string; ratio: number; fg: string; bg: string }[];
  clippedText: string[];
  emptyPage: boolean;
  height: number;
  /** For printable designs (an @page rule): how many pages it prints to, and how many it should. */
  print?: { pages: number; target: [number, number] | null };
  /** For 3D scenes that expose window.__vellum3d: parts attached to nothing, and how the model sits in the frame. */
  threeD?: { parts: number; floating: string[]; cutOff: boolean; tiny: boolean; fill?: number; hook: boolean };
};

export type VisualIssue = { where: string; problem: string; severity: "high" | "medium" | "low" };

export type CheckResult = {
  automated: Automated;
  issues: VisualIssue[];
  overall: string;
  reviewer: string | null;
  screenshotUrl: string | null;
};

/**
 * Runs inside the page: cheap, deterministic checks a screenshot can miss.
 * Plain JS in a string on purpose: bundlers inject helpers into compiled
 * functions that don't exist inside the browser page.
 */
const INSPECT_PAGE = String.raw`(() => {
  const parse = (c) => (String(c).match(/[\d.]+/g) || []).map(Number);
  const lum = (rgb) => {
    const v = rgb.slice(0, 3).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const hex = (rgb) => "#" + rgb.slice(0, 3).map((x) => Math.round(x).toString(16).padStart(2, "0")).join("");
  const background = (el) => {
    while (el) {
      const cs = getComputedStyle(el);
      if (cs.backgroundImage && cs.backgroundImage !== "none") return null;
      const c = parse(cs.backgroundColor);
      if (c.length >= 3 && (c.length < 4 || c[3] > 0.6)) return c;
      el = el.parentElement;
    }
    return [255, 255, 255];
  };
  const lowContrast = [], clippedText = [];
  let scanned = 0;
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    if (scanned > 600) break;
    const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent || "").trim().length > 1);
    if (!own) continue;
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (!rect.width || !rect.height || cs.visibility === "hidden" || Number(cs.opacity) < 0.2) continue;
    scanned++;
    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60);
    const bg = background(el), fg = parse(cs.color);
    if (bg && fg.length >= 3 && (fg.length < 4 || fg[3] > 0.6)) {
      const pair = [lum(fg), lum(bg)].sort((x, y) => y - x);
      const ratio = (pair[0] + 0.05) / (pair[1] + 0.05);
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.5 && Number(cs.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) lowContrast.push({ text, ratio: Math.round(ratio * 100) / 100, fg: hex(fg), bg: hex(bg) });
    }
    const clips = /(hidden|clip)/.test(cs.overflow + cs.overflowX + cs.overflowY) || cs.textOverflow === "ellipsis";
    if (clips && (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 4) && cs.whiteSpace !== "nowrap") clippedText.push(text);
  }
  lowContrast.sort((a, b) => a.ratio - b.ratio);
  return {
    lowContrast: lowContrast.slice(0, 6),
    clippedText: clippedText.slice(0, 6),
    brokenImages: Array.from(document.images).filter((i) => i.complete && i.naturalWidth === 0).length,
    emptyPage: (document.body.innerText || "").trim().length < 20 && !document.querySelector("canvas, svg, img"),
    overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
    height: document.documentElement.scrollHeight,
  };
})()`;

/**
 * Runs in the page for a three.js scene exposed as window.__vellum3d = { THREE, scene, camera, renderer }:
 * finds groups of parts that touch neither the main model nor the ground (floating), and whether the
 * model is cut off by, or tiny in, the frame. Also installs window.__vellumView(i), which points the
 * camera at the model from the front (0), the side (1) or three-quarter above (2) and renders once.
 */
const INSPECT_3D = String.raw`(() => {
  const v = window.__vellum3d;
  if (!v || !v.THREE || !v.scene || !v.camera || !v.renderer) return { hook: false };
  const T = v.THREE;
  v.scene.updateMatrixWorld(true);
  const parts = [], grounds = [];
  const backSide = (o) => [].concat(o.material || []).some((m) => m && m.side === T.BackSide);
  v.scene.traverse((o) => {
    if (!o.isMesh || !o.visible || parts.length > 400) return;
    const u = o.userData || {};
    // Studio sweeps, sky domes and backdrops are scenery, not the model.
    if (u.backdrop || u.environment || backSide(o)) return;
    const box = new T.Box3().setFromObject(o);
    if (box.isEmpty()) return;
    const sz = box.getSize(new T.Vector3());
    (u.ground || sz.y < 1e-4 ? grounds : parts).push({ o, box });
  });
  // A mesh far bigger than everything else that encloses it (a room, a backdrop) is scenery too.
  for (let k = 0; k < 3 && parts.length > 1; k++) {
    let bi = 0;
    parts.forEach((p, i) => { if (p.box.getSize(new T.Vector3()).length() > parts[bi].box.getSize(new T.Vector3()).length()) bi = i; });
    const rest = new T.Box3();
    parts.forEach((p, i) => { if (i !== bi) rest.union(p.box); });
    const big = parts[bi].box;
    if (big.getSize(new T.Vector3()).length() > 3 * rest.getSize(new T.Vector3()).length() && big.containsPoint(rest.getCenter(new T.Vector3()))) parts.splice(bi, 1);
    else break;
  }
  if (!parts.length) return { hook: true, parts: 0, floating: [], cutOff: false, tiny: false, fill: 0 };
  const all = new T.Box3();
  parts.forEach((p) => all.union(p.box));
  const center = all.getCenter(new T.Vector3());
  const radius = Math.max(1e-3, all.getSize(new T.Vector3()).length() / 2);
  const tol = radius * 0.02;
  const n = parts.length, parent = parts.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const grown = parts.map((p) => p.box.clone().expandByScalar(tol));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (grown[i].intersectsBox(parts[j].box)) parent[find(i)] = find(j);
  const onGround = parts.map((p, i) => grounds.some((g) => grown[i].intersectsBox(g.box)) || p.box.min.y <= all.min.y + tol);
  const groups = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); }
  const volume = (idx) => idx.reduce((a, i) => { const s = parts[i].box.getSize(new T.Vector3()); return a + Math.max(s.x, 1e-3) * Math.max(s.y, 1e-3) * Math.max(s.z, 1e-3); }, 0);
  let main = null, best = -1;
  for (const [r, idx] of groups) { const vol = volume(idx); if (vol > best) { best = vol; main = r; } }
  const label = (o) => o.name || (o.parent && o.parent.name) || (o.geometry && o.geometry.type.replace("Geometry", "")) || "part";
  const floating = [];
  for (const [r, idx] of groups) {
    if (r === main || idx.some((i) => onGround[i])) continue;
    const c = parts[idx[0]].box.getCenter(new T.Vector3());
    floating.push(idx.slice(0, 3).map((i) => label(parts[i].o)).join(" + ") + " at (" + [c.x, c.y, c.z].map((x) => x.toFixed(2)).join(", ") + ")");
  }
  // Where the model's real outline lands on screen: its vertices (sampled), not its bounding box, whose corners stick out past a long or rotated model.
  const cam = v.camera;
  cam.updateMatrixWorld(true);
  let minX = 1, maxX = -1, minY = 1, maxY = -1, out = false;
  const p = new T.Vector3();
  const see = (x, y, z) => {
    p.set(x, y, z).project(cam);
    if (p.z > 1 || p.z < -1) return;
    if (Math.abs(p.x) > 1.02 || Math.abs(p.y) > 1.02) out = true;
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  };
  for (const { o, box } of parts) {
    const pos = o.geometry && o.geometry.attributes && o.geometry.attributes.position;
    if (!pos || o.isInstancedMesh || o.isSkinnedMesh) {
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) see(x, y, z);
      continue;
    }
    const step = Math.max(1, Math.floor(pos.count / 60));
    for (let i = 0; i < pos.count; i += step) { p.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); see(p.x, p.y, p.z); }
  }
  // Share of the frame the model spans on its longer side (0 to 1).
  const fill = Math.max(0, Math.max((maxX - minX) / 2, (maxY - minY) / 2));
  const tiny = fill < 0.4;
  window.__vellumView = (i) => {
    const dirs = [[0, 0.15, 1], [1, 0.15, 0], [0.75, 0.6, 0.75]];
    const d = new T.Vector3(...dirs[i]).normalize();
    const fov = ((cam.fov || 45) * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(fov / 2) * (cam.aspect || 1));
    cam.position.copy(center).addScaledVector(d, (radius / Math.sin(Math.min(fov, hfov) / 2)) * 1.05);
    cam.lookAt(center);
    cam.near = Math.min(cam.near, radius / 100);
    cam.far = Math.max(cam.far, radius * 20);
    cam.updateProjectionMatrix();
    v.renderer.render(v.scene, cam);
    const r = v.renderer.domElement.getBoundingClientRect();
    return { x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.min(r.width, innerWidth), height: Math.min(r.height, innerHeight) };
  };
  return { hook: true, parts: n, floating: floating.slice(0, 6), cutOff: out, tiny, fill: Math.round(fill * 100) / 100 };
})()`;

type PageReport = {
  lowContrast: Automated["lowContrast"];
  clippedText: string[];
  brokenImages: number;
  emptyPage: boolean;
  overflow: number;
  height: number;
};

const REVIEW_PROMPT = `You are a meticulous UI reviewer. The images are screenshots of one design, rendered at 1280px wide, shown top to bottom.
List concrete visual problems a user would notice: overlapping or clipped text, broken or misaligned layout, content running off the page, unreadable contrast, missing or broken images/icons, awkward large empty areas, inconsistent spacing or type sizes, placeholder or lorem text, anything that looks unfinished or broken. Say where each one is (section/element) and what is wrong. Don't comment on taste or suggest new features.
Reply with ONLY JSON: {"issues":[{"where":"…","problem":"…","severity":"high"|"medium"|"low"}],"overall":"one sentence"}. An empty issues array means it looks right.`;

function parseReview(text: string): { issues: VisualIssue[]; overall: string } | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const issues = (Array.isArray(j.issues) ? j.issues : [])
      .map((i: any) => ({
        where: String(i.where ?? "").slice(0, 120),
        problem: String(i.problem ?? "").slice(0, 300),
        severity: (["high", "medium", "low"].includes(i.severity) ? i.severity : "medium") as VisualIssue["severity"],
      }))
      .filter((i: VisualIssue) => i.problem)
      .slice(0, 12);
    return { issues, overall: String(j.overall ?? "").slice(0, 300) };
  } catch {
    return null;
  }
}

// ---------- printing ----------

const PAGE_SIZES: Record<string, [number, number]> = { letter: [8.5, 11], legal: [8.5, 14], a4: [8.27, 11.69], a5: [5.83, 8.27], a3: [11.69, 16.54], tabloid: [11, 17] };

/** A CSS length in inches (in, cm, mm, pt, px; bare numbers are px). */
function inches(v: string): number | null {
  const m = /^(-?[\d.]+)(in|cm|mm|pt|px|pc)?$/i.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return { in: n, cm: n / 2.54, mm: n / 25.4, pt: n / 72, pc: n / 6, px: n / 96 }[(m[2] ?? "px").toLowerCase() as "in"] ?? null;
}

/** Printable width and height of a page in CSS px, from the design's first @page rule (Letter with ~0.4in margins by default). */
function printArea(html: string): { width: number; height: number } {
  const rule = /@page\s*(?::\w+\s*)?\{([^}]*)\}/i.exec(html)?.[1] ?? "";
  let [w, h] = PAGE_SIZES.letter;
  const size = /(?:^|;)\s*size\s*:\s*([^;]+)/i.exec(rule)?.[1]?.trim().toLowerCase();
  if (size) {
    const named = size.split(/\s+/).find((t) => PAGE_SIZES[t]);
    const dims = size.split(/\s+/).map(inches).filter((x): x is number => x != null);
    if (named) [w, h] = PAGE_SIZES[named];
    else if (dims.length) [w, h] = [dims[0], dims[1] ?? dims[0]];
    if (/landscape/.test(size)) [w, h] = [Math.max(w, h), Math.min(w, h)];
  }
  const margin = /(?:^|;)\s*margin\s*:\s*([^;]+)/i.exec(rule)?.[1];
  const m = (margin ? margin.trim().split(/\s+/).map(inches) : []).map((x) => x ?? 0.4);
  const [top, right, bottom, left] = m.length === 1 ? [m[0], m[0], m[0], m[0]] : m.length === 2 ? [m[0], m[1], m[0], m[1]] : m.length === 3 ? [m[0], m[1], m[2], m[1]] : m.length === 4 ? m : [0.4, 0.4, 0.4, 0.4];
  return { width: Math.round((w - left - right) * 96), height: Math.round((h - top - bottom) * 96) };
}

/** The page count a design declares with <meta name="pages" content="1"> or "3-5". */
export function declaredPages(html: string): [number, number] | null {
  const tag = /<meta[^>]+name=["']pages["'][^>]*>/i.exec(html)?.[0];
  const m = tag && /content=["']\s*(\d+)\s*(?:[-–]\s*(\d+))?/i.exec(tag);
  if (!m) return null;
  const lo = Number(m[1]);
  return [lo, Math.max(lo, Number(m[2] ?? lo))];
}

export const isPrintable = (html: string) => /@page\b/i.test(html);

// Chromium writes each page as its own "/Type /Page" object.
const countPdfPages = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;

const RENDER_TIMEOUT_MS = 35_000;
const REVIEW_TIMEOUT_MS = 40_000;

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))]).finally(() => clearTimeout(timer));
}

async function render(html: string, printTarget: [number, number] | null): Promise<{ automated: Automated; tiles: Buffer[]; printTiles: Buffer[]; views: Buffer[] }> {
  // Step timings go to the server log, so a slow check can be traced to the step that's slow.
  const t0 = Date.now();
  const laps: string[] = [];
  const lap = (step: string) => laps.push(`${step} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const browser = await launchBrowser();
  lap("launch");
  const tiles: Buffer[] = [];
  const printTiles: Buffer[] = [];
  const views: Buffer[] = [];
  let threeD: Automated["threeD"];
  // A known page target (a résumé, a research depth) is checked even if the design forgot its @page rule.
  const printable = isPrintable(html) || !!printTarget || !!declaredPages(html);
  try {
    const jsErrors: string[] = [];
    const page = await openDesign(browser, html, { width: WIDTH, height: 800 }, (msg) => jsErrors.push(msg));
    lap("open");
    // Canvas and WebGL scenes: give them a moment to draw, then stop their animation loops. Software WebGL on the
    // server runs at a few frames a second, and an endless render loop starves the screenshots until they time out.
    if (/<canvas|three|webgl|requestAnimationFrame/i.test(html)) {
      await page.waitForTimeout(2500);
      await page.evaluate("window.requestAnimationFrame = () => 0").catch(() => {});
      await page.waitForTimeout(300);
    }
    lap("settle");
    const desktop = (await page.evaluate(INSPECT_PAGE)) as PageReport;
    lap("inspect");
    const height = Math.min(desktop.height, TILE * (printable ? 2 : MAX_TILES));
    for (let y = 0; y < height; y += TILE) {
      const shot = await page
        .screenshot({ type: "jpeg", quality: 65, fullPage: true, timeout: 12_000, clip: { x: 0, y, width: WIDTH, height: Math.min(TILE, height - y) } })
        .catch((e: Error) => {
          laps.push(`screenshot failed: ${e.message.split("\n")[0].slice(0, 160)}`);
          return null;
        });
      if (!shot) break;
      tiles.push(shot);
    }
    // Full-page capture can fail in the serverless browser (WebGL pages especially); a plain viewport shot still shows the design.
    if (!tiles.length) {
      const shot = await page.screenshot({ type: "jpeg", quality: 65, timeout: 12_000 }).catch((e: Error) => {
        laps.push(`viewport screenshot failed: ${e.message.split("\n")[0].slice(0, 160)}`);
        return null;
      });
      if (shot) tiles.push(shot);
    }
    lap(`screenshots(${tiles.length})`);
    // 3D scenes: inspect the model and photograph it from three angles (after the page screenshot, which keeps the design's own camera).
    if (/<canvas|three|webgl/i.test(html)) {
      const info = (await page.evaluate(INSPECT_3D).catch(() => null)) as (Automated["threeD"] & { hook: boolean }) | null;
      if (info?.hook) {
        threeD = { parts: info.parts ?? 0, floating: info.floating ?? [], cutOff: !!info.cutOff, tiny: !!info.tiny, fill: info.fill, hook: true };
        for (let i = 0; i < 3 && threeD.parts; i++) {
          const clip = (await page.evaluate(`window.__vellumView(${i})`).catch(() => null)) as { x: number; y: number; width: number; height: number } | null;
          if (!clip || clip.width < 50 || clip.height < 50) break;
          const shot = await page.screenshot({ type: "jpeg", quality: 65, timeout: 12_000, clip }).catch(() => null);
          if (shot) views.push(shot);
        }
        lap(`3d(${threeD.parts} parts, ${views.length} views)`);
      } else if (/three/i.test(html)) threeD = { parts: 0, floating: [], cutOff: false, tiny: false, hook: false };
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    const mobile = (await page.evaluate("Math.max(0, document.documentElement.scrollWidth - window.innerWidth)")) as number;

    // Print it for real: the page count, plus pictures of the printed layout for the reviewer.
    let print: Automated["print"];
    if (printable) {
      await page.setViewportSize({ width: WIDTH, height: 800 });
      const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, format: "Letter" });
      print = { pages: countPdfPages(pdf), target: declaredPages(html) ?? printTarget };
      const area = printArea(html);
      await page.emulateMedia({ media: "print" });
      await page.setViewportSize({ width: area.width, height: area.height });
      await page.waitForTimeout(200);
      const full = (await page.evaluate("document.documentElement.scrollHeight")) as number;
      for (let y = 0; y < Math.min(full, area.height * 2); y += area.height) {
        printTiles.push(await page.screenshot({ type: "jpeg", quality: 65, fullPage: true, clip: { x: 0, y, width: area.width, height: Math.min(area.height, full - y) } }));
      }
    }
    lap("done");
    return {
      tiles,
      printTiles,
      views,
      automated: {
        jsErrors: [...new Set(jsErrors)].slice(0, 5),
        horizontalOverflow: { desktop: desktop.overflow, mobile },
        brokenImages: desktop.brokenImages,
        lowContrast: desktop.lowContrast,
        clippedText: desktop.clippedText,
        emptyPage: desktop.emptyPage,
        height: desktop.height,
        print,
        threeD,
      },
    };
  } finally {
    console.log(`[check] ${laps.join(", ")}`);
    await browser.close().catch(() => {});
  }
}

/**
 * Render a design in headless Chromium, run automatic checks, and have a
 * vision model (Nemotron Omni, falling back to Muse Glimmer) review
 * screenshots of it. The first screenshot is stored so the chat can show it.
 */
export async function checkDesign(
  db: SupabaseClient,
  projectId: string,
  html: string,
  opts: { deadline: number; signal?: AbortSignal; request?: string; printPages?: [number, number] | null; renderTimeoutMs?: number }
): Promise<CheckResult> {
  // Rendering is capped: a browser that can't start or a page that never settles must not stall the turn.
  // The check step has its own invocation, so it can allow heavy pages (software WebGL) more time.
  const renderCap = Math.min(opts.renderTimeoutMs ?? RENDER_TIMEOUT_MS, Math.max(10_000, opts.deadline - Date.now() - 25_000));
  const { automated, tiles, printTiles, views } = await withTimeout(render(html, opts.printPages ?? null), renderCap, "the page took too long to render");

  let screenshotUrl: string | null = null;
  if (tiles[0]) {
    const key = `${projectId}/checks/${Date.now()}.jpg`;
    const { error } = await db.storage.from(BUCKET).upload(key, new Blob([new Uint8Array(tiles[0])], { type: "image/jpeg" }), { contentType: "image/jpeg" });
    if (!error) screenshotUrl = db.storage.from(BUCKET).getPublicUrl(key).data.publicUrl;
  }

  const content: ContentPart[] = [
    {
      type: "text",
      text:
        (opts.request
          ? `The user asked for: "${opts.request.slice(0, 600)}"\nFirst check that the design actually shows what they asked for. Every subject, object or element they named must be clearly visible and in the right place (for example "a stickman on a tree" needs a visible stickman on the tree). Anything requested that is missing, cut off, off-screen or in the wrong place is a HIGH severity issue; don't assume it's there because a heading says so.\n\n`
          : "") + REVIEW_PROMPT,
    },
    ...tiles.map((t) => ({ type: "image_url" as const, image_url: { url: `data:image/jpeg;base64,${t.toString("base64")}` } })),
    ...(printTiles.length
      ? [
          {
            type: "text" as const,
            text: `The next ${printTiles.length === 1 ? "image is" : `${printTiles.length} images are`} the same design as printed on paper${automated.print ? ` (it prints to ${automated.print.pages} page${automated.print.pages === 1 ? "" : "s"})` : ""}. Check the printed layout too: it should keep the designed layout (columns, sidebar), with nothing cut off, overlapping or pushed onto an extra page.`,
          },
          ...printTiles.map((t) => ({ type: "image_url" as const, image_url: { url: `data:image/jpeg;base64,${t.toString("base64")}` } })),
        ]
      : []),
    ...(views.length
      ? [
          {
            type: "text" as const,
            text: `The next ${views.length} images show the 3D model on its own from the front, the side and three-quarter above. Judge it like a 3D artist against the real object: does the silhouette read as the real thing, are the proportions right, is any defining part missing, does anything float, stick through or sit in the wrong place, and do the materials look real (not plastic or flat)? Wrong silhouette, missing defining parts and floating parts are HIGH severity.`,
          },
          ...views.map((t) => ({ type: "image_url" as const, image_url: { url: `data:image/jpeg;base64,${t.toString("base64")}` } })),
        ]
      : []),
  ];
  // Never review without a picture: given only the request, the vision model invents problems ("the top isn't visible").
  if (!tiles.length) {
    return { automated, issues: [], overall: "Couldn't capture a screenshot of this page, so only the automatic checks ran.", reviewer: null, screenshotUrl };
  }
  const reviewUntil = Math.min(opts.deadline - 5_000, Date.now() + REVIEW_TIMEOUT_MS + 5_000);
  for (const model of REVIEWERS) {
    if (reviewUntil - Date.now() < 8_000) break;
    try {
      const r = await chat(model, {
        messages: [{ role: "user", content }],
        deadline: Math.min(opts.deadline - 5_000, Date.now() + REVIEW_TIMEOUT_MS),
        signal: opts.signal,
        noFallback: true,
        // A review needs a short answer, not pages of deliberation; this keeps the reasoning model fast.
        maxTokens: 1500,
        extra: model === "omni" ? { reasoning_budget: 768 } : undefined,
      });
      const review = parseReview(r.content) ?? parseReview(r.reasoning);
      if (review) return { automated, ...review, reviewer: model, screenshotUrl };
    } catch {
      if (opts.signal?.aborted) break;
    }
  }
  return { automated, issues: [], overall: "The visual review model was unavailable; only the automatic checks ran.", reviewer: null, screenshotUrl };
}
