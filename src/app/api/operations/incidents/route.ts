import { proxyOperationsRequest, readJsonBody } from "@/lib/operationsProxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const incoming = new URL(request.url);
  const query = new URLSearchParams();
  for (const key of ["status", "priority"]) {
    const value = incoming.searchParams.get(key);
    if (value) query.set(key, value);
  }
  return proxyOperationsRequest(
    request,
    `/api/operations/incidents${query.size ? `?${query}` : ""}`
  );
}

export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  return proxyOperationsRequest(request, "/api/operations/incidents", {
    method: "POST",
    payload: body.payload,
  });
}
