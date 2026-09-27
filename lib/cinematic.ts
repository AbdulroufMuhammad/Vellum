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

const TRIGGER = /\b(cinematic|scroll[- ]?driven|scroll[- ]?scrub|scrollytelling|parallax|fly[- ]?through|dive[- ]?in|product film|scroll story|scroll[- ]?world)\b/i;

/** Whether the request calls for a scroll-scrubbed cinematic page, worth adding this guide for. */
export function isCinematicRequest(templateId: string, text: string): boolean {
  return templateId === "cinematic" || TRIGGER.test(text);
}

/** The agent's playbook for scroll-scrubbed camera-flight pages. */
export function cinematicGuide() {
  return `## Cinematic scroll (scroll-world): scroll scrubs a real camera flight
The page plays one continuous camera flight through the story, and scroll position drives the video's time: scroll down and the camera flies forward, scroll up and it flies back. It is video from start to finish, never a slideshow of stills with crossfades or Ken Burns zooms (that is the wrong technique; don't build it). The clips are either the user's own uploads or generated with generate_video; the page is scroll-world's own scrub engine plus a config.

### 0. The user's own clips (use these whenever they're attached)
If the user attached video clips, build from them: skip generation entirely (no generate_image, no generate_video) and go straight to step 4. Use the clips in the order given (attachment order, which follows their file names), one scene each: clip = the clip's url, still = its first frame. Write the copy for each scene from what the user said and the clip's name. If a clip is portrait (height greater than width) and the others are landscape, use it as that scene's clipMobile/stillMobile instead of a scene of its own. If no clips are attached and generate_video isn't available, ask the user to upload them, and put exactly what's needed in the form's intro or your reply:
${CLIP_REQUIREMENTS.map((r) => `- ${r.title}: ${r.detail}`).join("\n")}

### 1. Interview first (ask_questions), unless the request already answers it
- Where the clips come from (single, first question, unless clips are already attached): "I'll upload my own clips" or "Generate them with AI". If they'll upload, the form's intro lists what to upload (above) and you build once they've attached them.
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

### 4. The page
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
