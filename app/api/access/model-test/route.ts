import { requireMain } from "@/lib/accessServer";
import { chat, MODELS, type ModelKey } from "@/lib/gateway";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Sends one tiny prompt to a model and returns its raw reply (main key only), to tell a model that answers from
 * one that errors or streams nonsense, without ever exposing the key. ?model=kimi, plus optional
 * ?temperature=1&top_p=0.95 to try the sampling settings a model needs before changing the registry.
 */
export async function GET(req: Request) {
  if (!(await requireMain())) return Response.json({ error: "Main key only." }, { status: 403 });
  const params = new URL(req.url).searchParams;
  const model = params.get("model") as ModelKey | null;
  if (!model || !(model in MODELS)) return Response.json({ error: "unknown model", models: Object.keys(MODELS) }, { status: 400 });
  const extra: Record<string, number> = {};
  for (const k of ["temperature", "top_p"]) {
    const v = params.get(k);
    if (v != null && Number.isFinite(Number(v))) extra[k] = Number(v);
  }
  const started = Date.now();
  try {
    const r = await chat(model, {
      messages: [{ role: "user", content: params.get("prompt") ?? "Reply with exactly one word: ready" }],
      deadline: Date.now() + 100_000,
      noFallback: true,
      maxTokens: 400,
      extra,
    });
    return Response.json({
      model,
      id: MODELS[model].id,
      sent: { temperature: MODELS[model].temperature, top_p: MODELS[model].top_p, ...extra },
      ms: Date.now() - started,
      finish: r.finish,
      content: r.content.slice(0, 600),
      reasoning: r.reasoning.slice(0, 600),
      usage: r.usage,
    });
  } catch (e) {
    return Response.json({ model, id: MODELS[model].id, ms: Date.now() - started, error: e instanceof Error ? e.message.slice(0, 600) : String(e) });
  }
}
