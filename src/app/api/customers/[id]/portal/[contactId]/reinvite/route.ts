import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/server/auth/current-user";
import { assertSameOrigin, ok, route } from "@/lib/server/http";
import { inviteLink } from "@/lib/server/public-url";
import { reissueInvite } from "@/lib/server/services/portal-access";

type Context = { params: Promise<{ id: string; contactId: string }> };

/** Sends a new link and cancels the old one. The response carries the one-time link, which is never shown again. */
export function POST(request: NextRequest, { params }: Context) {
  return route(async () => {
    assertSameOrigin(request);
    const user = await requireUser("portal.manage");
    const { id, contactId } = await params;
    const issued = await reissueInvite(id, contactId, user);
    return ok({ contact: issued.contact, link: inviteLink(issued.token), expiresAt: issued.expiresAt });
  }, { request });
}
