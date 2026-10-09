# NVIDIA NIM catalog

The full free/preview model catalog at [build.nvidia.com/models](https://build.nvidia.com/models),
read in full so nothing in it gets lost even though most of it has no use in this app. All of it
is reachable with the one `NVIDIA_API_KEY` already configured here, over the same OpenAI-compatible
endpoints `lib/gateway.ts` and `lib/tools/genai.ts` already call (`https://integrate.api.nvidia.com/v1`
for chat completions, `https://ai.api.nvidia.com/v1/genai/...` for image/3D generation). A model's
API id is the lowercase `publisher/slug` shown in its own page URL (e.g. `nvidia/nemotron-3-super-120b-a12b`)
verified by grepping that literal string out of the page's own HTML, not the separate
`NVIDIA-Xxx-BF16`/`-NVFP4` names the same pages also show, which name the downloadable weights for
self-hosting, not the hosted preview API.

## Wired into this app

Chat/build models (`lib/gateway.ts` `MODELS`, offered in the Model picker via the Models settings
page, `/access/models`), each verified on its own model card to say "Function Calling: Supported",
since the whole agent loop depends on `tool_calls`:

| Key | Model | Publisher |
|---|---|---|
| `glm` / `glm-flash` | glm-5-3 / glm-5-3-flash | Z.ai |
| `deepseek` | deepseek-chat (DeepSeek's own API, not NIM) | DeepSeek |
| `deepseek-v4` | deepseek-v4.1-flash | DeepSeek (via NVIDIA) |
| `gpt-oss` | gpt-oss-20b | OpenAI (open-weight) |
| `kimi` | kimi-k3 | Moonshot AI |
| `nemotron-super` | nemotron-3-super-120b-a12b | NVIDIA |
| `nemotron-lightning` | nemotron-3.5-lightning-30b-a3b | NVIDIA |
| `nemotron-ultra` | nemotron-3-ultra-550b-a55b | NVIDIA |
| `gemma` | gemma-4-31b-it | Google |

Vision-only helpers (`buildable: false`, never offered as a build model, used only by
`lib/tools/vision.ts`'s `describeImage()` to turn an attached or generated image into text for the
build model): `omni` (nemotron-3-nano-omni-30b-a3b-reasoning), `muse` (muse-glimmer-30b),
`llama-vision` (llama-3.2-11b-vision-instruct).

Generation tools (`lib/tools/genai.ts`): `generate_image` (FLUX.1-dev), `generate_3d_model`
(Microsoft TRELLIS).

## Everything else in the catalog

Read in full (~100 models) but out of scope for a web design tool, so intentionally not wired up.
Kept here in case a future feature needs one of them:

- **More image/3D generation** (could extend `generate_image`'s options or give it a faster/quality
  tier): FLUX.1-schnell, FLUX.1-Kontext-dev, flux.2-klein-4b (Black Forest Labs); qwen-image,
  qwen-image-edit (Alibaba); stable-diffusion-3.5-large (Stability AI).
- **More vision-language models** (alternate `describeImage()` fallbacks): llama-3.2-90b-vision-instruct
  (Meta), paligemma (Google), cosmos3-nano-reasoner, ising-calibration-1-35b-a3b /
  ising-calibration-1.5-31b (NVIDIA).
- **Speech**: canary-1b-asr, conformer-ctc-asr, parakeet-* (a family of ASR models per language),
  nemotron-asr-streaming (speech recognition); chatterbox-multilingual-tts, magpie-tts-multilingual,
  magpie-tts-zeroshot, nemotron-voicechat (text-to-speech / voice); Background Noise Removal, Studio
  Voice (audio enhancement).
- **Translation**: megatron-1b-nmt, riva-translate-1.6b, riva-translate-4b-instruct-v1_1,
  riva-translate-4b-instruct-v2.
- **OCR / document understanding**: nemoretriever-ocr, nemotron-ocr-v1/v2, paddleocr,
  nemotron-graphic-elements-v1, nemotron-page-elements-v3, nemotron-table-structure-v1,
  nemotron-parse, nemotron-parse-2.0.
- **Embedding / retrieval**: nemotron-3-embed-1b, llama-nemotron-embed-vl-1b-v2,
  llama-nemotron-rerank-vl-1b-v2.
- **Safety / moderation**: llama-guard-4-12b, llama-3.1-nemoguard-8b-content-safety,
  llama-3.1-nemoguard-8b-topic-control, llama-3.1-nemotron-safety-guard-8b-v3,
  nemotron-3.5-content-safety, nemoguard-jailbreak-detect.
- **Video**: cosmos-transfer2.5-2b, cosmos3-nano (generation; listed in the catalog, but not callable with this key: see [video-generation.md](video-generation.md)); Active Speaker Detection, eyecontact,
  LipSync, Relighting, synthetic-video-detector, Video Super Resolution NIM, wan2.2-animate-2-14b.
- **Science / biology / chemistry**: Boltz-2, diffdock, evo2-40b/-40b-forward/-7b-forward, genmol,
  molmim, msa-search, openfold2, openfold3, proteinmpnn, rfdiffusion (protein/molecule structure
  and design); fourcastnet (weather).
- **Autonomous driving / robotics / other simulation**: bevformer, sparsedrive, streampetr;
  fidelity, fluent, simcenter-star-ccm+ (CFD); spectre-x (chip design); cuopt (route optimization);
  Kumo Relational.
- **Experimental / other LLMs**: diffusiongemma-26b-a4b-it (diffusion-based, unconfirmed tool-calling).
