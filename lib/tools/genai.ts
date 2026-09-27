/**
 * NVIDIA's hosted GenAI NIM endpoints (ai.api.nvidia.com/v1/genai/...): real AI image and 3D-mesh
 * generation, using the same NVIDIA_API_KEY as the chat models in lib/gateway.ts (a different host
 * and response shape, so its own thin client rather than reusing gateway.ts's chat-completions one).
 * Both return { artifacts: [{ base64 }] } with the asset's bytes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { BUCKET } from "./files";
import { describeImage } from "./vision";

const GENAI_BASE = "https://ai.api.nvidia.com/v1/genai";

async function callGenAI(path: string, body: Record<string, unknown>, timeoutMs: number): Promise<Buffer> {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) throw new Error("image and 3D generation need NVIDIA_API_KEY, which isn't set on this deployment");
  const res = await fetch(`${GENAI_BASE}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 300)}`);
  let json: { artifacts?: { base64?: string }[] };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned a non-JSON response: ${text.slice(0, 200)}`);
  }
  const b64 = json.artifacts?.[0]?.base64;
  if (!b64) throw new Error(`${path} response had no artifact: ${text.slice(0, 200)}`);
  return Buffer.from(b64, "base64");
}

const RATIO_SIZE: Record<string, [number, number]> = {
  "1:1": [1024, 1024],
  "16:9": [1344, 768],
  "9:16": [768, 1344],
  "4:5": [896, 1152],
  "5:4": [1152, 896],
  "3:2": [1216, 832],
  "2:3": [832, 1216],
};

/**
 * A real photo or illustration from a text prompt (FLUX.1-dev), stored and returned as a URL to use in an
 * <img> or as a texture. When args.purpose is "reference", also runs the generated image straight back
 * through the vision model with a proportions/parts/color-zone prompt, so the caller gets concrete visual
 * grounding (not just a URL it can't itself see) in the same call, before it writes any geometry.
 */
export async function generateImage(
  db: SupabaseClient,
  projectId: string,
  args: { prompt: string; ratio?: string; seed?: number; purpose?: "photo" | "reference" },
  visionOpts?: { deadline: number; signal?: AbortSignal }
): Promise<{ url: string; description?: string }> {
  const [width, height] = RATIO_SIZE[args.ratio ?? "1:1"] ?? RATIO_SIZE["1:1"];
  const png = await callGenAI(
    "black-forest-labs/flux.1-dev",
    { prompt: args.prompt.slice(0, 2000), mode: "base", cfg_scale: 3.5, width, height, seed: args.seed ?? Math.floor(Math.random() * 1e9), steps: 30 },
    55_000
  );
  const key = `${projectId}/generated/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const { error } = await db.storage.from(BUCKET).upload(key, new Blob([new Uint8Array(png)], { type: "image/jpeg" }), { contentType: "image/jpeg" });
  if (error) throw new Error(`saving the generated image failed: ${error.message}`);
  const url = db.storage.from(BUCKET).getPublicUrl(key).data.publicUrl;
  if (args.purpose !== "reference" || !visionOpts) return { url };
  try {
    const description = await describeImage(url, { deadline: visionOpts.deadline, signal: visionOpts.signal, purpose: "reference" });
    return { url, description };
  } catch {
    return { url };
  }
}

/** A real generated 3D mesh (Microsoft TRELLIS) from a text prompt, stored and returned as a .glb URL to load with GLTFLoader/SceneLoader. */
export async function generateMesh3D(
  db: SupabaseClient,
  projectId: string,
  args: { prompt: string; seed?: number }
): Promise<{ url: string }> {
  const glb = await callGenAI(
    "microsoft/trellis",
    {
      prompt: args.prompt.slice(0, 2000),
      slat_cfg_scale: 3,
      ss_cfg_scale: 7.5,
      slat_sampling_steps: 12,
      ss_sampling_steps: 12,
      seed: args.seed ?? Math.floor(Math.random() * 1e9),
    },
    170_000
  );
  const key = `${projectId}/generated/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.glb`;
  const { error } = await db.storage.from(BUCKET).upload(key, new Blob([new Uint8Array(glb)], { type: "model/gltf-binary" }), { contentType: "model/gltf-binary" });
  if (error) throw new Error(`saving the generated mesh failed: ${error.message}`);
  return { url: db.storage.from(BUCKET).getPublicUrl(key).data.publicUrl };
}

export const GENAI_TOOL_SCHEMAS = [
  {
    type: "function" as const,
    function: {
      name: "generate_image",
      description:
        "Generate a real AI photo or illustration from a text description (FLUX.1-dev). With purpose \"photo\" (default), it's for use as a design's hero image, photo or texture: returns a URL to use directly as an <img src> or CSS background-image. With purpose \"reference\", use it BEFORE building anything with a specific, well-known or branded visual identity (a named character, real vehicle, franchise design, logo) in 3D or in a detailed illustration: it also runs the image back through a vision model with a proportions/parts/color-zone prompt, and returns that description alongside the URL, so you get real visual grounding (exact proportions, part boundaries, color zones) instead of relying on memory alone. Takes 10-30 seconds (a little longer with purpose \"reference\").",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "A detailed visual description: subject, style, lighting, composition." },
          ratio: { type: "string", enum: Object.keys(RATIO_SIZE), description: "Aspect ratio; default 1:1." },
          purpose: { type: "string", enum: ["photo", "reference"], description: "\"reference\" also returns a proportions/parts/color-zone description for building from. Default \"photo\"." },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "generate_3d_model",
      description:
        "Generate a real 3D mesh from a text description (Microsoft TRELLIS), for an organic or intricate one-piece object that would be impractical to hand-model with primitives and CSG (a creature, a piece of fruit, an ornate sculpted object). Returns a .glb URL: load it with GLTFLoader (three.js) or SceneLoader.ImportMeshAsync (Babylon.js), the same as a real model from the library. Not for objects that need separate, labelled or arrangeable parts (build those by hand instead). Takes up to 2-3 minutes.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "A detailed description of the single object to generate." },
        },
        required: ["prompt"],
      },
    },
  },
];
