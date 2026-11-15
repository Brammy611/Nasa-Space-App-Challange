import "server-only";

import { getOfficerState } from "@/lib/officerSession";

/**
 * Supabase Auth owns browser sessions and named officer identities. The old
 * shared key remains only as a server-to-server credential for the Python
 * community-report service; it is never accepted from a browser login.
 */
export async function isOfficerRequest(): Promise<boolean> {
  return (await getOfficerState()).kind === "active";
}

export async function backendHeaders(
  request: Request,
  extra: Record<string, string> = {}
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...extra };
  const state = await getOfficerState();
  const backendKey = process.env.OFFICER_ACCESS_KEY?.trim();
  if (state.kind === "active" && backendKey) {
    headers["X-Officer-Key"] = backendKey;
    headers["X-Officer-Name"] = state.displayName;
  }
  const forwarded = request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip");
  if (forwarded) headers["X-Forwarded-For"] = forwarded;
  return headers;
}
