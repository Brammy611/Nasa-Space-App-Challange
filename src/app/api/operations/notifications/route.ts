import { listOperationNotifications } from "@/lib/operationsData";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  void request;
  return listOperationNotifications();
}
