import type { NextRequest } from "next/server";
import { endAllSessions } from "@/lib/server/auth/sign-out";
import { assertSameOrigin, ok, route } from "@/lib/server/http";

export function POST(request: NextRequest) {
  return route(async () => {
    assertSameOrigin(request);
    // Ends the staff session AND the customer session, whichever this browser holds, so nothing is left behind.
    const { revoked } = await endAllSessions();
    return ok({ signedOut: true, revoked });
  });
}
