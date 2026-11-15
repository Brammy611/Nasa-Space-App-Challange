import { proxyOperationsRequest } from "@/lib/operationsProxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return proxyOperationsRequest(request, "/api/operations/notifications");
}
