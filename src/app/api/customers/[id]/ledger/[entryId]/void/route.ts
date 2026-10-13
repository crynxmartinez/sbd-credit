import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/server/auth/current-user";
import { assertSameOrigin, ok, readJson, route } from "@/lib/server/http";
import { voidEntry } from "@/lib/server/services/ledger";
import { voidSchema } from "@/lib/validation";

type Context = { params: Promise<{ id: string; entryId: string }> };

export function POST(request: NextRequest, { params }: Context) {
  return route(async () => {
    assertSameOrigin(request);
    const user = await requireUser("ledger.void");
    const { id, entryId } = await params;
    const { reason } = await readJson(request, voidSchema);
    await voidEntry(id, entryId, reason, user);
    return ok({ voided: true });
  });
}
