import "server-only";

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

export type OfficerRole = "viewer" | "field_officer" | "coordinator" | "admin";

export type OfficerState =
  | { kind: "unauthenticated" }
  | { kind: "forbidden" }
  | {
      kind: "active";
      supabase: Awaited<ReturnType<typeof createClient>>;
      userId: string;
      displayName: string;
      role: OfficerRole;
    };

const ACTIVE_ROLES = new Set<OfficerRole>(["viewer", "field_officer", "coordinator", "admin"]);

export const getOfficerState = cache(async (): Promise<OfficerState> => {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getUser();
    const user = data.user;
    if (error || !user || user.is_anonymous || !user.email_confirmed_at) {
      return { kind: "unauthenticated" };
    }

    const profileResult = await supabase
      .from("profiles")
      .select("display_name, role, status")
      .eq("id", user.id)
      .single();
    const profile = profileResult.data as { display_name?: unknown; role?: unknown; status?: unknown } | null;
    if (
      profileResult.error ||
      !profile ||
      profile.status !== "active" ||
      typeof profile.role !== "string" ||
      !ACTIVE_ROLES.has(profile.role as OfficerRole) ||
      typeof profile.display_name !== "string" ||
      profile.display_name.trim().length < 2
    ) {
      return { kind: "forbidden" };
    }

    return {
      kind: "active",
      supabase,
      userId: user.id,
      displayName: profile.display_name,
      role: profile.role as OfficerRole,
    };
  } catch {
    return { kind: "unauthenticated" };
  }
});

export async function requireOfficerState(): Promise<
  | Extract<OfficerState, { kind: "active" }>
  | { response: Response }
> {
  const state = await getOfficerState();
  if (state.kind === "active") return state;
  if (state.kind === "forbidden") {
    return {
      response: Response.json(
        { error: "Officer account is not active.", code: "OFFICER_ACCESS_DENIED" },
        { status: 403, headers: { "Cache-Control": "private, no-store" } }
      ),
    };
  }
  return {
    response: Response.json(
      { error: "Officer sign-in required.", code: "OFFICER_AUTH_REQUIRED" },
      { status: 401, headers: { "Cache-Control": "private, no-store" } }
    ),
  };
}
