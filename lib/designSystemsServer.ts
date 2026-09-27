import type { SupabaseClient } from "@supabase/supabase-js";
import { fromRow, type DesignSystem } from "@/lib/designSystems";

/** The starter systems (supabase/migrations/0002_design_v2.sql), kept here so they can be restored if the table is wiped. */
const BUILTINS = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Nocturne",
    colors: [["Background", "#161826"], ["Surface", "#232532"], ["Text", "#e9e9ed"], ["Accent", "#9184d9"], ["Accent 2", "#a7a1db"]],
    fonts: [["Heading", "'Inter', sans-serif"], ["Body", "'Inter', sans-serif"]],
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    name: "Organic",
    colors: [["Background", "#f5ead8"], ["Surface", "#ebddc5"], ["Text", "#201e1d"], ["Accent", "#c67139"], ["Accent 2", "#7a8a5e"]],
    fonts: [["Heading", "'Caprasimo', serif"], ["Body", "'Figtree', sans-serif"]],
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    name: "Modernist",
    colors: [["Background", "#f3f2f2"], ["Surface", "#eae9e9"], ["Text", "#201e1d"], ["Accent", "#ec3013"], ["Accent 2", "#e15b47"]],
    fonts: [["Heading", "'Archivo', sans-serif"], ["Body", "'Archivo', sans-serif"]],
  },
  {
    id: "00000000-0000-4000-8000-000000000004",
    name: "Classical",
    colors: [["Background", "#f3f2f2"], ["Surface", "#eae9e9"], ["Text", "#201f1d"], ["Accent", "#b68235"], ["Accent 2", "#ac803e"]],
    fonts: [["Heading", "'Cormorant Garamond', serif"], ["Body", "'Lora', serif"]],
  },
].map((b) => ({
  id: b.id,
  owner_id: null,
  name: b.name,
  tokens: { colors: b.colors.map(([name, hex]) => ({ name, hex })), fonts: b.fonts.map(([role, stack]) => ({ role, stack })) },
}));

const select = (db: SupabaseClient) =>
  db.from("design_systems").select("*").order("owner_id", { ascending: true, nullsFirst: true }).order("created_at", { ascending: true });

/** Every design system, starters first; a starter that's gone missing (e.g. the table was cleared) is restored first. */
export async function listDesignSystems(db: SupabaseClient): Promise<DesignSystem[]> {
  let { data, error } = await select(db);
  if (error) throw new Error(error.message);
  const present = new Set((data ?? []).map((r) => r.id));
  const missing = BUILTINS.filter((b) => !present.has(b.id));
  if (missing.length) {
    await db.from("design_systems").upsert(missing, { onConflict: "id", ignoreDuplicates: true });
    ({ data, error } = await select(db));
    if (error) throw new Error(error.message);
  }
  return (data ?? []).map(fromRow);
}
