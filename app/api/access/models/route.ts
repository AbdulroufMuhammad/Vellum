import { createAdminClient } from "@/lib/supabase/admin";
import { requireMain } from "@/lib/accessServer";
import { BUILDABLE_MODEL_KEYS, MODELS } from "@/lib/gateway";
import { getEnabledModelKeys, setEnabledModelKeys } from "@/lib/modelSettings";

export const dynamic = "force-dynamic";

/** Every buildable model plus which ones are currently enabled. Any signed-in session can read this (it feeds the picker). */
export async function GET() {
  const enabled = await getEnabledModelKeys(createAdminClient());
  return Response.json({
    all: BUILDABLE_MODEL_KEYS.map((key) => ({ key, label: MODELS[key].label, note: MODELS[key].note })),
    enabled,
  });
}

/** Save which models are enabled (main key only). Body: { keys: string[] }. */
export async function PATCH(req: Request) {
  if (!(await requireMain())) return Response.json({ error: "Only the main access key can change model settings." }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  if (!Array.isArray(body?.keys)) return Response.json({ error: "keys must be an array." }, { status: 400 });
  try {
    const enabled = await setEnabledModelKeys(createAdminClient(), body.keys);
    return Response.json({ enabled });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Couldn't save model settings." }, { status: 400 });
  }
}
