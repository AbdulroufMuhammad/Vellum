/**
 * Scroll-scrubbed camera-flight pages, the scroll-world technique (github.com/AbdulroufMuhammad/scroll-world):
 * scroll drives video.currentTime through real AI-generated camera-flight clips, chained so each clip starts on
 * the previous clip's actual last frame. The camera genuinely moves; scroll only drives time (the technique behind
 * Apple's scroll-through product pages). Clips come from generate_video (NVIDIA Cosmos image-to-video), and the
 * page mounts scroll-world's own MIT-licensed scrub engine, pinned on jsDelivr, rather than re-deriving it.
 *
 * Cosmos conditions on a first frame only (no end frame), so the chain is scroll-world's architecture A: one
 * continuous forward take whose legs hand off real frames. Its architecture B (aerial connectors that land on
 * the next scene's exact first frame) needs end-frame conditioning and isn't offered.
 */

/** What a user's own clips must be, shown on Home with the Cinematic scroll template and given to the agent. */
export const CLIP_REQUIREMENTS: { title: string; detail: string }[] = [
  { title: "One clip per scene", detail: "3 to 8 clips (5 is a good default), in the order the camera travels. Name them 01-…, 02-… so they sort into order." },
  { title: "One continuous camera move each", detail: "A slow push-in, glide, orbit or drone flight with no cuts inside the clip." },
  { title: "Seamless if they chain", detail: "Start each clip exactly where the previous one ended (same framing), e.g. one long take split into parts. Otherwise scenes dissolve into each other." },
  { title: "Format", detail: "MP4 (H.264), 16:9 landscape at 1920×1080 or 1280×720, 4 to 8 seconds, under 50 MB each. Sound isn't needed; the page is muted." },
  { title: "Steady and slow", detail: "Smooth, slow motion scrubs best. Avoid shaky handheld footage, fast pans, flashes and text on screen." },
  { title: "Optional: phone versions", detail: "A matching set shot or cropped as 9:16 portrait, in the same order, for a native mobile version." },
];

export const SCRUB_ENGINE_URL =
  "https://cdn.jsdelivr.net/gh/AbdulroufMuhammad/scroll-world@71cc36d/skills/scroll-world/references/scrub-engine.js";

/**
 * The alternative to real video clips: one continuous procedural animation (canvas 2D, or a Web Animations
 * timeline over DOM/SVG), authored as code and scrubbed by directly setting its own clock from scroll. No
 * generate_video, no rendering wait, no per-clip cost, and every seam is exact because the same code draws
 * both sides of it. mountScrollWorld's engine only scrubs a <video>'s currentTime, so this is its own small
 * mount function (verified: scroll maps linearly to a scene's time and each scene's copy crossfades exactly
 * at its start/end), not a fork of that engine.
 */
