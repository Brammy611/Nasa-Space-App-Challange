import { mutateOperationIncident, readOperationIncident } from "@/lib/operationsData";

export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: RouteContext<"/api/operations/incidents/[id]">) {
  void request;
  const { id } = await ctx.params;
  return readOperationIncident(id);
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/operations/incidents/[id]">) {
  const { id } = await ctx.params;
  return mutateOperationIncident(request, id);
}
