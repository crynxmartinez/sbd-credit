import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/server/auth/current-user";
import { assertSameOrigin, ok, readJson, route } from "@/lib/server/http";
import { reverseEntry } from "@/lib/server/services/ledger";
import { reversalSchema } from "@/lib/validation";

type Context = { params: Promise<{ id: string; entryId: string }> };

export function POST(request: NextRequest, { params }: Context) {
  return route(async () => {
    assertSameOrigin(request);
    const user = await requireUser("ledger.reverse");
    const { id, entryId } = await params;
    const result = await reverseEntry(id, entryId, await readJson(request, reversalSchema), user);
    return ok(result, 201);
  }, { request });
}
