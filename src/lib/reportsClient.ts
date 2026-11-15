import type { ReportsListResponse } from "@/types";

/**
 * Citizen reports for the public operator pages. The Next.js route attaches
 * the server-only Python bridge credential, so browsers never receive it.
 */
export async function fetchReportsForViewer(
  signal?: AbortSignal
): Promise<(ReportsListResponse & { scope: "public" }) | null> {
  const full = await fetch("/api/reports", { cache: "no-store", signal });
  if (!full.ok) return null;
  return { ...((await full.json()) as ReportsListResponse), scope: "public" };
}
