import { proxyOperationsRequest, readJsonBody } from "@/lib/operationsProxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return proxyOperationsRequest(request, "/api/operations/teams");
}

export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  return proxyOperationsRequest(request, "/api/operations/teams", {
    method: "POST",
    payload: body.payload,
  });
}