export const MOUNT_SCROLL_ANIMATION = `function mountScrollAnimation(root, cfg) {
  // .sa-copy lives inside .sa-stage (the sticky, viewport-height box), not next to it: as a sibling it would
  // be absolutely positioned against the whole scroll-length root instead of the visible viewport (verified
  // live: the copy landed hundreds of pixels below the fold except right at the very last scroll position).
  root.innerHTML = '<div class="sa-stage"><canvas class="sa-canvas"></canvas><div class="sa-dom"></div><div class="sa-copy"></div></div><div class="sa-hint">' + (cfg.hint || "scroll") + "</div>";
  const canvas = root.querySelector(".sa-canvas"), domHost = root.querySelector(".sa-dom");
  const copyHost = root.querySelector(".sa-copy"), hint = root.querySelector(".sa-hint");
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  function resize() {
    canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
    canvas.style.width = innerWidth + "px"; canvas.style.height = innerHeight + "px";
  }
  resize();
  addEventListener("resize", resize);
  root.style.height = (cfg.scrollPerScene * cfg.scenes.length * 100) + "vh";
  cfg.setup && cfg.setup(domHost);
  let raf = null;
  function copyBlock(s) {
    const el = document.createElement("div");
    el.className = "sa-copy-block";
    el.dataset.id = s.id;
    el.style.setProperty("--accent", s.accent || "#e0d8c8");
    el.innerHTML = (s.eyebrow ? '<div class="sa-eyebrow">' + s.eyebrow + "</div>" : "") + (s.title ? "<h2>" + s.title + "</h2>" : "") + (s.body ? "<p>" + s.body + "</p>" : "") +
      (s.tags ? '<div class="sa-tags">' + s.tags.map((t) => "<span>" + t + "</span>").join("") + "</div>" : "") +
      (s.cta ? '<div class="sa-cta">' + (s.cta.primary ? '<a class="sa-btn" href="' + s.cta.primary.href + '">' + s.cta.primary.label + "</a>" : "") + (s.cta.secondary ? '<a class="sa-btn ghost" href="' + s.cta.secondary.href + '">' + s.cta.secondary.label + "</a>" : "") + "</div>" : "");
    return el;
  }
  function frame() {
    raf = null;
    const max = Math.max(1, root.scrollHeight - innerHeight);
    const rect = root.getBoundingClientRect();
    const progress = Math.min(Math.max(-rect.top, 0), max) / max;
    const t = progress * cfg.totalSeconds;
    cfg.render(ctx, t, canvas.width, canvas.height, domHost);
    const cf = cfg.crossfade ?? 0.12;
    let current = null;
    for (const s of cfg.scenes) {
      const span = s.end - s.start;
      const inWindow = t >= s.start - span * cf && t <= s.end + span * cf;
      let el = copyHost.querySelector('[data-id="' + s.id + '"]');
      if (inWindow) {
        if (!el) { el = copyBlock(s); copyHost.appendChild(el); }
        let op = 1;
        if (t < s.start) op = 1 - (s.start - t) / (span * cf);
        else if (t > s.end) op = 1 - (t - s.end) / (span * cf);
        el.style.opacity = String(Math.max(0, Math.min(1, op)));
        current = s;
      } else if (el) el.remove();
    }
    hint.style.opacity = progress > 0.03 ? "0" : "1";
    if (current) root.style.setProperty("--accent", current.accent || "#e0d8c8");
  }
  function onScroll() { if (!raf) raf = requestAnimationFrame(frame); }
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", onScroll);
  frame();
}`;

/** Base styling mountScrollAnimation's markup needs; restyle freely (this only sets structure and defaults). */
export const SCROLL_ANIMATION_CSS = `#film, .sa-stage { position: relative; }
.sa-stage { position: sticky; top: 0; height: 100vh; overflow: hidden; background: var(--sa-bg, #0e0c0a); }
.sa-canvas, .sa-dom, .sa-copy { position: absolute; inset: 0; width: 100%; height: 100%; }
.sa-copy { pointer-events: none; }
.sa-copy-block { position: absolute; left: 8%; bottom: 12%; max-width: 460px; opacity: 0; color: var(--sa-ink, #f2ede2); }
.sa-eyebrow { font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent, #e0d8c8); margin-bottom: 8px; }
.sa-copy-block h2 { margin: 0 0 10px; font-size: clamp(26px, 4vw, 44px); }
.sa-copy-block p { margin: 0 0 12px; opacity: 0.78; max-width: 40ch; }
.sa-tags { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.sa-tags span { font-size: 12px; padding: 4px 10px; border-radius: 99px; border: 1px solid color-mix(in srgb, var(--sa-ink, #f2ede2) 25%, transparent); opacity: 0.85; }
.sa-cta { display: flex; gap: 10px; pointer-events: auto; }
.sa-btn { display: inline-flex; align-items: center; padding: 10px 18px; border-radius: 8px; background: var(--accent, #e0d8c8); color: #14120f; font-weight: 600; text-decoration: none; }
.sa-btn.ghost { background: transparent; color: var(--sa-ink, #f2ede2); border: 1px solid color-mix(in srgb, var(--sa-ink, #f2ede2) 35%, transparent); }
.sa-hint { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); font-size: 12px; color: var(--sa-ink, #f2ede2); opacity: 0.6; transition: opacity 0.4s; pointer-events: none; }
@media (prefers-reduced-motion: reduce) { .sa-copy-block { transition: none; } }`;

const TRIGGER = /\b(cinematic|scroll[- ]?driven|scroll[- ]?scrub|scrollytelling|parallax|fly[- ]?through|dive[- ]?in|product film|scroll story|scroll[- ]?world)\b/i;

/** Whether the request calls for a scroll-scrubbed cinematic page, worth adding this guide for. */
export function isCinematicRequest(templateId: string, text: string): boolean {
  return templateId === "cinematic" || TRIGGER.test(text);
}

