import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/server/auth/current-user";
import { assertSameOrigin, ok, readJson, route } from "@/lib/server/http";
import { inviteContact, listContacts } from "@/lib/server/services/portal-access";
import { inviteLink } from "@/lib/server/public-url";

type Context = { params: Promise<{ id: string }> };

const inviteSchema = z.object({ name: z.string().max(200), email: z.string().max(400) });

export function GET(_request: NextRequest, { params }: Context) {
  return route(async () => {
    const user = await requireUser("portal.manage");
    const { id } = await params;
    return ok(await listContacts(id, user));
  }, { request: _request });
}

/** Offers portal access. The response carries the one-time link, which is never shown again. */
export function POST(request: NextRequest, { params }: Context) {
  return route(async () => {
    assertSameOrigin(request);
    const user = await requireUser("portal.manage");
    const { id } = await params;
    const issued = await inviteContact(id, await readJson(request, inviteSchema), user);
    return ok({ contact: issued.contact, link: inviteLink(issued.token), expiresAt: issued.expiresAt }, 201);
  }, { request });
}
