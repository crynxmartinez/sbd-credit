import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/server/auth/current-user";
import { assertSameOrigin, ok, readJson, route } from "@/lib/server/http";
import { decide } from "@/lib/server/services/customers";
import { decisionSchema } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };

export function POST(request: NextRequest, { params }: Context) {
  return route(async () => {
    assertSameOrigin(request);
    // Which roles may take which decision is checked in the service, once the action is known.
    const user = await requireUser();
    const { id } = await params;
    await decide(id, await readJson(request, decisionSchema), user);
    return ok({ decided: true });
  });
}
