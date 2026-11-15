import "server-only";

import { backendHeaders, isOfficerRequest } from "@/lib/officerAuth";

const PYTHON_API = process.env.PYTHON_PROCESSING_API_URL ?? "http://127.0.0.1:8000";

export async function proxyOperationsRequest(
  request: Request,
  upstreamPath: string,
  options: { method?: "GET" | "POST" | "PATCH"; payload?: unknown } = {}
): Promise<Response> {
  if (!isOfficerRequest(request)) {
    return Response.json(
      { error: "Officer sign-in required.", code: "OFFICER_AUTH_REQUIRED" },
      { status: 401 }
    );
  }

  const method = options.method ?? "GET";
  try {
    const upstream = await fetch(`${PYTHON_API}${upstreamPath}`, {
      method,
      headers: backendHeaders(
        request,
        options.payload === undefined ? {} : { "Content-Type": "application/json" }
      ),
      body: options.payload === undefined ? undefined : JSON.stringify(options.payload),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await upstream.json().catch(() => ({ detail: "Invalid response from operations service." }))) as unknown;
    return Response.json(body, {
      status: upstream.status,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("Operations service request failed", error);
    return Response.json(
      { error: "Operations service is temporarily unavailable.", code: "OPERATIONS_FETCH_ERROR" },
      { status: 502 }
    );
  }
}

export async function readJsonBody(request: Request): Promise<{ ok: true; payload: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, payload: await request.json() };
  } catch {
    return {
      ok: false,
      response: Response.json({ error: "Request body must be valid JSON.", code: "INVALID_BODY" }, { status: 400 }),
    };
  }
}
