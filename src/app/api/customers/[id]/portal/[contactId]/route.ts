import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/server/auth/current-user";
import { assertSameOrigin, ok, readJson, route } from "@/lib/server/http";
import { setContactActive } from "@/lib/server/services/portal-access";

type Context = { params: Promise<{ id: string; contactId: string }> };

const activeSchema = z.object({ active: z.boolean() });

/** Turns one contact's access on or off. */
export function PATCH(request: NextRequest, { params }: Context) {
  return route(async () => {
    assertSameOrigin(request);
    const user = await requireUser("portal.manage");
    const { id, contactId } = await params;
    const { active } = await readJson(request, activeSchema);
    return ok(await setContactActive(id, contactId, active, user));
  }, { request });
}
