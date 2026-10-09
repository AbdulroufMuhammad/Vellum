# Vellum

A Claude Design–style design tool on open models. Describe what you want,
pick a template and design system, and a design agent builds it live on a
canvas — then you iterate by chatting, commenting on elements, editing text
and type directly, or sliding the design's own tweak controls. Exports to PDF,
PNG, PowerPoint or standalone HTML.

(Formerly "Demonic Search"; the repository, Vercel project and Supabase
project keep that name.)

It runs on OpenAI-compatible chat-completions endpoints (NVIDIA NIM /
DeepSeek) over raw HTTP — no vendor SDK — with **Supabase** for projects,
messages, the agent event log, web sources and versioned design files
(Storage). There are no user accounts: every project is open to whoever has
its URL, and the app talks to Supabase through the service-role client.

## Access keys

Vellum is private. Every page and API call needs an access key, except the
key entry page (`/access`) and view-only share links (`/p/<id>` and the
read-only file, render and export endpoints they use).

- **Main key**: the `MAIN_ACCESS_KEY` environment variable. It opens the app
  and is the only key that can manage keys (avatar menu → Access keys,
  `/access/keys`). Changing it signs everyone out.
- **Temporary keys**: created by the main key with an expiry (1 hour to 365
  days, or a chosen date and time), shown once, stored only as SHA-256 hashes
  in `access_keys`. They give full use of the app but can't manage keys, and
  can be revoked; a revoked key stops working within about 30 seconds.
- Entering a key sets a signed, httpOnly session cookie (`middleware.ts`,
  `lib/accessKeys.ts`, `lib/accessServer.ts`). Without `MAIN_ACCESS_KEY` a
  deployment stays locked; local development stays open.
