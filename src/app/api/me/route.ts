import { requireUser } from "@/lib/server/auth/current-user";
import { ok, route } from "@/lib/server/http";

export function GET() {
  return route(async () => ok(await requireUser()));
}
