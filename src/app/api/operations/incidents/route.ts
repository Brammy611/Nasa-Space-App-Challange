import { createOperationIncident, listOperationIncidents } from "@/lib/operationsData";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return listOperationIncidents(request);
}

export async function POST(request: Request) {
  return createOperationIncident(request);
}
