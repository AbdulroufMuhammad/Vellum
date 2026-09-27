import type { TweakControl } from "@/lib/finalize";

/**
 * Injected into every design shown on the canvas. The iframe is sandboxed
 * without allow-same-origin, so this script is the only channel between the
 * design and the app: it reports picks/edits/tweak definitions out, and
 * applies modes, styles, tweak values and streaming drafts coming in.
 * Highlight boxes live on <html>, outside <body>, so they never end up in
 * an element's saved HTML.
 */
const BRIDGE = String.raw`(function(){
  if (window.__dsBridge) return; window.__dsBridge = 1;
  var root = document.documentElement;
  function post(m){ m.__ds = 1; try { parent.postMessage(m, "*"); } catch (e) {} }
  var mode = "view", editing = null, editTimer = null, lastSent = "";
  var style = document.createElement("style");
  style.setAttribute("data-ds-bridge", "");
  function mkBox(solid){
    var b = document.createElement("div");
    b.setAttribute("data-ds-bridge", "");
    b.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;border-radius:3px;display:none;box-sizing:border-box;" +
      (solid ? "border:2px solid #d9774f;background:rgba(217,119,87,.06)" : "border:1.5px dashed #d9774f");
    return b;
  }
  var hoverBox = mkBox(false), selBox = mkBox(true), selEl = null, hoverEl = null;
  function mount(){
    if (!style.isConnected) (document.head || root).appendChild(style);
    if (!hoverBox.isConnected) root.appendChild(hoverBox);
    if (!selBox.isConnected) root.appendChild(selBox);
  }
  function place(box, el){
    if (!el || !el.isConnected) { box.style.display = "none"; return; }
    var r = el.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = (r.left - 3) + "px"; box.style.top = (r.top - 3) + "px";
    box.style.width = (r.width + 6) + "px"; box.style.height = (r.height + 6) + "px";
  }
  // Comment pins: numbered markers on commented elements, shown in Comment mode.
  var pins = [], pinLayer = document.createElement("div");
  pinLayer.setAttribute("data-ds-bridge", "");
  pinLayer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646";
  function renderPins(){
    if (!pinLayer.isConnected) root.appendChild(pinLayer);
    pinLayer.innerHTML = "";
    if (mode !== "comment" || (typeof present !== "undefined" && present)) return;
    pins.forEach(function(p){
      var el = document.querySelector('[data-el="' + String(p.id).replace(/[^\w-]/g, "") + '"]');
      if (!el) return;
      var r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) return;
      var b = document.createElement("button");
      b.setAttribute("data-ds-bridge", "");
      b.textContent = p.n;
      b.title = "Comment " + p.n;
      b.style.cssText = "position:absolute;pointer-events:auto;left:" + Math.max(2, Math.min(innerWidth - 26, r.right - 12)) + "px;top:" + Math.max(2, r.top - 12) + "px;width:24px;height:24px;border-radius:50% 50% 50% 3px;background:#d9774f;color:#fff;font:600 11px/20px system-ui,sans-serif;border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35);cursor:pointer;padding:0;text-align:center";
      b.addEventListener("click", function(ev){ ev.preventDefault(); ev.stopPropagation(); post({ t: "pin", id: p.id, n: p.n, rect: rectOf(el) }); });
      pinLayer.appendChild(b);
    });
  }
  function repaint(){ place(hoverBox, mode === "view" ? null : hoverEl); place(selBox, mode === "view" ? null : selEl); }
  addEventListener("scroll", function(){ repaint(); renderPins(); }, true);
  addEventListener("resize", function(){ repaint(); renderPins(); });
  function paintMode(){
    style.textContent = mode === "comment" ? "*{cursor:crosshair!important}[data-ds-bridge]{cursor:pointer!important}" : mode === "edit" ? "[data-el]{cursor:text!important}" : "";
    repaint();
    renderPins();
  }
  function rectOf(el){ var r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }
  function hex(c){
    var m = String(c).match(/\d+(\.\d+)?/g); if (!m || m.length < 3) return "#000000";
    return "#" + [0,1,2].map(function(i){ return ("0" + Math.round(+m[i]).toString(16)).slice(-2); }).join("");
  }
  function targetFor(t){
    if (!t || t.nodeType !== 1) t = t && t.parentElement;
    if (!t || t === root || t === document.body || t.hasAttribute("data-ds-bridge")) return null;
    return mode === "edit" ? t.closest("[data-el]") : t;
  }
  function stopEditing(){
    if (!editing) return;
    flush();
    editing.removeAttribute("contenteditable");
    editing = null;
  }
  function flush(){
    clearTimeout(editTimer);
    if (!editing) return;
    var html = editing.innerHTML;
    if (html !== lastSent) { lastSent = html; post({ t: "html", id: editing.getAttribute("data-el"), html: html }); }
  }
  document.addEventListener("mouseover", function(e){
    if (mode === "view") return;
    hoverEl = targetFor(e.target); repaint();
  }, true);
  document.addEventListener("click", function(e){
    var cite = e.target.closest && e.target.closest("sup.cite[data-src], #ds-sources li[data-src]");
    if (mode === "view") {
      if (cite) { e.preventDefault(); post({ t: "cite", src: cite.getAttribute("data-src") }); return; }
      var a = e.target.closest && e.target.closest("a[href]");
      if (a) {
        var href = a.getAttribute("href") || "";
        if (href.charAt(0) === "#") return;
        if (/^https?:/i.test(href)) { e.preventDefault(); window.open(href, "_blank", "noopener"); }
      }
      return;
    }
    var el = targetFor(e.target);
    if (!el || (editing && editing.contains(e.target))) return;
    e.preventDefault(); e.stopPropagation();
    stopEditing();
    selEl = el; repaint();
    if (mode === "comment") {
      var text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
      post({ t: "pick", id: el.getAttribute("data-el"), tag: el.tagName.toLowerCase(), text: text.slice(0, 200), html: el.outerHTML.slice(0, 1500), rect: rectOf(el) });
    } else {
      var cs = getComputedStyle(el), fs = parseFloat(cs.fontSize) || 16;
      var lh = cs.lineHeight === "normal" ? 1.2 : Math.round(parseFloat(cs.lineHeight) / fs * 100) / 100;
      var ls = cs.letterSpacing === "normal" ? 0 : Math.round(parseFloat(cs.letterSpacing) / fs * 1000) / 1000;
      post({ t: "select", id: el.getAttribute("data-el"), tag: el.tagName.toLowerCase(), rect: rectOf(el), style: {
        fontSize: Math.round(fs), lineHeight: lh, letterSpacing: ls, marginBottom: Math.round(parseFloat(cs.marginBottom) || 0),
        fontWeight: parseInt(cs.fontWeight, 10) || 400, color: hex(cs.color), textAlign: cs.textAlign === "start" ? "left" : cs.textAlign
      }});
      editing = el; lastSent = el.innerHTML;
      el.setAttribute("contenteditable", "true");
      el.focus();
    }
  }, true);
  document.addEventListener("input", function(e){
    if (!editing || !editing.contains(e.target)) return;
    clearTimeout(editTimer); editTimer = setTimeout(flush, 500); repaint();
  }, true);
  document.addEventListener("focusout", function(e){ if (editing && e.target === editing) flush(); }, true);
  document.addEventListener("keydown", function(e){
    if (e.key === "Escape" && mode !== "view") { stopEditing(); selEl = null; repaint(); post({ t: "escape" }); }
  }, true);

  var controls = [];
  function kebab(s){ return String(s).replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase(); }
  function applyTweak(c, v, fire){
    var css = c.type === "toggle" ? (v ? "1" : "0") : (typeof v === "number" || c.type === "range") ? v + (c.unit || "") : String(v);
    root.style.setProperty("--" + c.name, css);
    root.setAttribute("data-" + kebab(c.name), String(v));
    if (fire) { try { window.dispatchEvent(new CustomEvent("tweak", { detail: { name: c.name, value: v } })); } catch (e) {} }
  }
  function readTweaks(){
    var s = document.querySelector("script#tweaks, script[data-tweaks]");
    if (!s) return [];
    try { var raw = JSON.parse(s.textContent || "[]"); var list = Array.isArray(raw) ? raw : (raw.controls || []); return list.filter(function(c){ return c && c.name; }); }
    catch (e) { return []; }
  }
  function pages(){ return document.querySelectorAll(".page, .slide, [data-page]").length; }
  function slideEls(){ return Array.prototype.slice.call(document.querySelectorAll(".slide, [data-slide]")); }

  // Present mode: one slide at a time, scaled to fit, with every inline style restored on exit.
  var present = null;
  function saveStyle(el, list){ list.push([el, el.getAttribute("style")]); }
  function showSlide(i){
    if (!present) return;
    var n = present.slides.length;
    present.index = Math.max(0, Math.min(n - 1, i));
    present.slides.forEach(function(el, j){
      var size = present.sizes[j];
      if (j !== present.index) { el.style.setProperty("display", "none", "important"); return; }
      var k = Math.min(innerWidth / size[0], innerHeight / size[1]);
      el.style.setProperty("display", present.displays[j], "important");
      el.style.setProperty("position", "fixed", "important");
      el.style.setProperty("left", "50%", "important");
      el.style.setProperty("top", "50%", "important");
      el.style.setProperty("margin", "0", "important");
      el.style.setProperty("width", size[0] + "px", "important");
      el.style.setProperty("height", size[1] + "px", "important");
      el.style.setProperty("transform", "translate(-50%, -50%) scale(" + k + ")", "important");
      el.style.setProperty("transform-origin", "center", "important");
      el.style.setProperty("z-index", "2147483646", "important");
    });
    var cur = present.slides[present.index];
    var notesEl = cur.querySelector("aside.notes, .notes");
    post({ t: "slide", index: present.index, total: n, notes: cur.getAttribute("data-notes") || (notesEl ? notesEl.innerText : "") });
  }
  function enterPresent(){
    var slides = slideEls();
    if (!slides.length) { post({ t: "slide", index: 0, total: 0, notes: "" }); return; }
    stopEditing(); selEl = null; hoverEl = null; mode = "view"; paintMode();
    var saved = [];
    slides.forEach(function(el){ var a = el.parentElement; while (a && a !== document.documentElement) { if (saved.every(function(p){ return p[0] !== a; })) { saveStyle(a, saved); a.style.setProperty("transform", "none", "important"); } a = a.parentElement; } });
    var sizes = slides.map(function(el){ return [el.offsetWidth || 1920, el.offsetHeight || 1080]; });
    var displays = slides.map(function(el){ var d = getComputedStyle(el).display; return d === "none" ? "block" : d; });
    slides.forEach(function(el){ saveStyle(el, saved); });
    var backdrop = document.createElement("div");
    backdrop.setAttribute("data-ds-bridge", "");
    backdrop.style.cssText = "position:fixed;inset:0;background:#000;z-index:2147483645";
    root.appendChild(backdrop);
    saveStyle(document.body, saved);
    document.body.style.setProperty("overflow", "hidden", "important");
    present = { slides: slides, sizes: sizes, displays: displays, saved: saved, backdrop: backdrop, index: 0 };
    showSlide(0);
  }
  function exitPresent(){
    if (!present) return;
    present.saved.forEach(function(p){ if (p[1] == null) p[0].removeAttribute("style"); else p[0].setAttribute("style", p[1]); });
    present.backdrop.remove();
    present = null;
  }
  addEventListener("resize", function(){ if (present) showSlide(present.index); });
  document.addEventListener("keydown", function(e){
    if (!present) return;
    var k = e.key;
    if (k === "ArrowRight" || k === "PageDown" || k === " " || k === "Enter") showSlide(present.index + 1);
    else if (k === "ArrowLeft" || k === "PageUp" || k === "Backspace") showSlide(present.index - 1);
    else if (k === "Home") showSlide(0);
    else if (k === "End") showSlide(present.slides.length - 1);
    else if (k === "Escape") { post({ t: "present-exit" }); return; }
    else return;
    e.preventDefault(); e.stopPropagation();
  }, true);
  document.addEventListener("click", function(e){
    if (!present) return;
    e.preventDefault(); e.stopPropagation();
    showSlide(present.index + (e.clientX < innerWidth / 3 ? -1 : 1));
  }, true);

  addEventListener("message", function(e){
    if (e.source !== parent || !e.data || !e.data.__ds) return;
    var m = e.data;
    if (m.t === "mode") {
      if (m.mode !== mode) { stopEditing(); selEl = null; hoverEl = null; }
      mode = m.mode; paintMode();
    } else if (m.t === "deselect") { stopEditing(); selEl = null; repaint(); }
    else if (m.t === "style" && m.id) {
      var el = document.querySelector('[data-el="' + String(m.id).replace(/[^\w-]/g, "") + '"]');
      if (!el) return;
      var s = m.style || {};
      if (s.fontSize != null) el.style.fontSize = s.fontSize + "px";
      if (s.lineHeight != null) el.style.lineHeight = s.lineHeight;
      if (s.letterSpacing != null) el.style.letterSpacing = s.letterSpacing + "em";
      if (s.marginBottom != null) el.style.marginBottom = s.marginBottom + "px";
      if (s.fontWeight != null) el.style.fontWeight = s.fontWeight;
      if (s.color != null) el.style.color = s.color;
      if (s.textAlign != null) el.style.textAlign = s.textAlign;
      repaint();
    } else if (m.t === "tweaks") {
      var vals = m.values || {};
      controls.forEach(function(c){ if (c.name in vals) applyTweak(c, vals[c.name], true); });
    } else if (m.t === "pins") {
      pins = Array.isArray(m.pins) ? m.pins : []; renderPins();
    } else if (m.t === "present") {
      if (m.on) enterPresent(); else exitPresent();
    } else if (m.t === "present-go") {
      if (present) showSlide(m.index != null ? m.index : present.index + (m.dir || 0));
    } else if (m.t === "draft") {
      var doc = new DOMParser().parseFromString(m.html, "text/html");
      if (doc.head.innerHTML !== (window.__dsHead || "")) { window.__dsHead = doc.head.innerHTML; document.head.innerHTML = doc.head.innerHTML; }
      document.body.innerHTML = doc.body.innerHTML;
      document.body.setAttribute("style", doc.body.getAttribute("style") || "");
      document.body.className = doc.body.className;
      mount();
      typesetDraft();
      post({ t: "height", h: document.documentElement.scrollHeight });
    }
  });

  // Streamed drafts replace the DOM without running the page's scripts, so math and graphs would stay raw until
  // the finished file loads. Typeset them here: KaTeX and function-plot load once, re-render at most every 1.2s.
  var KATEX = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/";
  var FPLOT = "https://cdn.jsdelivr.net/npm/function-plot@1.25.1/dist/function-plot.js";
  var tsBusy = false, tsLast = 0, tsTimer = null, tsLoading = {};
  function need(src, ready, cb){
    if (ready()) return cb();
    if (tsLoading[src]) return;
    tsLoading[src] = true;
    var sc = document.createElement("script"); sc.src = src;
    sc.onload = function(){ tsLoading[src] = false; cb(); };
    document.head.appendChild(sc);
  }
  function typesetNow(){
    tsLast = Date.now();
    var body = document.body;
    if (/\\\(|\\\[|\$\$/.test(body.textContent || "")) {
      if (!document.querySelector("link[data-ds-katex]")) {
        var l = document.createElement("link"); l.rel = "stylesheet"; l.href = KATEX + "katex.min.css"; l.setAttribute("data-ds-katex", ""); document.head.appendChild(l);
      }
      need(KATEX + "katex.min.js", function(){ return !!window.katex; }, function(){
        need(KATEX + "contrib/auto-render.min.js", function(){ return !!window.renderMathInElement; }, function(){
          try { window.renderMathInElement(document.body, { delimiters: [{left:"$$",right:"$$",display:true},{left:"\\[",right:"\\]",display:true},{left:"\\(",right:"\\)",display:false}], throwOnError: false }); } catch (e) {}
        });
      });
    }
    if (body.querySelector("[data-plot]")) {
      need(FPLOT, function(){ return !!window.functionPlot; }, function(){
        document.querySelectorAll("[data-plot]").forEach(function(el){
          if (el.querySelector("svg")) return;
          try { var o = JSON.parse(el.getAttribute("data-plot")); var w = el.clientWidth || 620; o.target = el; o.width = o.width || w; o.height = o.height || Math.round(w * 0.55); if (o.disableZoom === undefined) o.disableZoom = true; if (o.grid === undefined) o.grid = true; window.functionPlot(o); } catch (e) {}
        });
      });
    }
  }
  function typesetDraft(){
    clearTimeout(tsTimer);
    var wait = Math.max(0, 1200 - (Date.now() - tsLast));
    tsTimer = setTimeout(typesetNow, wait);
  }

  function init(){
    mount(); paintMode();
    controls = readTweaks();
    controls.forEach(function(c){ applyTweak(c, c.value, false); });
    post({ t: "ready", pages: pages(), slides: slideEls().length, tweaks: controls, title: document.title || "" });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  addEventListener("load", function(){
    setTimeout(function(){ controls.forEach(function(c){ applyTweak(c, c.value, true); }); post({ t: "pages", pages: pages() }); }, 0);
    // A saved file written before math and graphs were handled on write has no renderer of its own: typeset it here.
    var rawMath = !window.renderMathInElement && /\\\(|\\\[|\$\$/.test(document.body.textContent || "");
    var rawPlot = [].some.call(document.querySelectorAll("[data-plot]"), function(el){ return !el.querySelector("svg"); });
    if (rawMath || rawPlot) typesetNow();
  });
})();`;

export function buildSrcDoc(html: string) {
  const tag = `<script data-ds-bridge>${BRIDGE}</script>`;
  // A replacer function, not a string: in a replacement string "$$" means "$", which would corrupt the bridge.
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>(?![\s\S]*<\/body>)/i, () => `${tag}</body>`);
  return html + tag;
}

export const DRAFT_SHELL = buildSrcDoc("<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>");

export type BridgeOut =
  | { t: "ready"; pages: number; slides: number; tweaks: TweakControl[]; title: string }
  | { t: "slide"; index: number; total: number; notes: string }
  | { t: "present-exit" }
  | { t: "pin"; id: string; n: number; rect: Rect }
  | { t: "pages"; pages: number }
  | { t: "pick"; id: string | null; tag: string; text: string; html: string; rect: Rect }
  | { t: "select"; id: string; tag: string; rect: Rect; style: ElementStyle }
  | { t: "html"; id: string; html: string }
  | { t: "cite"; src: string }
  | { t: "escape" }
  | { t: "height"; h: number };

export type Rect = { x: number; y: number; w: number; h: number };
export type ElementStyle = {
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  marginBottom: number;
  fontWeight: number;
  color: string;
  textAlign: string;
};
export type CanvasMode = "view" | "comment" | "edit";
