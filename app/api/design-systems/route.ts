import { createAdminClient } from "@/lib/supabase/admin";
import { fromRow } from "@/lib/designSystems";
import { listDesignSystems } from "@/lib/designSystemsServer";

export async function GET() {
  // Seeded (owner_id null) systems first, each group oldest-first so newly created ones land at the end.
  try {
    return Response.json({ systems: await listDesignSystems(createAdminClient()) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

const HEX = /^#[0-9a-f]{6}$/i;

export async function POST(req: Request) {
  const admin = createAdminClient();
  const body = await req.json();
  const name = String(body.name ?? "").trim() || "Untitled system";
  const colors = (Array.isArray(body.colors) ? body.colors : [])
    .filter((c: any) => HEX.test(c?.hex))
    .slice(0, 12)
    .map((c: any) => ({ name: String(c.name ?? "Color").slice(0, 40), hex: c.hex.toLowerCase() }));
  const fonts = (Array.isArray(body.fonts) ? body.fonts : [])
    .filter((f: any) => f?.stack)
    .slice(0, 4)
    .map((f: any) => ({ role: String(f.role ?? "Body").slice(0, 40), stack: String(f.stack).slice(0, 120) }));

  // There are no accounts, so every design system is shared — created as a
  // global (owner_id null) row, same as the seeded starters.
  const { data, error } = await admin
    .from("design_systems")
    .insert({
      owner_id: null,
      name,
      tokens: {
        colors: colors.length ? colors : [
          { name: "Paper", hex: "#ffffff" },
          { name: "Ink", hex: "#1a1a1a" },
          { name: "Accent", hex: "#c8f542" },
        ],
        fonts: fonts.length ? fonts : [{ role: "Body", stack: "Geist, sans-serif" }],
      },
    })
    .select("*")
    .single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ system: fromRow(data) });
}
