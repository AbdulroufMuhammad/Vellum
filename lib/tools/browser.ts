import type { Browser, Page } from "playwright-core";

// Designs may only load from these hosts, so the headless browser blocks everything else.
const ALLOWED_HOSTS = /^(fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com)$/;

function allowedStorageHost() {
  try {
    return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").hostname;
  } catch {
    return "";
  }
}

// There's no GPU on the server: 3D designs (three.js) render with software WebGL, which newer Chromium only allows with this flag.
const WEBGL_ARGS = ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"];

export async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  if (process.env.CHROMIUM_PATH) return chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: WEBGL_ARGS });
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    const sparticuz = (await import("@sparticuz/chromium")).default;
    return chromium.launch({ executablePath: await sparticuz.executablePath(), args: [...sparticuz.args, ...WEBGL_ARGS], headless: true });
  }
  // Local development: Playwright's own installed browser.
  return chromium.launch({ args: WEBGL_ARGS });
}

type Fetched = { status: number; headers: Record<string, string>; body: Buffer };
const fetchCache = new Map<string, Promise<Fetched>>();

/** CDN files (three.js, fonts) are immutable per URL, so a warm instance serves repeats from memory. */
function fetchCached(url: string): Promise<Fetched> {
  let hit = fetchCache.get(url);
  if (!hit) {
    hit = (async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000), cache: "no-store" });
      const body = Buffer.from(await res.arrayBuffer());
      const headers: Record<string, string> = { "access-control-allow-origin": "*" };
      const type = res.headers.get("content-type");
      if (type) headers["content-type"] = type;
      return { status: res.status, headers, body };
    })();
    fetchCache.set(url, hit);
    hit.then((r) => r.status >= 400 && fetchCache.delete(url), () => fetchCache.delete(url));
    if (fetchCache.size > 200) fetchCache.delete(fetchCache.keys().next().value!);
  }
  return hit;
}

/** A page with the design loaded, fonts settled, and only allowlisted network access (plus this app's own uploads). */
export async function openDesign(browser: Browser, html: string, viewport: { width: number; height: number }, onError?: (msg: string) => void): Promise<Page> {
  const page = await browser.newPage({ viewport });
  if (onError) {
    page.on("pageerror", (e) => onError(e.message.slice(0, 200)));
    // Failed resource loads are reported from the route handler below (only the ones the design is to blame for).
    page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && onError(m.text().slice(0, 200)));
  }
  const storageHost = allowedStorageHost();
  const report = (type: string, url: string, why: string) => {
    if (onError && (type === "script" || type === "stylesheet")) onError(`Couldn't load ${type} ${url.slice(0, 160)} (${why})`);
  };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.protocol === "data:" || url.protocol === "blob:") return route.continue();
    // The whole "artifacts" bucket is this app's own trusted storage (uploads, and generate_image /
    // generate_3d_model outputs under <projectId>/generated/), not third-party content, so it's allowed
    // wherever it sits in the bucket, not just the uploads/ prefix.
    const allowed = ALLOWED_HOSTS.test(url.hostname) || (storageHost && url.hostname === storageHost && url.pathname.includes("/artifacts/"));
    if (!allowed) {
      report(req.resourceType(), req.url(), "host not allowed; use Google Fonts, jsDelivr, unpkg or cdnjs");
      return route.abort();
    }
    // Fetched by the server and handed to the page: the serverless browser's own network stack fails on
    // these (net::ERR_INSUFFICIENT_RESOURCES), which made every CDN library and font look missing.
    try {
      const res = await fetchCached(req.url());
      if (res.status >= 400) report(req.resourceType(), req.url(), `HTTP ${res.status}`);
      return route.fulfill({ status: res.status, headers: res.headers, body: res.body });
    } catch {
      // A network hiccup on the checker's side isn't the design's fault: skip it quietly.
      return route.abort();
    }
  });
  await page.setContent(html, { waitUntil: "load", timeout: 20_000 }).catch(() => {});
  await page.evaluate("document.fonts && document.fonts.ready.then(() => true)").catch(() => {});
  // A very heavy page (thousands of triangles, WASM CSG) can crash the renderer while it settles;
  // that isn't this call's problem to throw on, the caller's own page.isClosed() check reports it.
  await page.waitForTimeout(600).catch(() => {});
  return page;
}