- **Models** (avatar menu → Models, `/access/models`, main key only): which
  build models show up in the Model picker. `lib/gateway.ts`'s `MODELS`
  registry holds every model this app can call: GLM 5.3, GLM 5.3 Flash,
  DeepSeek V3 (DeepSeek's own API), and free NVIDIA NIM models (same
  `NVIDIA_API_KEY`, `https://integrate.api.nvidia.com/v1`): DeepSeek V4.1
  Flash, GPT-OSS 20B, Kimi K3, Mistral Nemotron, Nemotron 3 Super, Nemotron
  3.5 Lightning, Nemotron 3 Ultra, Gemma 4. Nemotron Omni, Muse Glimmer and
  Llama 3.2 Vision are vision-only (`describeImage()`'s fallback chain) and
  never offered as a build model. `docs/nvidia-nim-catalog.md` has the full
  ~100-model catalog this was drawn from, verified endpoint and all, and what
  the rest of it could still be used for. The enabled subset is saved to the
  `app_settings` table (`lib/modelSettings.ts`) and read by both Home and the
  project page; a project already using a model that's since been disabled
  keeps it selectable. `/api/access/model-test?model=kimi` (main key only)
  sends one tiny prompt and returns the raw reply, with optional
  `temperature` / `top_p` overrides, to diagnose a model without exposing
  the key. When a model rejects a sampling value ("`top_p` is immutable for
  this model and must be 0.95"), the gateway retries with the required value
  and remembers it.
- **GitHub** (avatar menu → GitHub, `/access/github`, main key only): connect
  a GitHub account with a fine-grained token (Contents: read-only) so the
  codebase picker lists your repositories, private ones included, and the
  agent can read them. The token is checked with GitHub, then stored
  encrypted (AES-256-GCM, key from `GITHUB_TOKEN_SECRET` or else the
  Supabase service-role key) in `app_settings.github`, and never sent back to
  a browser (`lib/githubAccount.ts`). Only main-key sessions ever use it, for
  the picker and for the agent's own turns; temporary keys see public
  repositories only, even on a project that has a private one attached. A
  `GITHUB_TOKEN` environment variable follows the same main-only rule.

## How it works

- **Home** (`app/page.tsx`, `components/home/*`) — composer with a design
  system picker, model picker and GitHub codebase picker; a template grid
  (Blank, Mobile app, Slides, Document, Wireframe, Animation, UI mockups,
  Résumé, 3D object, Landing page, Design system, Research, HTML email,
  Color + type pairing); and a projects table/grid with live thumbnails.
  Picking a template (other than Blank) prefills the prompt with a complete
  request and that template's own step-by-step process (`lib/templates.ts`);
  the example subject is selected so typing replaces it, and it carries over
  when you switch templates.
- **Workspace** (`components/project/*`) — the same for every project: chat on
  the left, canvas on the right. A template is only a hint to the agent; it
  never changes the UI.
- **Design agent** (`lib/agent.ts`) — one conversational tool-use loop per
  message. Tools: `write_file` / `str_replace` / `read_file` (versioned HTML
  files), `web_search` / `web_fetch` (Seekly, a self-hosted Tavily-shaped
  search API at search.amatip.com, `lib/tools/search.ts`; cited by short
  source IDs),
  `repo_tree` / `repo_read` (the connected GitHub codebase), `generate_image` /
  `generate_3d_model` (real AI image and mesh generation, `lib/tools/genai.ts`),
  and `ask_questions` (a clarifying form of up to 8 questions, each with the
  field that fits: single or multiple choice, dropdown, short or long text,
  number, slider or yes/no; `lib/questions.ts`). It narrates each step,
  which the chat shows as activity rows, and the file being written streams to
  the canvas as it's generated.
- **Cinematic scroll** (`lib/cinematic.ts`, `lib/tools/video.ts`) — scroll
  drives one continuous flight through the story, three possible sources.
  **Animated scenes work today, free and instant:** `mountScrollAnimation`
  (embedded per-project, not an external dependency) lets the agent draw the
  whole flight itself, canvas 2D and/or Web Animations API timelines over
  DOM/SVG (the Animation template's own technique, aimed at a scroll-driven
  clock instead of played on load), with exact seams since the same code
  draws both sides of every one. This is the template's default while no
  video model is available. **Users' own clips also work today:** attach them
  in the composer (MP4, WebM or MOV, up to 12, 50 MB each; uploaded straight
  to Storage through a signed URL, with each clip's first and last frames
  read in the browser), and the Cinematic scroll template on Home shows
  exactly what to upload. **AI video generation is built but not available
  yet:** NVIDIA's hosted API offers no image-to-video model to this
  deployment's key, so `generate_video` stops with a clear message until
  `COSMOS_URL` points at a self-hosted Cosmos NIM (or a paid provider is
  wired in). See [docs/video-generation.md](docs/video-generation.md) for
  what was checked, how to turn it on, and how to verify it. For the two
  video-based sources, the [scroll-world](https://github.com/AbdulroufMuhammad/scroll-world)
  technique applies: `generate_video` returns each clip with its actual first
  and last frames (decoded in the server's headless Chromium, no ffmpeg
  needed), so each leg starts on the previous leg's real last frame and every
  seam is frame-identical, and the page mounts scroll-world's own MIT scrub
  engine (pinned on jsDelivr) with a config. A clip takes minutes, so the
  agent renders one per step; a step short on time yields to the next, and
  everything generated so far in the request (`settings.media`) is handed
  back on resume so the chain never loses its links.
- **Real generated images and meshes** (`lib/tools/genai.ts`) — NVIDIA's
  hosted GenAI endpoints: `generate_image` (FLUX.1-dev) for a genuine photo or
  illustration, used as a design's hero image, photo or texture; `generate_3d_model`
  (Microsoft TRELLIS) for a real one-piece mesh (an organic or intricately
  sculpted object impractical to hand-model), returned as a .glb the same as a
  library model. Calling `generate_image` with `purpose: "reference"` also runs
  the image straight back through the vision model with a proportions/parts/
  color-zone prompt, so the agent gets a concrete visual breakdown, not just a
  URL it can't itself see: the 3D playbook calls this first, before planning
  parts, for anything with a specific, well-known or branded visual identity.
- **Design systems** — when a project makes a design system (the Design system
  template, or asking for one), it's saved to the design system picker and
  applied to the project. The agent saves it with `save_design_system`; if it
  doesn't, the tokens are read from the spec file's CSS variables and fonts
  (`lib/extractDesignSystem.ts`). Later revisions of that spec update the same
  saved system instead of adding copies.
- **Realistic 3D** — 3D requests get a playbook: plan real dimensions and a
  parts list with what each part attaches to; build in a hierarchy with lathe,
  bevelled extrusions, tubes between real anchor points and instanced repeats;
  physical materials; HDRI lighting; a camera fitted to the model; or a real
  glTF model from a verified library (Khronos samples, three.js examples) when
  the request matches one. New builds use **Babylon.js** (`lib/babylon3D.ts`):
  it needs far less manual setup for a correct-looking result (one call each
  for shadows, environment lighting and orbit controls) and its CSG2 (the
  Manifold library) computes real boolean cuts for hatches, vents, bolt holes
  and recessed panels, batched into one operation per repeated cut rather than
  chained one at a time, which was measured to make the difference between a
  check that finishes and one that crashes the browser on a heavy model. Older
  projects still use three.js (`lib/threeD.ts`, kept for compatibility: the
  same real-model library and HDRIs, its own MarchingCubes technique for
  sculpted organic forms, and three-bvh-csg for the same real cuts). Scenes
  expose `window.__vellumBabylon` or `window.__vellum3d`, and either way the
  check reports parts that float, a model cut off by the frame or spanning
  under 40% of it (judged from the model's vertices, with floors, backdrops,
  back-side/culling-off domes and enclosing scenery left out), and photographs
  it from the front, side and three-quarter view for the reviewer. A renderer
  crash mid-check (an overloaded scene) is reported to the agent as a plain
  diagnosis instead of a raw browser error, so it knows to simplify or batch.
- **Math and graphs** (`lib/finalize.ts`) — any file with LaTeX (`\( \)`,
  `\[ \]`, `$$`) but no renderer gets KaTeX + auto-render injected into
  `<head>` on every write, and any `<div data-plot='{…}'>` gets function-plot
  plus a mount script, so math and graphs render even when a long document's
  final part (where scripts would go) is never written. Graphs are computed
  from the function (exact curves, tangents, shaded areas), never hand-drawn.
- **Starter design systems** (`lib/designSystemsServer.ts`) — Nocturne,
  Organic, Modernist and Classical are restored automatically whenever they're
  missing from `design_systems` (e.g. after the table is cleared).
- **One script per page** — if a page built in parts ends up with its code in
  several `<script type="module">` blocks and a later one uses an earlier
  one's variables, writes merge them into one module (each import kept once);
  independent or clashing modules are left alone.
- **Split runs** — a new design (or a big request) runs as three steps, each
  its own serverless invocation with its own time budget and its own section
  in the chat: **planning** (think, research, ask; hand in a plan with
  `submit_plan`, shown as a plan card), **building** (write the files from the
  plan) and **checking** (browser check first, then fixes and the reply).
  Small follow-up edits run as one step. A step that only deliberates for 45s
  (90s when planning) is cut, its thinking kept, and the same selected model is
  told to act on that plan — the model never changes mid-request.
- **Pages and files** — the canvas header's menu lists the project's pages
  (newest first, with edit times), a **New blank page**, and **All project
  files**: pages and uploads side by side with a preview, **New sketch** (a
  drawing pad whose PNG goes to the agent as an attachment), **Paste** and a
  drop zone. Version history has its own button.
- **Versions** — one version per finished request: writes during a request
  (plan, build, check and fixes, across resumes) update a single working
  version, which becomes final when the request is done and checked. The next
  request, or the user's own edit, starts a new version.
- **Live canvas** — the moment a plan is handed in, a wireframe of it (palette,
  sections) is drawn on the canvas (`lib/planPreview.ts`); then every
  write_file and append_file streams onto the canvas as it's written.
- **Visual check** (`lib/tools/visualCheck.ts`) — the agent's `check_design`
  tool renders a file in headless Chromium (`@sparticuz/chromium` on Vercel),
  runs automatic checks (JS errors, sideways overflow at desktop and phone
  widths, broken images, low-contrast and clipped text), and sends screenshots
  to a vision model (Nemotron Omni, falling back to Muse Glimmer). Printable
  designs (an `@page` rule, `<meta name="pages" content="1">`, a résumé, or a
  research report with a chosen depth) are also printed to PDF: the real page
  count is checked against the target and the printed pages go to the
  reviewer. Width-only media queries in printable designs are limited to
  screens (`lib/finalize.ts`), so a Letter page doesn't get the phone layout. The agent
  fixes what's found; the chat shows the screenshot and findings, and the
  canvas toolbar has a Check button to run it on demand.
- **Attachments** — images (downscaled in the browser, stored in Storage) are
  described once by the vision model so the text model can design from them,
  and can be placed in designs; text files and a local code folder's UI files
  (CSS, components, theme/Tailwind config) are passed as context. Paste images
  straight into the composer, or dictate with the mic button.
- **Comments** — each comment stays pinned to its element (numbered pins in
  Comment mode) with the agent's reply, until you resolve it.
- **Ask first** — every new request (on any template and any model) opens
  with a short form before anything is designed: how deep to go (a scope
  question phrased per template in `lib/templates.ts`, e.g. slide count, page
  count, number of screens, level of 3D detail), what type or style, and what
  the request leaves open. Design tools are blocked until it's asked; the form
  has "Skip, use your judgement". Small edits, element comments and messages
  that say not to ask go straight through.
- **Research depth** — a research project is scoped first with a form that
  always asks how deep to go (quick overview, standard report or deep dive,
  `lib/research.ts`); the choice sets the sources read per turn and the
  report's printed page count.
- **Present & export** — Present slides shows one slide at a time full screen
  with speaker notes; Share exports PDF (printed on the server by Chromium,
  like the check), PNG, PowerPoint and HTML, and
  copies a Claude Code handoff prompt. PowerPoint (`lib/pptxExport.ts`) keeps
  each slide's look as a background image with real, editable text boxes on
  top (fonts, sizes, colors, bold/italic, bullets, speaker notes); "exact look"
  exports each slide as one picture instead.
- **Long chats** — the last 12 messages go to the model verbatim; older ones as
  a cached summary. Each turn has a research allowance. A request only ever
  uses the model picked; there is no fallback to another model.
- **Canvas** (`components/project/Canvas.tsx`, `lib/canvasBridge.ts`) — designs
  run in an iframe sandboxed without `allow-same-origin`; a small injected
  bridge handles Comment mode (click anything → comment goes to the agent with
  that element's HTML), Edit mode (type in place, size/leading/spacing/weight/
  color/alignment), tweaks, page counting and streamed drafts.
- **Tweaks** — the agent declares live controls in the file
  (`<script type="application/json" id="tweaks">`); the canvas applies them as
  CSS variables, `data-*` attributes and a `tweak` event, and saves values
  back into the file.
- **Versions** — every write is a new immutable version in Storage; the file
  menu lists versions to preview or restore.
- **Model gateway** (`lib/gateway.ts`) — streaming client with a model
  registry, an idle (not total) timeout so long files can finish. A failing model
  reports its own error rather than being swapped for another.
- **Time limits** — a turn that nears the function's time budget pauses and
  the client resumes it automatically in a fresh invocation.

## Setup

```bash
cp .env.example .env.local
# fill in SUPABASE_SERVICE_ROLE_KEY, NVIDIA_API_KEY / DEEPSEEK_API_KEY,
# SEEKLY_API_KEY, and optionally GITHUB_OWNER (public repos for the picker),
# GITHUB_TOKEN (main key only) and GITHUB_TOKEN_SECRET (encrypts the connected
# GitHub account's token; defaults to one derived from the service-role key)
npm install
npm run dev
```

Migrations live in `supabase/migrations/` (the Supabase project is
`demonic-search`, `gsoiexqtaiyjepzqyfso`).

## Not implemented yet

PPTX export, design-system extraction from uploaded brand files, image
attachments (attachments are text files), and a local-folder codebase option.
