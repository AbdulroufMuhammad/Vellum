/** @type {import('next').NextConfig} */
const chromiumBinary = ["./node_modules/@sparticuz/chromium/bin/**"];

const nextConfig = {
  experimental: {
    // Vercel Sandbox (run_code) pulls in undici 7, which shouldn't be bundled into the turn route either.
    // Headless Chromium (visual check, PNG/PPTX export): keep it out of the bundle and ship its binary with the routes that launch it.
    serverComponentsExternalPackages: ["playwright-core", "@sparticuz/chromium", "pptxgenjs", "@vercel/sandbox"],
    outputFileTracingIncludes: {
      "/api/projects/[id]/turn": chromiumBinary,
      "/api/projects/[id]/export": chromiumBinary,
    },
  },
};

export default nextConfig;
