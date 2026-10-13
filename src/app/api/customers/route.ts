import type { NextRequest } from "next/server";
import { businessToday } from "@/lib/server/as-of";
import { requireUser } from "@/lib/server/auth/current-user";
import { assertSameOrigin, ok, readJson, route } from "@/lib/server/http";
import { createCustomer, listSummaries } from "@/lib/server/services/customers";
import type { CustomerListDto } from "@/lib/types";
import { customerCreateSchema } from "@/lib/validation";

export function GET() {
  return route(async () => {
    await requireUser();
    const asOf = businessToday();
    const body: CustomerListDto = { asOf, customers: await listSummaries(asOf) };
    return ok(body);
  });
}

export function POST(request: NextRequest) {
  return route(async () => {
    assertSameOrigin(request);
    const user = await requireUser("customer.create");
    const input = await readJson(request, customerCreateSchema);
    return ok({ id: await createCustomer(input, user) }, 201);
  });
}
