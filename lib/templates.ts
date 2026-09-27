/**
 * A template is only a starting hint: picking one on Home prefills the prompt
 * box with a ready-to-send request and the process to follow for that kind of
 * design, and adds a short brief to the agent's instructions. Every project
 * gets the same workspace and the same agent; nothing downstream branches on it.
 */
export type Prefill = {
  /** Opening words of the request, e.g. "Design a landing page for ". */
  lead: string;
  /** An example subject. It's selected after prefilling, so typing replaces it. */
  subject: string;
  /** The process the agent should follow for this kind of design. */
  steps: string[];
};

export type Template = {
  id: string;
  label: string;
  /** Only Blank has no prefill; it shows this hint in the empty box instead. */
  placeholder?: string;
  prefill?: Prefill;
  brief: string;
};

export const TEMPLATES: Template[] = [
  {
    id: "blank",
    label: "Blank",
    placeholder: "Describe what you want to create…",
    brief: "No fixed format. Decide the most fitting form for the request.",
  },
  {
    id: "mobile",
    label: "Mobile app design",
    prefill: {
      lead: "Design a mobile app for ",
      subject: "a habit tracker that helps people build small daily routines",
      steps: [
        "Work out who uses it and the 3 to 5 moments that matter most (for example onboarding, the main screen, adding an item, progress, settings).",
        "Pick a visual direction that fits those people: palette, type pairing and icon style.",
        "Design each screen as a phone frame with real content, side by side, with a caption above each.",
        "Make the key interactions work: tabs, toggles and moving between screens.",
        "Check spacing, tap target sizes and contrast, and fix anything that looks off.",
      ],
    },
    brief:
      "Mobile app screens. Lay out 3–5 key screens side by side as 390×844 phone frames (rounded corners, status bar, home indicator) on a quiet neutral canvas, each with a small caption above it. Real, specific content, never lorem ipsum. Make primary interactions work (tabs, toggles, navigation between screens) with a little vanilla JS where it's cheap.",
  },
  {
    id: "slides",
    label: "Slides",
    prefill: {
      lead: "Make a pitch deck about ",
      subject: "a startup that turns receipts into automatic expense reports",
      steps: [
        "Outline the story first: problem, solution, how it works, market, business model, traction, team and the ask. About 10 slides.",
        "Choose a bold, consistent look: one type pairing, a tight palette and a repeated layout grid.",
        "Build each slide with one idea, a big headline and real numbers.",
        "Write speaker notes for every slide.",
        "Read the deck in order for flow and consistency, and fix the weak slides.",
      ],
    },
    brief:
      'A slide deck. Each slide is a 1920×1080 <section class="slide">, stacked vertically with a gap and scaled with CSS to fit the viewport width. Include print CSS (@page { size: 1920px 1080px; margin: 0 } and a page break after each slide) so it exports as one slide per page. Arrow keys scroll to the next/previous slide. Present mode in this tool shows one .slide at a time full screen and PowerPoint export captures each .slide as an image, so every slide must stand on its own at 1920×1080. One idea per slide, big type, strong hierarchy; speaker notes go in a data-notes attribute.',
  },
  {
    id: "document",
    label: "Document",
    prefill: {
      lead: "Write a one-pager about ",
      subject: "why our team should adopt a four-day work week",
      steps: [
        "Decide who reads it and the one thing they should take away.",
        "Outline it: headline, short summary, 3 or 4 sections with the key evidence, and a clear next step.",
        "Write tight, specific copy. Use a table or pull quote only where it helps.",
        "Lay it out on a printable page with editorial typography.",
        "Proofread it and make sure it fits the page cleanly.",
      ],
    },
    brief:
      'A printable document. Use US Letter pages (<div class="page"> at 8.5in × 11in with real margins) shown as paper sheets with a soft shadow on a neutral background, plus @page rules so each .page prints as one sheet, and declare the page count with <meta name="pages" content="N">. Editorial typography: a clear type scale, measured line length, running header/footer where it helps.',
  },
  {
    id: "wireframe",
    label: "Wireframe",
    prefill: {
      lead: "Wireframe the flow for ",
      subject: "signing up and booking a first appointment at a dental clinic",
      steps: [
        "List every step of the flow from the entry point to success, including error and empty states.",
        "Sketch each screen as a grayscale wireframe with real labels and copy.",
        "Lay the screens out left to right with numbered steps and arrows between them.",
        "Annotate the intent behind the key elements and decisions.",
        "Walk through the flow once more and close any gaps or dead ends.",
      ],
    },
    brief:
      "Low-fidelity wireframes: grayscale boxes, real labels and copy, simple annotations explaining intent. Show several screens of the flow side by side with arrows or numbered steps between them. No decorative color or imagery.",
  },
  {
    id: "animation",
    label: "Animation",
    prefill: {
      lead: "Animate ",
      subject: "a logo reveal for a design studio called Northwind",
      steps: [
        "Plan the beats: how it starts, the main motion and how it settles, in about 3 to 5 seconds.",
        "Choose easing and timing that feel intentional, and keep the palette small.",
        "Build it so it plays on load, with a replay button.",
        "Expose the speed and key colors as tweaks.",
        "Watch it through and smooth out anything jerky or mistimed.",
      ],
    },
    brief:
      "An animation that plays on load, built with CSS keyframes, the Web Animations API, canvas or SVG. Include a small replay control. Expose speed/duration and key colors as tweaks so they can be adjusted live.",
  },
  {
    id: "ui",
    label: "UI mockups",
    prefill: {
      lead: "Design the UI for ",
      subject: "an analytics dashboard for a small online store",
      steps: [
        "Identify the key screens and what each one must let people do.",
        "Set up the visual system: grid, type scale, colors and components.",
        "Design each screen at desktop width with realistic data and copy.",
        "Show real component states: hover, selected, empty and loading where they matter.",
        "Review hierarchy, alignment and consistency across the screens.",
      ],
    },
    brief:
      "High-fidelity desktop UI mockups (1440px wide screens) with realistic data. Show the key screens stacked with a label above each, or one interactive prototype with a startScreen tweak that switches between them. Real component states: hover, selected, empty, loading where relevant.",
  },
  {
    id: "resume",
    label: "Résumé",
    prefill: {
      lead: "Create a résumé for ",
      subject: "a senior product designer with 8 years of experience in fintech",
      steps: [
        "Gather the details: roles, dates, achievements with numbers, skills and education. Use realistic sample details where I haven't given them.",
        "Write a short summary and achievement-focused bullet points.",
        "Lay it out on one page with refined typography and a single restrained accent color.",
        "Make sure it prints cleanly on one page.",
      ],
    },
    brief:
      'A one-page résumé that must print on exactly one US Letter page: <meta name="pages" content="1">, @page { size: Letter; margin: 0.5in }, and on screen a paper sheet 8.5in wide on a neutral backdrop. Clean semantic structure (name, contact, summary, experience, skills, education). A two-column layout stays two columns in print. If it runs long, tighten spacing and type or cut wording until it fits on one page; never spill onto a second page. Refined typography, restrained accent color, no photos or skill bars.',
  },
  {
    id: "3d",
    label: "3D object",
    prefill: {
      lead: "Build a realistic 3D model of ",
      subject: "a vintage 35mm film camera",
      steps: [
        "Study the real object first: its real dimensions, its main parts and exactly how they connect. Use a real 3D model if one exists.",
        "Model each part's true form (turned profiles, bevelled panels, curved surfaces, real details at the right scale), with every part attached to the one it sits on. No generic boxes, spheres or cylinders.",
        "Give every part its real material (metal, paint, rubber, fabric, glass) and light it like a product photo with an HDRI and soft shadows.",
        "Frame it with the camera fitted to the model, orbit controls and a subtle idle animation, and expose color and rotation speed as tweaks.",
        "Check it from the front, the side and above against the real thing, and fix anything that floats, is out of proportion or doesn't look real.",
      ],
    },
    brief:
      "A realistic 3D scene in Babylon.js, product-render quality: real proportions, parts that attach, physical materials, HDRI lighting, soft shadows, a camera fitted to the model and orbit controls. Follow the Realistic 3D guide; use a real model from its library when the request matches one. Expose color, rotation speed and similar as tweaks.",
  },
  {
    id: "landing",
    label: "Landing page",
    prefill: {
      lead: "Design a landing page for ",
      subject: "a meal-planning app for busy families",
      steps: [
        "Define the audience, the core value proposition and the one action visitors should take.",
        "Plan the sections: hero with a clear call to action, social proof, features or how it works, pricing, FAQ and footer.",
        "Write real, specific copy for every section.",
        "Pick a visual direction and build the page, responsive down to mobile.",
        "Review hierarchy, spacing and contrast, and fix what's weak.",
      ],
    },
    brief:
      "A marketing landing page at a 1440px design width that stays responsive: a hero with a sharp value proposition and primary CTA, social proof, features or how it works, pricing or a comparison where it fits, FAQ and footer. Real, specific copy.",
  },
  {
    id: "cinematic",
    label: "Cinematic scroll",
    prefill: {
      lead: "Design a cinematic scroll story for ",
      subject: "the launch of a new electric motorcycle",
      steps: [
        "Break it into 5 to 8 scenes with a real beginning, middle and turn, not just a list of sections.",
        "Write one shared visual style phrase (lighting, color grade, medium) and generate a real AI still for every scene, plus a foreground layer for any scene that needs depth.",
        "Build the scroll-scrub structure: sticky full-screen scenes with scroll-linked zoom, drift and parallax, crossfading into the next scene.",
        "Time each scene's copy to appear once its images have resolved and leave before the crossfade.",
        "Scroll through it slowly and fix anything that jumps, stutters or resolves too early or late.",
      ],
    },
    brief:
      "A scroll-driven cinematic page built from real AI-generated stills (generate_image), never static hero images or gradients standing in for them: 5-8 scenes as position: sticky full-screen sections with scroll-linked Ken Burns zoom, parallax depth and crossfade between scenes, following the Cinematic scroll guide's markup and scroll-scrub engine. One shared style phrase keeps every generated still part of the same world. A real story with a beginning, middle and turn; timed copy per scene.",
  },
  {
    id: "designsystem",
    label: "Design system",
    prefill: {
      lead: "Create a design system for ",
      subject: "a calm, modern personal finance brand",
      steps: [
        "Define the brand personality in a few words and let it drive every choice.",
        "Build the foundations: a color palette with roles and hex values, a Google Fonts type pairing with a type scale, and spacing and radius scales.",
        "Design the core components in their states: buttons, inputs, cards, navigation and badges.",
        "Present everything on one clear spec page.",
        "Save it as a design system so I can pick it for future projects.",
      ],
    },
    brief:
      "A design system. If a codebase is connected, extract its real tokens and components from the CSS / Tailwind / theme files instead of inventing them. Make one spec file: color palette with roles and hex values, a type scale using a Google Fonts pairing, spacing and radius scales, and core components (buttons, inputs, cards, navigation, badges) in their states. Then call save_design_system with 5–8 named colors (Background, Surface, Text, Accent, …) and the fonts so it can be picked for future projects.",
  },
  {
    id: "research",
    label: "Research",
    prefill: {
      lead: "Research ",
      subject: "how remote work has changed demand for city-center offices since 2020",
      steps: [
        "Ask me how deep to go (a quick overview, a standard report or a deep dive) and what to focus on.",
        "Break the question into 3 to 5 sub-questions.",
        "Search the web and read the most credible sources for each one.",
        "Lead with the answer, then the evidence, citing a source for every fact.",
        "Use tables or charts only where there are real numbers.",
        "Close with the open questions and what would change the conclusion.",
      ],
    },
    brief:
      'A cited research report laid out for print: US Letter pages with @page rules, a title block, a summary that leads with the answer, then sections with the evidence. Its length follows the depth the user picks when you scope the research first; declare it with <meta name="pages" content="3-5">. Use web_search and web_fetch to gather real facts. Every factual sentence ends with its source ID in brackets like [S3] or [S3, S5]; a numbered sources list is appended automatically, so don\'t write one. Use tables or charts only where there are real numbers.',
  },
  {
    id: "email",
    label: "HTML email",
    prefill: {
      lead: "Design an HTML email announcing ",
      subject: "the launch of our new summer menu",
      steps: [
        "Decide the one goal of the email and its call to action.",
        "Write the subject line, preheader, headline and short body copy.",
        "Build it so it works in real email clients.",
        "Add a bulletproof button and a simple footer with an unsubscribe link.",
        "Check it at mobile width and fix anything that breaks.",
      ],
    },
    brief:
      "An HTML email: 600px wide, table-based layout with inline styles, bulletproof buttons and web-safe font fallbacks, so it survives real email clients. Show it centered on a light gray backdrop.",
  },
  {
    id: "palette",
    label: "Color + type pairing",
    prefill: {
      lead: "Explore colors and type for ",
      subject: "an independent bookshop and café",
      steps: [
        "Describe 3 or 4 distinct moods that could fit.",
        "For each one, choose a Google Fonts pairing and a palette with named swatches and hex values.",
        "Show each direction as a specimen card with a small UI sample (button, card, heading).",
        "Check the text contrast on every palette.",
        "Recommend one direction and say why.",
      ],
    },
    brief:
      "A color and type exploration: 3–4 distinct directions, each a specimen card with a Google Fonts pairing (headline + body), a palette with named swatches and hex values, and a small UI sample (button, card, heading) using it.",
  },
];

export function getTemplate(id: string | null | undefined): Template {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
}

const tail = (p: Prefill) => `.\n\nProcess:\n${p.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;

/** The prompt a template prefills, with where its subject sits so the box can select it. */
export function prefillPrompt(t: Template, subject?: string): { text: string; start: number; end: number } | null {
  if (!t.prefill) return null;
  const s = (subject ?? t.prefill.subject).trim().replace(/[.\s]+$/, "");
  const start = t.prefill.lead.length;
  return { text: t.prefill.lead + s + tail(t.prefill), start, end: start + s.length };
}

/**
 * The subject of the text in the prompt box, when it can be carried over to
 * another template: the subject slot of an (edited) prefill, or a short
 * one-line request the user typed before picking a template. Null means the
 * box holds the user's own writing, which must not be overwritten.
 */
export function subjectOf(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return "";
  for (const t of TEMPLATES) {
    if (!t.prefill) continue;
    const end = tail(t.prefill);
    if (text.startsWith(t.prefill.lead) && text.endsWith(end)) {
      const s = text.slice(t.prefill.lead.length, text.length - end.length).trim();
      return s === t.prefill.subject ? "" : s;
    }
  }
  return trimmed.length <= 120 && !trimmed.includes("\n") ? trimmed : null;
}
