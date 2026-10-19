import type { NextRequest } from "next/server";
import { BUSINESS_TIME_ZONE, businessToday } from "@/lib/server/as-of";
import { requireUser } from "@/lib/server/auth/current-user";
import { assertSameOrigin, ok, readJson, route } from "@/lib/server/http";
import { customerListCache } from "@/lib/server/list-cache";
import { createCustomer, listSummaries } from "@/lib/server/services/customers";
import type { CustomerListDto } from "@/lib/types";
import { customerCreateSchema } from "@/lib/validation";

/**
 * The customer list. Computed once per change (see list-cache.ts), not once per request, and sent with an ETag: a browser that
 * already has the current list is answered with "304 not modified" and no body. `private, no-cache` means "keep a copy, but ask
 * before using it" (the default `no-store` of the other routes would forbid the copy, and so the 304).
 */
export function GET(request: NextRequest) {
  return route(async () => {
    await requireUser();
    const asOf = businessToday();
    const entry = await customerListCache.get(asOf, async () => {
      const data: CustomerListDto = { asOf, timeZone: BUSINESS_TIME_ZONE, customers: await listSummaries(asOf) };
      return JSON.stringify({ success: true, data });
    });
    const headers = { "Cache-Control": "private, no-cache", ETag: entry.etag, "Content-Type": "application/json" };
    if (request.headers.get("if-none-match") === entry.etag) return new Response(null, { status: 304, headers: { "Cache-Control": headers["Cache-Control"], ETag: entry.etag } });
    return new Response(entry.body, { headers });
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
