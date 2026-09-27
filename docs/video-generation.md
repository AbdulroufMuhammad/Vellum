# Video generation (Cinematic scroll)

**Status: built, not yet available on this deployment.** Everything the Cinematic scroll
template needs is in place except a source of AI video. The NVIDIA key the app uses has no
image-to-video model, and the paid providers are on hold for now. Pointing one environment
variable at a self-hosted model turns it on, with no code change.

## What the feature does

It uses the [scroll-world](https://github.com/AbdulroufMuhammad/scroll-world) technique: scroll
position drives `video.currentTime` through one continuous AI-generated camera flight, the same
idea as Apple's scroll-through product pages. The camera really moves; scrolling only moves
through time.

- `generate_video` (`lib/tools/video.ts`) renders one clip from a start image (image-to-video,
  720p, 24 fps) and returns the `.mp4` plus JPEGs of its **actual** first and last frames.
  Frames are decoded in the headless Chromium the visual check already ships (no ffmpeg on
  the server). This was verified on a VP9-in-MP4 test clip, the format Cosmos returns.
- Clips are **chained**: each one starts on the previous clip's `last_frame_url`, so every seam
  between scenes is frame-identical (scroll-world's architecture A, one continuous forward take).
- The page mounts scroll-world's own MIT scrub engine, pinned on jsDelivr, with a config
  (`lib/cinematic.ts` has the full playbook). This was verified locally: scroll maps continuously
  to each clip's `currentTime`, the clips load as seekable blobs, and there were no errors.
- A clip takes minutes to render, so the agent renders one per step. A step that's short on
  time yields to the next one. Everything generated so far in the request (`settings.media` in
  `lib/agent.ts`) is handed back when a step resumes, so the chain never loses its links.
- If no video source works, the agent stops and says so. It never falls back to a slideshow of
  stills.

## Why it doesn't work yet (checked 2026-09-27)

- NVIDIA's catalog lists **cosmos3-nano** (image-to-video), but its documented hosted route
  `ai.api.nvidia.com/v1/cosmos/nvidia/cosmos3-nano` returns 404.
- Invoking it through NVIDIA Cloud Functions by the function id on its catalog page
  (`d09cd49d-d7f2-4361-928f-ea22af707249`) returns *"Function … Not found for account"*.
- `/api/access/nvidia-functions` (main key only) lists what the key can call. It sees 208 public
  functions, including `ai-flux_1-dev` (which is why image generation works), but **no
  video-generation function at all**. The only Cosmos entries are `ai-cosmos-nemotron-34b`
  (vision-language) and `ai-cosmos3-super-text2image` (text-to-image). The only one with "video"
  in its name is `ai-synthetic-video-detector`.

So this isn't an account setting that can be switched on from the NVIDIA dashboard; the hosted
API simply doesn't offer image-to-video to this key.

## Turning it on later

### Option A: self-hosted Cosmos NIM (free apart from the hardware)

Deploy the cosmos3-nano NIM on a machine with an NVIDIA GPU (see the model's page on
build.nvidia.com / NGC for supported GPUs and the container). A directly deployed NIM serves
`POST /v1/infer` with the same request and response as the hosted API, so the app talks to it
unchanged:

1. Make the NIM reachable over HTTPS from Vercel (e.g. behind a reverse proxy or tunnel).
2. In Vercel, set `COSMOS_URL=https://your-host/v1/infer`. If the endpoint requires a token,
   also set `COSMOS_API_KEY`, which is sent as `Authorization: Bearer …`.
3. Redeploy (Vercel only reads new variables on a new deploy).

Request the app sends (`model_mode: "image2video"`):

```json
{
  "model_mode": "image2video",
  "prompt": "Single continuous cinematic camera move, no cuts. ...",
  "negative_prompt": "cuts, scene change, jump cut, text, captions, watermark, ...",
  "input_reference": "https://…/start-frame.jpg",
  "resolution": "720_16_9",
  "num_frames": 121,
  "fps": 24,
  "num_inference_steps": 35,
  "seed": 12345
}
```

Expected response: `{ "b64_video": "<base64 MP4>" }`. `input_reference` is a public HTTPS URL
(Supabase Storage), so the NIM needs outbound internet access to fetch it.

### Option B: a paid provider

Only `callCosmos()` in `lib/tools/video.ts` talks to the provider; the frame chaining, the scroll
engine, the pause/resume handling and the playbook don't care where clips come from. To switch
providers, replace that one function so it returns MP4 bytes from a start image and a prompt.

- **Monid (Seedance 2.0)** is what scroll-world uses. It can match both the start *and* end frame
  of a clip, which also makes scroll-world's architecture B (aerial connectors that land on the
  next scene's exact first frame) possible. Pay per clip: scroll-world quotes about $11 for a
  6-scene film at 720p and about $27 at 1080p.
- **fal.ai / Replicate** offer Kling, Seedance and Wan image-to-video, also pay per clip.

## Verifying once enabled

1. **Probe:** on a Blank project, ask the agent to call `generate_video` once with an existing
   image URL, `seconds: 3`, and reply with the `url`, `first_frame_url` and `last_frame_url`. You
   should get an MP4 and two JPEGs, and the first frame should match the start image.
2. **Full film:** start from the **Cinematic scroll** template on Home. The agent asks for the art
   direction, camera style, scenes and mobile version, renders one clip per step, then writes the
   page. Scroll the result: the video should play forward and backward with the scroll and pass
   through every seam without a visible cut.

## Environment variables

| Variable | Purpose |
|---|---|
| `COSMOS_URL` | Self-hosted Cosmos NIM endpoint (`…/v1/infer`). When set, it's used instead of NVIDIA's hosted API. |
| `COSMOS_API_KEY` | Bearer token for that endpoint, or a separate NVIDIA key. Optional. |
| `COSMOS_FUNCTION_ID` | NVIDIA Cloud Functions id to try on the hosted API (defaults to the catalog page's id). |
