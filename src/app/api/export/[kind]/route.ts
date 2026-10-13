import type { NextRequest } from "next/server";
import { businessToday } from "@/lib/server/as-of";
import { requireUser } from "@/lib/server/auth/current-user";
import { ApiError, route } from "@/lib/server/http";
import { customersCsv, ledgerCsv } from "@/lib/server/services/exports";

type Context = { params: Promise<{ kind: string }> };

function csvResponse(name: string, body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}

export function GET(_request: NextRequest, { params }: Context) {
  return route(async () => {
    await requireUser("export");
    const { kind } = await params;
    if (kind === "customers") return csvResponse("customers.csv", await customersCsv(businessToday()));
    if (kind === "ledger") return csvResponse("ledger.csv", await ledgerCsv());
    throw new ApiError(404, "not_found", "Unknown export.");
  });
}
