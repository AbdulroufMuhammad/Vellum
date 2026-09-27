import { getProject, notFoundResponse } from "@/lib/access";
import { readFile } from "@/lib/projectData";
import { launchBrowser, openDesign } from "@/lib/tools/browser";
import { buildPptx } from "@/lib/pptxExport";
import { prepareForDisplay } from "@/lib/finalize";
import { declaredDuration, renderGif } from "@/lib/gifExport";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function attachment(name: string, ext: string) {
  const base = name.replace(/\.html$/i, "").replace(/["\\\r\n]/g, "") || "design";
  return `attachment; filename="${base}.${ext}"; filename*=UTF-8''${encodeURIComponent(`${base}.${ext}`)}`;
}

/**
 * Downloads: standalone HTML; PDF printed by Chromium (the same printing the
 * automatic check measures pages with); PNG (full-page render); GIF (motion that plays
 * on load, captured frame by frame and encoded client-side, since the server has no
 * video encoder; lib/gifExport.ts); PPTX for slide decks with speaker notes, editable
 * text by default or one image per slide with mode=image (lib/pptxExport.ts).
 */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const res = await getProject(params.id);
  if (!res.ok) return notFoundResponse();
  const sp = new URL(req.url).searchParams;
  const format = sp.get("format") ?? "html";
  const file = await readFile(res.admin, params.id, sp.get("path") ?? "");
  if (!file) return Response.json({ error: "file not found" }, { status: 404 });
  file.content = prepareForDisplay(file.content);

  if (format === "html") {
    return new Response(file.content, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Content-Disposition": attachment(file.path, "html") },
    });
  }
  if (format !== "png" && format !== "gif" && format !== "pptx" && format !== "pdf") return Response.json({ error: "format must be html, pdf, png, gif or pptx" }, { status: 400 });

  const browser = await launchBrowser();
  try {
    if (format === "pdf") {
      // The design's own @page size and margins; US Letter when it has none.
      const page = await openDesign(browser, file.content, { width: 1280, height: 900 });
      const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, format: "Letter" });
      return new Response(new Uint8Array(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": attachment(file.path, "pdf") } });
    }
    if (format === "png") {
      const page = await openDesign(browser, file.content, { width: 1440, height: 900 });
      const height = Math.min(16_000, (await page.evaluate("document.documentElement.scrollHeight")) as number);
      const png = await page.screenshot({ type: "png", fullPage: true, clip: { x: 0, y: 0, width: 1440, height } });
      return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Content-Disposition": attachment(file.path, "png") } });
    }
    if (format === "gif") {
      const page = await openDesign(browser, file.content, { width: 960, height: 600 });
      // Canvas/WebGL scenes get a moment to start drawing before capture begins, same as the visual check.
      if (/<canvas|three\.js|webgl|requestAnimationFrame/i.test(file.content)) await page.waitForTimeout(400);
      const gif = await renderGif(page, declaredDuration(file.content));
      return new Response(new Uint8Array(gif), { headers: { "Content-Type": "image/gif", "Content-Disposition": attachment(file.path, "gif") } });
    }

    const page = await openDesign(browser, file.content, { width: 1920, height: 1080 });
    const buf = await buildPptx(page, file.path.replace(/\.html$/i, ""), sp.get("mode") === "image" ? "image" : "editable");
    if (!buf) return Response.json({ error: "No slides found. PowerPoint export works for slide decks (elements with class “slide”)." }, { status: 400 });
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "Content-Disposition": attachment(file.path, "pptx"),
      },
    });
  } finally {
    await browser.close().catch(() => {});
  }
}
