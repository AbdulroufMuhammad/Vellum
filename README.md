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
  files), `web_search` / `web_fetch` (Tavily, cited by short source IDs),
  `repo_tree` / `repo_read` (the connected GitHub codebase), and
  `ask_questions` (a clarifying form of up to 8 questions, each with the field
  that fits: single or multiple choice, dropdown, short or long text, number,
  slider or yes/no; `lib/questions.ts`). It narrates each step,
  which the chat shows as activity rows, and the file being written streams to
  the canvas as it's generated.
- **Design systems** — when a project makes a design system (the Design system
  template, or asking for one), it's saved to the design system picker and
  applied to the project. The agent saves it with `save_design_system`; if it
  doesn't, the tokens are read from the spec file's CSS variables and fonts
  (`lib/extractDesignSystem.ts`). Later revisions of that spec update the same
  saved system instead of adding copies.
- **Realistic 3D** — 3D requests get a playbook (`lib/threeD.ts`): plan real
  dimensions and a parts list with what each part attaches to; build in group
  hierarchies with lathe, bevelled extrusions, rounded boxes, tubes between
  real anchor points and instanced repeats; physical materials; HDRI lighting
  from three.js's example environment maps; a camera fitted to the model; or a
  real glTF model from a verified library (Khronos samples, three.js examples)
  when the request matches one; creatures, characters and other sculpted forms
  are built as one continuously blended field with MarchingCubes instead of
  glued-together parts, so limbs and joints fuse instead of showing a seam;
  hatches, vents, bolt holes and recessed panels on hard-surface parts are
  real boolean cuts through the geometry (three-bvh-csg), not decals painted
  on top. Scenes expose `window.__vellum3d`, and the
  check reports parts that float, a model cut off by the frame or spanning
  under 40% of it (judged from the model's vertices, with floors, backdrops,
  back-side domes and enclosing scenery left out), and photographs it from the
  front, side and three-quarter view for the reviewer.
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
  (90s when planning) is cut, its thinking kept, and the rest of the request is
  handed to DeepSeek V3 with that plan.
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
  a cached summary. Each turn has a research allowance, and models fall back
  GLM → GLM Flash → DeepSeek, skipping a provider whose key was rejected.
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
  registry, an idle (not total) timeout so long files can finish, and a
  one-shot fallback to a second provider.
- **Time limits** — a turn that nears the function's time budget pauses and
  the client resumes it automatically in a fresh invocation.

## Setup

```bash
cp .env.example .env.local
# fill in SUPABASE_SERVICE_ROLE_KEY, NVIDIA_API_KEY / DEEPSEEK_API_KEY,
# TAVILY_API_KEY, and optionally GITHUB_TOKEN / GITHUB_OWNER
npm install
npm run dev
```

Migrations live in `supabase/migrations/` (the Supabase project is
`demonic-search`, `gsoiexqtaiyjepzqyfso`).

## Not implemented yet

PPTX export, design-system extraction from uploaded brand files, image
attachments (attachments are text files), and a local-folder codebase option.
