import type { NextRequest } from "next/server";
import { businessToday } from "@/lib/server/as-of";
import { requireUser } from "@/lib/server/auth/current-user";
import { assertSameOrigin, ok, readJson, route } from "@/lib/server/http";
import { getDetail, updateCustomer } from "@/lib/server/services/customers";
import { customerUpdateSchema } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };

export function GET(_request: NextRequest, { params }: Context) {
  return route(async () => {
    await requireUser();
    const { id } = await params;
    return ok(await getDetail(id, businessToday()));
  }, { request: _request });
}

export function PATCH(request: NextRequest, { params }: Context) {
  return route(async () => {
    assertSameOrigin(request);
    const user = await requireUser("customer.edit");
    const { id } = await params;
    const input = await readJson(request, customerUpdateSchema);
    await updateCustomer(id, input, user);
    return ok({ updated: true });
  }, { request });
}
