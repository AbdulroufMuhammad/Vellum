import type { SupabaseClient } from "@supabase/supabase-js";
import { extractText, getDocumentProxy } from "unpdf";

/**
 * Web research, backed by Seekly (search.amatip.com): a self-hosted, Tavily-shaped search API
 * (structured results, an /extract endpoint, ranking scores) built specifically to replace a paid
 * Tavily subscription. Swapping providers only ever touches this file; everything else in the app
 * (lib/agent.ts, lib/finalize.ts) imports Source/SourceRegistry/WEB_TOOL_SCHEMAS by name.
 */
const SEEKLY_URL = (process.env.SEEKLY_API_URL || "https://search.amatip.com").replace(/\/+$/, "");

export type Source = { url: string; title?: string; text?: string };

async function seekly<T = any>(path: string, params: Record<string, string | number | boolean | undefined>): Promise<T> {
  const key = process.env.SEEKLY_API_KEY;
  if (!key) throw new Error("web search isn't configured: SEEKLY_API_KEY is missing");
  const url = new URL(SEEKLY_URL + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { "X-API-Key": key } });
  if (!res.ok) throw new Error(`seekly ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/** Seekly's /v1/extract only reads HTML; a prospectus, filing or press release is often a PDF, so fetch and extract that ourselves. */
async function extractPdfText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`pdf fetch ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const doc = await getDocumentProxy(buf);
  const { text } = await extractText(doc, { mergePages: true });
  return text;
}

/**
 * The project's web sources, keyed by short IDs (S1, S2…). The agent only
 * ever sees these IDs, titles and text — never URLs — so it can't invent a
 * citation link; lib/finalize.ts turns [S3] back into a numbered reference.
 */
export class SourceRegistry {
  sources = new Map<string, Source>();
  searchesLeft: number;
  /** Searches + fetches allowed in the current turn; keeps the agent from researching instead of designing. */
  turnLimit = 6;
  turnUsed = 0;

  private constructor(private db: SupabaseClient, private projectId: string, searchesLeft: number) {
    this.searchesLeft = searchesLeft;
  }

  static async load(db: SupabaseClient, projectId: string, budget: any) {
    const reg = new SourceRegistry(db, projectId, Number(budget?.searchesLeft ?? 40));
    const { data } = await db.from("sources").select("short_id, url, title, text").eq("project_id", projectId);
    for (const s of data ?? []) reg.sources.set(s.short_id, { url: s.url, title: s.title ?? undefined, text: s.text ?? undefined });
    return reg;
  }

  private spend() {
    if (this.searchesLeft <= 0) throw new Error("the search budget for this project is used up; continue with what you have");
    if (this.turnUsed >= this.turnLimit)
      throw new Error(`that's this turn's research allowance (${this.turnLimit}); write with what you have now`);
    this.searchesLeft -= 1;
    this.turnUsed += 1;
  }

  private async register(url: string, title?: string, text?: string) {
    for (const [id, s] of this.sources) if (s.url === url) return id;
    let n = this.sources.size + 1;
    while (this.sources.has(`S${n}`)) n++;
    const id = `S${n}`;
    this.sources.set(id, { url, title, text });
    await this.persist(id);
    return id;
  }

  private async persist(id: string) {
    const s = this.sources.get(id)!;
    await this.db.from("sources").upsert(
      { project_id: this.projectId, short_id: id, url: s.url, title: s.title, text: s.text, fetched_at: new Date().toISOString() },
      { onConflict: "project_id,short_id" }
    );
  }

  async search({ query, max_results = 6 }: { query: string; max_results?: number }) {
    this.spend();
    const r = await seekly("/v1/search", { q: query, max_results: Math.min(10, Number(max_results) || 6), search_depth: "advanced" });
    const out = [];
    for (const x of r.results ?? []) {
      const id = await this.register(x.url, x.title, x.content);
      out.push({ id, title: x.title, snippet: String(x.content ?? "").slice(0, 400) });
    }
    return out;
  }

  async fetch({ source_id }: { source_id: string }) {
    const src = this.sources.get(source_id);
    if (!src) throw new Error("unknown source_id; use an ID returned by web_search");
    this.spend();
    try {
      // Document.content is the full extracted text (Seekly's /extract shape; unlike Tavily there's
      // no separate raw_content wrapper).
      const r = await seekly("/v1/extract", { url: src.url });
      src.text = r.content ?? src.text;
      await this.persist(source_id);
    } catch (err: any) {
      if (/application\/pdf/i.test(String(err?.message)) || /\.pdf(?:[?#]|$)/i.test(src.url)) {
        try {
          src.text = await extractPdfText(src.url);
          await this.persist(source_id);
        } catch {
          // keep the search snippet we already have
        }
      }
      // else: keep the search snippet we already have
    }
    return { id: source_id, title: src.title, text: (src.text ?? "").slice(0, 20000) };
  }
}

export const WEB_TOOL_SCHEMAS = [
  {
    type: "function" as const,
    function: {
      name: "web_search",
      description: "Search the web. Returns source IDs (S1, S2…), titles and snippets. Cite facts as [S1].",
      parameters: { type: "object", properties: { query: { type: "string" }, max_results: { type: "number" } }, required: ["query"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "web_fetch",
      description: "Read the full text of a source previously returned by web_search. Works on PDFs too (a prospectus, filing or press release), not just HTML pages.",
      parameters: { type: "object", properties: { source_id: { type: "string" } }, required: ["source_id"] },
    },
  },
];