/** The agent's playbook for scroll-scrubbed camera-flight pages. */
export function cinematicGuide() {
  return `## Cinematic scroll (scroll-world): scroll scrubs one continuous flight
The page plays one continuous camera flight through the story, and scroll position drives its time: scroll down and it flies forward, scroll up and it flies back. It is motion from start to finish, never a slideshow of stills with crossfades or Ken Burns zooms (that is the wrong technique; don't build it). The flight is one of three sources: the user's own uploaded clips, real AI video from generate_video, or a procedural animation you build and drive from scroll yourself (mountScrollAnimation, below) — the free, instant default when there are no clips to upload and no working video model, and a fine choice even when there is one.

### 0. The user's own clips (use these whenever they're attached)
If the user attached video clips, build from them: skip generation entirely (no generate_image, no generate_video) and go straight to step 4. Use the clips in the order given (attachment order, which follows their file names), one scene each: clip = the clip's url, still = its first frame. Write the copy for each scene from what the user said and the clip's name. If a clip is portrait (height greater than width) and the others are landscape, use it as that scene's clipMobile/stillMobile instead of a scene of its own. If no clips are attached, generate_video isn't available, and the user wants real video rather than an animation, ask them to upload clips, and put exactly what's needed in the form's intro or your reply:
${CLIP_REQUIREMENTS.map((r) => `- ${r.title}: ${r.detail}`).join("\n")}

### 0b. An animated flight instead of video (mountScrollAnimation)
No clips, no rendering, no per-scene cost or wait: you draw the flight yourself, as code, and scrub your own clock from scroll exactly the way scroll-world scrubs a video's. Reach for this whenever there's nothing to upload and no reason to wait minutes per clip on generate_video; it also chains perfectly by construction, since the same code draws both sides of every seam. Skip straight to step 4b once it's chosen.

### 1. Interview first (ask_questions), unless the request already answers it
- Where the flight comes from (single, first question, unless clips are already attached): "I'll upload my own clips", "Generate real video with AI" or "Build it as an animation (instant, free)" — lead with the animation option when generate_video is known to be unavailable. If they'll upload, the form's intro lists what to upload (above) and you build once they've attached them.
- Subject: if the request doesn't clearly name the business or idea, ask openly (text field), never with made-up multiple choice.
- Art direction (single, with Other; it becomes the style preamble repeated verbatim in every prompt): "Clay diorama: isometric low-poly diorama, soft matte clay render, rounded toy-model shapes, warm studio light, tilt-shift miniature", "Papercraft: isometric layered paper-craft diorama, matte cardstock, die-cut edges", "Photoreal architectural: ultra-photorealistic architectural photography, cinematic wide-angle, warm golden-hour light, natural materials, editorial magazine quality, no people", "Cinematic live action: photorealistic cinematic film still, anamorphic lens, shallow depth of field, rich color grade", "Neon night: miniature world at night, warm interior glow and neon signage, moody rim light, wet reflective ground".
- Camera style (single, always ask, it's the film's personality): "One continuous walkthrough: a single forward flight that glides through each scene straight into the next" (default; the only fully seamless option), "Locked isometric glide: one fixed high angle for the whole film, the world slides past beneath it" (calmest), "Scene dives: the camera dives into each scene from its own still, with a short dissolve between scenes" (each scene matches its still exactly, but the joins are dissolves, not one unbroken take).
- The journey: 4 to 6 scenes in order, drawn from the subject's own value chain (e.g. farm, roastery, cafe, first pour). Propose them in the form so the user can edit.
- Mobile version (toggle, always ask): a second chain rendered natively in 9:16 portrait, which doubles the clips to render. Default no.
Say in the form's intro that each clip takes 1 to 3 minutes to render, so a 5-scene film is roughly 5 to 15 minutes of rendering, spread automatically across steps.

### 2. The style preamble
Write one preamble from the chosen art direction plus the palette (4 to 6 named hex values) and "absolutely no text, no letters, no logos". Repeat it byte for byte in every generate_image and generate_video prompt. This identical text is what makes every clip one world. Compose every scene with its focal subject centred with a little headroom (the page shows clips object-fit: cover).

### 3. Render the chain (one generate_video per step, before writing any file)
Each clip takes minutes, so call generate_video once per step, on its own, and render all clips before writing the page. If a step has too little time left it ends and the next one continues; the clips already rendered are listed back to you, so never regenerate one.

Walkthrough or locked isometric glide (one continuous forward take):
- generate_image the first scene only: [preamble]. Subject: [scene 1]. Ratio 16:9.
- Leg 1: generate_video with start_image = that image's url.
- Leg i (2..N): generate_video with start_image = leg i-1's last_frame_url. Never use a still for these; handing over the real last frame is what makes every seam frame-identical.
- Leg prompt, keeping the two bold clauses word for word (they are the motion-handoff contract that keeps the camera from reversing at a seam, which reads as a rewind stutter): "Single continuous cinematic camera move, no cuts. **Continue the same slow, steady forward glide.** [MID-LEG MOVE] The camera moves into [scene i] toward [its focal point]. **In the final second, settle back into a slow, steady forward glide toward [the opening or direction of scene i+1].** [preamble]. Smooth, graceful, slow motion, subtle parallax. No text, no captions." For leg 1, start with "Begin wide, looking at the whole [scene 1]." instead of the first bold clause; the last leg ends by settling on the finale's hero subject.
- Mid-leg move, chosen from the concept (a reversal inside one clip is fine; only a seam may never reverse): product or luxury, "sweeping in a slow half-orbit around [the hero object], keeping it centred, then continuing past it"; spaces and scale, "rising smoothly as the full scale of [the space] reveals below"; production and process, "tracking low and level alongside [the line], foreground objects sliding past in parallax"; craft and food, "pushing in close to [the craft moment] until it nearly fills the frame, then easing gently back out"; outdoors, "climbing in a gentle arc over [the terrain], then swooping down toward [the next focal point]". Locked isometric glide replaces the move with: "The camera keeps exactly the same high isometric angle throughout, no rotation, no orbit, no tilt; it only travels straight and level, the world sliding past beneath the same view."
- Seconds: 5 per leg (6 to 8 for the hero or finale scene).

Scene dives:
- generate_image every scene (same preamble, ratio 16:9), then for each scene generate_video with start_image = that scene's own image and: "Single continuous cinematic camera move, no cuts. Begin wide, looking at the whole [scene]. The camera glides forward and descends toward [focal point], as if flying inside. [preamble]. Smooth, graceful, slow motion, subtle parallax. No text, no captions."

Mobile (only if asked): repeat the same chain with ratio "9:16": a 9:16 first image, then legs chained from their own 9:16 last frames, never from the desktop chain's frames.

If generate_video refuses a prompt (a content filter), reword it (drop anything that could read as unsafe, add "empty, unoccupied, architectural") and retry once; if it still fails, leave that clip out and let the engine dissolve across the gap.

### 3b. Building the flight as an animation (mountScrollAnimation)
No generation step at all: write the whole flight as one procedural animation with a known total duration, and mountScrollAnimation drives it from scroll. Two ways to draw a scene, pick per scene by what suits it:
- **Canvas 2D**: the \`render(ctx, t, W, H)\` callback draws directly onto a full-bleed canvas at time \`t\` (seconds, across the WHOLE film, not per scene) — particles, gradients, shapes, parallax layers, procedural geometry. Redraw the whole frame from \`t\` every call; nothing persists between calls.
- **DOM or SVG**: build the elements once (in \`setup(domHost)\`, called on mount) as ordinary HTML/SVG plus Web Animations API timelines (\`el.animate([...keyframes], { duration, fill: "both" })\`), keep a reference to each Animation, then in \`render\`, seek them: \`anim.currentTime = (t - sceneStart) * 1000\`. This is the exact technique the Animation template uses for a logo reveal or similar graphic, aimed at a timeline instead of played on load. Pause every animation immediately after creating it (\`anim.pause()\`) so nothing plays on its own; \`currentTime\` is the only thing moving it.
A scene can mix both (canvas backdrop, DOM foreground) since \`render\` receives \`domHost\` too.

Write real motion, matched to the concept, same as you would for the Animation template: easing that feels intentional (not linear), a clear beginning/middle/settle per scene, one focal subject per beat. Keep every scene's total time in \`totalSeconds\` (sum of each scene's \`end - start\`, no gaps: one scene's \`end\` is the next scene's \`start\`) and hand it to \`mountScrollAnimation\` in config; scroll maps linearly across it.
\`\`\`html
<style>${SCROLL_ANIMATION_CSS}</style>
<div id="film"></div>
<script>
${MOUNT_SCROLL_ANIMATION}

mountScrollAnimation(document.getElementById("film"), {
  hint: "scroll to fly in",
  scrollPerScene: 1.8,      // viewport heights of scroll per scene
  crossfade: 0.15,          // fraction of a scene's own span used to fade its copy in and out
  totalSeconds: 24,         // sum of every scene's (end - start)
  setup(domHost) { /* build any DOM/SVG elements and their WAAPI animations once here, all paused */ },
  render(ctx, t, W, H, domHost) { /* draw the canvas at time t and/or seek this frame's WAAPI animations */ },
  scenes: [
    { id: "workshop", start: 0, end: 5, accent: "#8FB98A", eyebrow: "From leaf to last sip", title: "It starts in the hills.",
      body: "One sentence from the visitor's side.", tags: ["Single-origin", "Hand-picked"] },
    // ...one per scene, in order, "start"/"end" carving up the shared totalSeconds
    // the last scene only: cta: { primary: { label: "Order now", href: "#" }, secondary: { label: "Visit us", href: "#" } }
  ],
});
</script>
\`\`\`
- Copy per scene: same voice as the video path (eyebrow 2 to 4 words, title 3 to 6 words, body one sentence, 0 to 3 tags); give the opening and finale scenes more of the total seconds (a slower beat) and transit scenes fewer.
- Theme with the same \`--sw-bg\`/\`--sw-ink\` naming convention isn't required here; mountScrollAnimation reads \`--sa-bg\` and \`--sa-ink\` (set on \`:root\` or on \`#film\`) plus each scene's own \`accent\`. Keep the canvas or DOM work's own colors in sync with these.
- \`prefers-reduced-motion\` isn't special-cased inside the engine beyond the copy transition; if the concept has a lot of fast motion, read the media query in your own \`render\` and hold to a calmer pose when it's set.
- This is your own code, not a pinned dependency: restyle, extend or simplify mountScrollAnimation and its CSS as the design needs, unlike the video engine below.
- Skip step 2 (style preamble) and step 3 (render the chain): there is nothing to generate. Skip straight to checking the result once the page is written.

### 4. The page (real video, from generate_video or the user's own clips)
The whole design is the engine, a container and a config. Don't write your own scroll, scrub or crossfade code, and don't hand-copy the engine: load it from its pinned URL.
\`\`\`html
<div id="world"></div>
<script src="${SCRUB_ENGINE_URL}"></script>
<script>
  mountScrollWorld(document.getElementById("world"), {
    brand: { name: "Brand Name" },
    hint: "scroll to fly in",
    diveScroll: 1.4,          // viewport heights of scroll per clip
    crossfade: 0.08,          // walkthrough: a tiny seam dissolve; scene dives: 0.14
    sections: [
      { id: "farm", label: "The Farm", clip: LEG1.url, still: LEG1.first_frame_url,
        // mobile only: clipMobile: M_LEG1.url, stillMobile: M_LEG1.first_frame_url,
        accent: "#8FB98A", eyebrow: "From leaf to last sip", title: "It starts in the hills.",
        body: "One sentence from the visitor's side.", tags: ["Single-origin", "Hand-picked"],
        scroll: 1.8, linger: 0.4 },   // optional: longer dwell, camera settles while the copy peaks
      // ...one per clip, in order; the last also carries
      // cta: { primary: { label: "Order now", href: "#" }, secondary: { label: "Visit us", href: "#" } }
    ],
    connectors: [],           // always empty here: the legs themselves are the journey
  });
</script>
\`\`\`
- still is each clip's first_frame_url (the poster until the clip paints, and the fallback under reduced motion). For scene dives use each scene's generated image.
- Pacing: give the opening and the finale a higher scroll (1.8 to 2.2) and linger 0.3 to 0.5; keep transit legs brisk (1.2 to 1.4).
- Copy per scene: eyebrow 2 to 4 words, title 3 to 6 words (the first is the site's hero line, the last is the payoff), body one sentence, 0 to 3 tags.
- Theme it with CSS variables in an unlayered :root block (they override the engine's defaults): --sw-bg (dark, e.g. #0e0c0a, for photoreal and live action; match the scene background for dioramas), --sw-ink (text), --sw-ink-soft, --sw-accent, --sw-font-display and --sw-font-body (a Google Fonts pairing). The visual identity comes from the clips, so keep the chrome quiet.
- The engine loads each clip as a blob (always seekable), lazy-loads nearby clips, coalesces seeks, hardens phones and respects reduced motion by itself.`;
}
