import type { SupabaseClient } from "@supabase/supabase-js";
import { BUILDABLE_MODEL_KEYS, MODELS, type ModelKey } from "@/lib/gateway";

export type ModelOption = { key: ModelKey; label: string; note: string };

const isBuildable = (k: string): k is ModelKey => (BUILDABLE_MODEL_KEYS as string[]).includes(k);

/** The build models currently enabled for the picker: the saved set, filtered to keys that still exist, or every buildable model when nothing's been saved. */
export async function getEnabledModelKeys(db: SupabaseClient): Promise<ModelKey[]> {
  const { data } = await db.from("app_settings").select("enabled_models").eq("id", true).maybeSingle();
  const saved = (data?.enabled_models ?? []).filter(isBuildable);
  return saved.length ? saved : BUILDABLE_MODEL_KEYS;
}

/** The picker's option list: enabled models, in registry order, with their label and note. */
export async function getModelOptions(db: SupabaseClient): Promise<ModelOption[]> {
  const enabled = await getEnabledModelKeys(db);
  return enabled.map((key) => ({ key, label: MODELS[key].label, note: MODELS[key].note }));
}

/** Save which build models are enabled (main key only; enforced by the route calling this). At least one must remain. */
export async function setEnabledModelKeys(db: SupabaseClient, keys: string[]): Promise<ModelKey[]> {
  const valid = [...new Set(keys.filter(isBuildable))];
  if (!valid.length) throw new Error("Pick at least one model.");
  const { error } = await db.from("app_settings").upsert({ id: true, enabled_models: valid, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
  return valid;
}
