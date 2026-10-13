import type { NextRequest } from "next/server";
import { endSession } from "@/lib/server/auth/current-user";
import { assertSameOrigin, ok, route } from "@/lib/server/http";

export function POST(request: NextRequest) {
  return route(async () => {
    assertSameOrigin(request);
    const { revoked } = await endSession();
    return ok({ signedOut: true, revoked });
  });
}
