import type { NextRequest } from "next/server";
import { endAllSessions } from "@/lib/server/auth/sign-out";
import { assertSameOrigin, ok, route } from "@/lib/server/http";

export function POST(request: NextRequest) {
  return route(async () => {
    assertSameOrigin(request);
    // Ends the staff session AND the customer session, whichever this browser holds. If a session cannot be revoked this
    // answers 503 and leaves the cookie in place, and the screen tells the person to try again.
    await endAllSessions();
    return ok({ signedOut: true });
  }, { request });
}
