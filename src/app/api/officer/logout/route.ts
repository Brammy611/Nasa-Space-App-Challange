import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const supabase = await createClient();
    await supabase.auth.signOut();
  } catch {
    // Logout remains idempotent if Auth is temporarily unavailable.
  }
  return Response.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
}
