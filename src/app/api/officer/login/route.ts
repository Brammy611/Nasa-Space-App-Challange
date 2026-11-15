import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let email: unknown;
  let password: unknown;
  try {
    const body = (await request.json()) as { email?: unknown; password?: unknown };
    email = body.email;
    password = body.password;
  } catch {
    return Response.json({ error: "Invalid JSON body.", code: "INVALID_BODY" }, { status: 400 });
  }

  if (typeof email !== "string" || typeof password !== "string" || !email.trim() || !password) {
    return Response.json({ error: "Email and password are required.", code: "INVALID_CREDENTIALS" }, { status: 422 });
  }

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error || !data.user) {
      return Response.json({ error: "Email or password is incorrect.", code: "WRONG_CREDENTIALS" }, { status: 401 });
    }

    const profileResult = await supabase
      .from("profiles")
      .select("role, status")
      .eq("id", data.user.id)
      .single();
    const profile = profileResult.data as { role?: unknown; status?: unknown } | null;
    if (profileResult.error || profile?.status !== "active" || profile.role === "pending") {
      await supabase.auth.signOut();
      return Response.json({ error: "Officer account is not active.", code: "OFFICER_ACCESS_DENIED" }, { status: 403 });
    }

    return Response.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return Response.json({ error: "Supabase Auth is not configured.", code: "OFFICER_AUTH_DISABLED" }, { status: 503 });
  }
}
