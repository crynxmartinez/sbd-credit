import type { NextRequest } from "next/server";
import { BUSINESS_TIME_ZONE, businessToday } from "@/lib/server/as-of";
import { requireUser } from "@/lib/server/auth/current-user";
import { assertSameOrigin, ok, readJson, route } from "@/lib/server/http";
import { createCustomer, listSummaries } from "@/lib/server/services/customers";
import type { CustomerListDto } from "@/lib/types";
import { customerCreateSchema } from "@/lib/validation";

export function GET(request: NextRequest) {
  return route(async () => {
    await requireUser();
    const asOf = businessToday();
    const body: CustomerListDto = { asOf, timeZone: BUSINESS_TIME_ZONE, customers: await listSummaries(asOf) };
    return ok(body);
  }, { request });
}

export function POST(request: NextRequest) {
  return route(async () => {
    assertSameOrigin(request);
    const user = await requireUser("customer.create");
    const input = await readJson(request, customerCreateSchema);
    return ok({ id: await createCustomer(input, user) }, 201);
  }, { request });
}
