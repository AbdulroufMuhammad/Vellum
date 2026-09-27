/**
 * Scroll-driven cinematic pages: real AI-generated stills (generate_image), layered and crossfaded
 * with scroll-linked Ken Burns and parallax motion, instead of static hero images. This app has no
 * connected video-generation account (the technique this is adapted from, seen in AbdulroufMuhammad's
 * scroll-world repo, drives its motion with real AI-generated video "dive-in" clips from paid
 * Monid/Higgsfield accounts), so the achievable version here fakes camera-move depth with layered
 * stills and CSS transforms driven by scroll position, in one self-contained HTML file.
 */

const TRIGGER = /\b(cinematic|scroll[- ]?driven|scroll[- ]?scrub|scrollytelling|parallax|fly[- ]?through|dive[- ]?in|product film|scroll story)\b/i;

/** Whether the request calls for a scroll-driven cinematic treatment, worth adding this guide for. */
export function isCinematicRequest(templateId: string, text: string): boolean {
  return templateId === "cinematic" || TRIGGER.test(text);
}

/** The agent's playbook for scroll-driven cinematic pages built from generated stills. */
export function cinematicGuide() {
  return `## Cinematic scroll (AI stills, not static images)
Break the story into 5-8 scenes (a sequence of moments, not sections of a normal page). For each scene, call generate_image for a real still: this template exists specifically to use real generated photography, so unlike most other designs, inline SVG or CSS-gradient illustration standing in for a scene's image is not an acceptable substitute here, even though it's normally a perfectly good choice. Write one shared style phrase (lighting, color grade, medium, e.g. "cinematic, volumetric light, teal and amber grade, shot on 35mm") and append it to every scene's prompt so all the stills read as one continuous world, not unrelated pictures. Where a scene needs foreground depth, generate a second image for it: same style phrase, prompt it for a single foreground subject on a plain dark or transparent-reading background, so it can be layered over the background still. If check_design ever reports one of these images as broken or failing to load, that's a real bug to find and fix (or a call to retry with generate_image), never a reason to delete the image and fall back to SVG.

Structure: one tall wrapper, height = number of scenes * 100vh (or more per scene for a slower scrub). Each scene is a position: sticky; top: 0; height: 100vh; div holding its layered <img>s, in DOM order, each pinned inside the same 100vh viewport window as the wrapper scrolls past it; this is what makes it feel scrubbed rather than a normal one-per-screen scroll. Preload every scene's images before the page is interactive (new Image().src for each, or await decode()) so the first scroll never shows a blank frame.

Drive motion from scroll position, not from time or hover:
- On scroll (rAF-throttled, one listener), compute each scene's progress: (viewportMidpoint - sceneTop) / sceneHeight, clamped 0 to 1.
- Ken Burns: transform: scale(1 + t * 0.12) translateY(t * -30px) on the background still (t = progress); a slow, continuous zoom/drift reads as camera movement even on a static image.
- Parallax depth: a foreground layer moves faster than the background (translateY(t * -80px) vs the background's -30px) so they separate in depth as the scene scrubs.
- Crossfade between scenes: over the last ~25% of a scene's progress, fade its opacity from 1 to 0 while the next scene (already sticky underneath) is reaching its own early progress at full opacity; this is the connector moment, the one scroll-world gets from a frame-locked video clip, done here as a plain opacity blend between two stills.
- Only animate transform and opacity (never layout properties): set will-change: transform, opacity on the animated layers so it stays smooth.

Copy sits in its own layer above the images (a heading, a short line, sometimes nothing) with its own scroll-linked fade/rise, timed to appear after the scene's images have mostly resolved (progress > 0.15) and leave before the crossfade starts.

Keep it to a real story with a beginning, middle and turn, matching the request's product or narrative; never generate filler scenes just to hit a count.

Markup and scroll-scrub engine, adapt directly rather than freehanding the math (one rAF-throttled scroll listener drives every scene, so it stays smooth with any number of scenes):
\`\`\`html
<div class="reel" style="height: calc(var(--scenes) * 100vh)">
  <section class="scene" data-scene="0"><img class="bg" src="…"><img class="fg" src="…"><div class="copy"><h2>…</h2></div></section>
  <!-- one .scene per generated still, in order -->
</div>
<script>
  const scenes = [...document.querySelectorAll(".scene")];
  document.documentElement.style.setProperty("--scenes", scenes.length);
  function onScroll() {
    const mid = window.scrollY + window.innerHeight / 2;
    for (const el of scenes) {
      const top = el.offsetTop, h = el.offsetHeight;
      const t = Math.min(1, Math.max(0, (mid - top) / h));
      const bg = el.querySelector(".bg"), fg = el.querySelector(".fg"), copy = el.querySelector(".copy");
      if (bg) bg.style.transform = \`scale(\${1 + t * 0.12}) translateY(\${t * -30}px)\`;
      if (fg) fg.style.transform = \`translateY(\${t * -80}px)\`;
      const fadeOut = Math.max(0, (t - 0.75) / 0.25);
      el.style.opacity = String(1 - fadeOut);
      if (copy) copy.style.opacity = String(Math.min(1, t / 0.15) * (1 - Math.min(1, t / 0.6)));
    }
  }
  let ticking = false;
  window.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { onScroll(); ticking = false; });
  }, { passive: true });
  onScroll();
</script>
\`\`\`
\`.scene\` is \`position: sticky; top: 0; height: 100vh; overflow: hidden\` with \`.bg\`/\`.fg\` absolutely filling it (\`will-change: transform\`) and \`.copy\` centered above them; \`.reel\` is the tall scroll container. Adjust the constants (0.12 zoom, -30px/-80px drift, the 0.75-1 fade window) to the story's pacing, and add more layers per scene if a moment needs more depth, but keep the same progress variable \`t\` driving all of them so they stay in sync.`;
}
