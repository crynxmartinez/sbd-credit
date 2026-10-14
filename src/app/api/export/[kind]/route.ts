import type { NextRequest } from "next/server";
import { businessToday } from "@/lib/server/as-of";
import { requireUser } from "@/lib/server/auth/current-user";
import { ApiError, route } from "@/lib/server/http";
import { log } from "@/lib/server/log";
import { customersCsv, ledgerCsv } from "@/lib/server/services/exports";

type Context = { params: Promise<{ kind: string }> };

/** A byte-order mark makes Excel read the file as UTF-8, so names with accents or other alphabets are not garbled. */
const UTF8_BOM = "\uFEFF";

function csvResponse(name: string, body: string): Response {
  return new Response(`${UTF8_BOM}${body}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}

export function GET(_request: NextRequest, { params }: Context) {
  return route(async () => {
    const user = await requireUser("export");
    const { kind } = await params;
    const asOf = businessToday();
    if (kind !== "customers" && kind !== "ledger") throw new ApiError(404, "not_found", "Unknown export.");
    const body = kind === "customers" ? await customersCsv(asOf) : await ledgerCsv(asOf);
    // Who downloaded customer data, and when: the file holds every customer's details.
    log("info", "export.downloaded", { kind, userId: user.id });
    return csvResponse(`${kind}.csv`, body);
  });
}
