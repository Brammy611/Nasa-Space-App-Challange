import { createOperationTeam, listOperationTeams } from "@/lib/operationsData";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  void request;
  return listOperationTeams();
}

export async function POST(request: Request) {
  return createOperationTeam(request);
}
