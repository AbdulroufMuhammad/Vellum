/**
 * Real AI video for scroll-scrubbed cinematic pages: NVIDIA Cosmos3 Nano image-to-video
 * (ai.api.nvidia.com/v1/cosmos/nvidia/cosmos3-nano, same NVIDIA_API_KEY). Every clip comes back
 * with its first and last frames extracted and stored, because the scroll-world technique chains
 * clips: each leg starts on the previous leg's ACTUAL last frame, so every seam is frame-identical.
 * Frames are pulled with the headless Chromium the visual check already ships (there's no ffmpeg on
 * the server); Cosmos returns VP9 in MP4, which Chromium decodes and seeks.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { BUCKET } from "./files";
import { launchBrowser } from "./browser";

// cosmos3-nano is a preview model: its documented ai.api.nvidia.com route 404s, so it's invoked through NVIDIA Cloud
// Functions by the function id its build.nvidia.com page carries (nvcfFunctionId), with the same key.
const COSMOS_FUNCTION_ID = process.env.COSMOS_FUNCTION_ID ?? "d09cd49d-d7f2-4361-928f-ea22af707249";
const COSMOS_URL = `https://api.nvcf.nvidia.com/v2/nvcf/pexec/functions/${COSMOS_FUNCTION_ID}`;
const NVCF_STATUS = "https://api.nvcf.nvidia.com/v2/nvcf/pexec/status";
const FPS = 24;

export type VideoResult = { url: string; first_frame_url: string; last_frame_url: string; seconds: number; width: number; height: number };

/** POST to Cosmos; long jobs come back 202 with an NVCF-REQID to poll until the result is ready. */
async function callCosmos(body: Record<string, unknown>, deadline: number, signal?: AbortSignal): Promise<Buffer> {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) throw new Error("video generation needs NVIDIA_API_KEY, which isn't set on this deployment");
  const left = () => Math.max(1000, deadline - Date.now());
  // NVCF holds the request open up to this long before answering 202 with an id to poll.
  const headers = { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json", "NVCF-POLL-SECONDS": String(Math.min(240, Math.floor(left() / 1000) - 5)) };
  const until = () => (signal ? AbortSignal.any([signal, AbortSignal.timeout(left())]) : AbortSignal.timeout(left()));
  let res = await fetch(COSMOS_URL, { method: "POST", headers, body: JSON.stringify(body), signal: until() });
  while (res.status === 202) {
    const reqId = res.headers.get("nvcf-reqid");
    if (!reqId) throw new Error("cosmos3-nano accepted the job but returned no request id to poll");
    if (Date.now() > deadline) throw new Error("the video was still rendering when this step ran out of time; call generate_video again with the same arguments");
    await new Promise((r) => setTimeout(r, 3000));
    res = await fetch(`${NVCF_STATUS}/${reqId}`, { headers: { Authorization: headers.Authorization, Accept: "application/json" }, signal: until() });
  }
  const text = await res.text();
  if (res.status === 422) throw new Error(`cosmos3-nano refused this request (${text.slice(0, 240)}). Reword the prompt (drop anything that could read as unsafe) and try again.`);
  if (!res.ok) throw new Error(`cosmos3-nano ${res.status}: ${text.slice(0, 300)}`);
  let json: { b64_video?: string | null };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`cosmos3-nano returned a non-JSON response: ${text.slice(0, 200)}`);
  }
  if (!json.b64_video) throw new Error(`cosmos3-nano response had no video: ${text.slice(0, 200)}`);
  return Buffer.from(json.b64_video, "base64");
}

