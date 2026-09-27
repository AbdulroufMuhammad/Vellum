import type { Page } from "playwright-core";

/**
 * Exporting a design's own motion as a file: for the Animation template (or anything else that
 * plays on load) there was no way to get the motion out, only a still PNG. The server has no
 * ffmpeg (Playwright's own bundled one needs its browsers cache, which the serverless deployment
 * doesn't ship, only @sparticuz/chromium's single binary; verified: recordVideo fails without it),
 * so this captures screenshots frame by frame and encodes them into an animated GIF entirely in
 * the browser with gifenc (pure JS, no native codec), the same "load a small library from a CDN
 * inside a headless page" pattern KaTeX, function-plot and scroll-world already use here.
 */

const MAX_SECONDS = 6;
const MIN_SECONDS = 1;
const FPS = 15;
/** Caps total capture + encode time and file size; a longer clip gets a lower frame rate instead of more frames. */
const MAX_FRAMES = 90;

/** The design's own `<meta name="duration" content="4">` (seconds), the same convention as `<meta name="pages">`. */
export function declaredDuration(html: string): number | null {
  const tag = /<meta[^>]+name=["']duration["'][^>]*>/i.exec(html)?.[0];
  const n = tag && Number(/content=["']\s*([\d.]+)\s*["']/i.exec(tag)?.[1]);
  return n && Number.isFinite(n) && n > 0 ? n : null;
}

const HARNESS = `<!doctype html><html><body><canvas id="c"></canvas>
<script type="module">
import { GIFEncoder, quantize, applyPalette } from "https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js";
window.__encodeGif = async (frames, w, h) => {
  const canvas = document.getElementById("c");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const gif = GIFEncoder();
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const blob = await (await fetch("data:image/png;base64," + f.png)).blob();
    const img = await createImageBitmap(blob);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    const palette = quantize(data, 256);
    const index = applyPalette(data, palette);
    // GIF delays are in 1/100s; the real gap between two captures (screenshot + encode overhead
    // included) is what the played-back timing should match, not an assumed even frame rate.
    gif.writeFrame(index, w, h, { palette, delay: Math.max(20, f.delayMs), first: i === 0 });
  }
  gif.finish();
  const bytes = gif.bytes();
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
};
window.__gifReady = true;
</script>
</body></html>`;

/**
 * Renders `page`'s own motion (already loaded and settled by the caller) to an animated GIF: plain
 * screenshots, timed by how long each one actually took, encoded client-side. `page` navigates away
 * to the encoder harness partway through; the caller is done with the design content by then.
 */
export async function renderGif(page: Page, requestedSeconds: number | null): Promise<Buffer> {
  const seconds = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, requestedSeconds ?? 4));
  const fps = Math.max(4, Math.min(FPS, Math.floor(MAX_FRAMES / seconds)));
  const count = Math.max(2, Math.round(seconds * fps));
  const size = page.viewportSize() ?? { width: 960, height: 600 };

  const frames: { png: string; delayMs: number }[] = [];
  let last = Date.now();
  for (let i = 0; i < count; i++) {
    const buf = await page.screenshot({ type: "png" });
    const now = Date.now();
    frames.push({ png: buf.toString("base64"), delayMs: now - last });
    last = now;
  }

  await page.setContent(HARNESS, { waitUntil: "load" });
  await page.waitForFunction(() => (window as unknown as { __gifReady?: boolean }).__gifReady === true, null, { timeout: 15_000 });
  const b64 = (await page.evaluate(
    (arg) => (window as unknown as { __encodeGif: (f: unknown, w: number, h: number) => Promise<string> }).__encodeGif(arg.frames, arg.w, arg.h),
    { frames, w: size.width, h: size.height }
  )) as string;
  return Buffer.from(b64, "base64");
}
