import "server-only";

export function pythonHeaders(
  request: Request,
  extra: Record<string, string> = {}
): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const forwarded = request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip");
  if (forwarded) headers["X-Forwarded-For"] = forwarded;
  return headers;
}
