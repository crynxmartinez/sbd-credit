import type { NextRequest } from "next/server";
import { businessToday } from "@/lib/server/as-of";
import { requireUser } from "@/lib/server/auth/current-user";
import { ApiError, route } from "@/lib/server/http";
import { log } from "@/lib/server/log";
import { customersCsv, ledgerCsvChunks } from "@/lib/server/services/exports";

type Context = { params: Promise<{ kind: string }> };

/** A byte-order mark makes Excel read the file as UTF-8, so names with accents or other alphabets are not garbled. */
const UTF8_BOM = "\uFEFF";

function csvResponse(name: string, body: string | AsyncGenerator<string>): Response {
  const encoder = new TextEncoder();
  const stream =
    typeof body === "string"
      ? `${UTF8_BOM}${body}`
      : // Streamed: the byte-order mark first, then a page of rows at a time, so the whole ledger is never held in memory at once.
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(UTF8_BOM));
          },
          async pull(controller) {
            const next = await body.next();
            if (next.done) controller.close();
            else controller.enqueue(encoder.encode(next.value));
          },
          async cancel() {
            await body.return(undefined);
          },
        });
  return new Response(stream, {
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
    const body = kind === "customers" ? await customersCsv(asOf) : ledgerCsvChunks(asOf);
    // Who downloaded customer data, and when: the file holds every customer's details.
    log("info", "export.downloaded", { kind, userId: user.id });
    return csvResponse(`${kind}.csv`, body);
  }, { request: _request });
}
