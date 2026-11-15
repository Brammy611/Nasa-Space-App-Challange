import { proxyOperationsRequest, readJsonBody } from "@/lib/operationsProxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: RouteContext<"/api/operations/incidents/[id]">) {
  const { id } = await ctx.params;
  return proxyOperationsRequest(request, `/api/operations/incidents/${encodeURIComponent(id)}`);
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/operations/incidents/[id]">) {
  const { id } = await ctx.params;
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  return proxyOperationsRequest(request, `/api/operations/incidents/${encodeURIComponent(id)}`, {
    method: "PATCH",
    payload: body.payload,
  });
}
