import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { updateSupabaseSession } from "@/lib/supabase/proxy";

/**
 * Officer-only pages. Citizen reports hold reporters' exact locations, photos
 * and review notes; incidents hold operational assignments and audit notes.
 * The data is gated again in route handlers and on the Python backend, so this
 * redirect is a convenience, not the only lock.
 *
 * The satellite-data pages (/operator, /calendar, /map, ...) stay public on
 * purpose: they only show NASA data that is public anyway.
 */
export async function proxy(request: NextRequest) {
  const { response, userId } = await updateSupabaseSession(request);
  if (userId) return response;
  const loginUrl = new URL("/officer-login", request.url);
  loginUrl.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/citizen-reports/:path*", "/incidents/:path*"],
};