/** The clip's first and last frames as JPEGs, decoded in headless Chromium. */
async function extractFrames(mp4: Buffer): Promise<{ first: Buffer; last: Buffer; width: number; height: number; duration: number }> {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const r = (await page.evaluate(async (b64: string) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const v = document.createElement("video");
      v.muted = true;
      v.preload = "auto";
      v.src = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
      await new Promise<void>((res, rej) => {
        v.onloadeddata = () => res();
        v.onerror = () => rej(new Error(`the browser couldn't decode the clip (media error ${v.error?.code})`));
        setTimeout(() => rej(new Error("decoding the clip timed out")), 20000);
      });
      const grab = async (t: number) => {
        await new Promise<void>((res) => {
          v.onseeked = () => res();
          v.currentTime = t;
        });
        const c = document.createElement("canvas");
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        c.getContext("2d")!.drawImage(v, 0, 0);
        return c.toDataURL("image/jpeg", 0.92).split(",")[1];
      };
      const first = await grab(0);
      const last = await grab(Math.max(0, v.duration - 0.04));
      return { first, last, width: v.videoWidth, height: v.videoHeight, duration: v.duration };
    }, mp4.toString("base64"))) as { first: string; last: string; width: number; height: number; duration: number };
    return { first: Buffer.from(r.first, "base64"), last: Buffer.from(r.last, "base64"), width: r.width, height: r.height, duration: r.duration };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function store(db: SupabaseClient, key: string, bytes: Buffer, type: string) {
  const { error } = await db.storage.from(BUCKET).upload(key, new Blob([new Uint8Array(bytes)], { type }), { contentType: type });
  if (error) throw new Error(`saving ${key.split("/").pop()} failed: ${error.message}`);
  return db.storage.from(BUCKET).getPublicUrl(key).data.publicUrl;
}

/** One camera-flight clip from a start image (a scene still, or the previous clip's last_frame_url). */
export async function generateVideo(
  db: SupabaseClient,
  projectId: string,
  args: { prompt: string; start_image: string; seconds?: number; ratio?: string; seed?: number },
  opts: { deadline: number; signal?: AbortSignal }
): Promise<VideoResult> {
  if (!/^https:\/\//.test(String(args.start_image ?? ""))) throw new Error("start_image must be an https URL: a generate_image url, or a previous clip's last_frame_url");
  const seconds = Math.min(8, Math.max(2, Number(args.seconds) || 5));
  const portrait = args.ratio === "9:16";
  const mp4 = await callCosmos(
    {
      model_mode: "image2video",
      prompt: String(args.prompt).slice(0, 4000),
      negative_prompt: "cuts, scene change, jump cut, text, captions, watermark, logo, distorted, warped, flicker, shaky camera",
      input_reference: args.start_image,
      resolution: portrait ? "720_9_16" : "720_16_9",
      num_frames: Math.min(197, Math.round(seconds * FPS) + 1),
      fps: FPS,
      num_inference_steps: 35,
      seed: args.seed ?? Math.floor(Math.random() * 1e9),
    },
    opts.deadline - 15_000,
    opts.signal
  );
  const frames = await extractFrames(mp4);
  const base = `${projectId}/generated/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [url, first_frame_url, last_frame_url] = await Promise.all([
    store(db, `${base}.mp4`, mp4, "video/mp4"),
    store(db, `${base}-first.jpg`, frames.first, "image/jpeg"),
    store(db, `${base}-last.jpg`, frames.last, "image/jpeg"),
  ]);
  return { url, first_frame_url, last_frame_url, seconds: Math.round(frames.duration * 10) / 10, width: frames.width, height: frames.height };
}

export const VIDEO_TOOL_SCHEMA = {
  type: "function" as const,
  function: {
    name: "generate_video",
    description:
      "Generate a real AI camera-flight video clip (NVIDIA Cosmos, image-to-video, 720p, 24 fps) that starts exactly on start_image and moves as the prompt describes. Returns the .mp4 url plus first_frame_url and last_frame_url (JPEGs of its actual first and last frames). To chain clips into one seamless flight, pass the previous clip's last_frame_url as the next clip's start_image, so every seam is frame-identical. Takes 1 to 3 minutes; call it once per clip, one at a time.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The single continuous camera move: where it starts, how it moves, what it arrives at, the shared style phrase. No cuts.",
        },
        start_image: { type: "string", description: "https URL of the first frame: a generate_image url for the first clip, then the previous clip's last_frame_url." },
        seconds: { type: "number", description: "Clip length, 2 to 8. Default 5." },
        ratio: { type: "string", enum: ["16:9", "9:16"], description: "16:9 (default) for desktop, 9:16 for a native mobile chain." },
      },
      required: ["prompt", "start_image"],
    },
  },
};
