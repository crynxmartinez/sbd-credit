import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/server/auth/current-user";
import { assertSameOrigin, ok, readJson, route } from "@/lib/server/http";
import { recordEntry } from "@/lib/server/services/ledger";
import { ledgerEntrySchema } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };

export function POST(request: NextRequest, { params }: Context) {
  return route(async () => {
    assertSameOrigin(request);
    const user = await requireUser("ledger.record");
    const { id } = await params;
    const result = await recordEntry(id, await readJson(request, ledgerEntrySchema), user);
    return ok(result, 201);
  });
}
