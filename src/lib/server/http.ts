import "server-only";
import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import type { ApiFailure, ApiSuccess } from "@/lib/types";
import { log, newErrorId } from "./log";

const MAX_BODY_BYTES = 100_000;
const NO_STORE = { "Cache-Control": "no-store" } as const;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export function ok<T>(data: T, status = 200): NextResponse<ApiSuccess<T>> {
  return NextResponse.json({ success: true as const, data }, { status, headers: NO_STORE });
}

function failure(status: number, code: string, message: string, fields?: Record<string, string>) {
  const body: ApiFailure = { success: false, error: { code, message, ...(fields ? { fields } : {}) } };
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function fieldsFrom(error: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    if (!(key in fields)) fields[key] = issue.message;
  }
  return fields;
}

/** Wraps a handler so every failure leaves as the same JSON shape and nothing internal leaks. */
export async function route(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof ApiError) return failure(error.status, error.code, error.message, error.fields);
    if (error instanceof ZodError) return failure(400, "invalid_input", "Some fields need attention.", fieldsFrom(error));
    // Detail stays in the server log; the browser only gets a reference that finds it there.
    const reference = newErrorId();
    log("error", "api.unhandled_error", { reference, error });
    return failure(500, "server_error", `Something went wrong. Please try again. (Reference ${reference})`);
  }
}

const tooLarge = () => new ApiError(413, "too_large", "That request is too large.");

/** Reads the body but stops as soon as it passes the limit, instead of buffering whatever a client sends. */
async function readLimitedText(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw tooLarge();

  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Reads a JSON body of bounded size and validates it. */
export async function readJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  // The media type must BE application/json. Matching it as a substring would accept text/plain with a parameter.
  const mediaType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new ApiError(415, "unsupported_media_type", "Send the request as JSON.");
  }
  const text = await readLimitedText(request);

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "The request body is not valid JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}

/**
 * CSRF defence for cookie-authenticated writes: the browser must say the request came from this site.
 * SameSite=Lax on the cookie is the first layer; this is the second.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (origin && host) {
    try {
      if (new URL(origin).host === host) return;
    } catch {
      // fall through to the refusal below
    }
    throw new ApiError(403, "bad_origin", "Request blocked.");
  }
  if (request.headers.get("sec-fetch-site") === "same-origin") return;
  throw new ApiError(403, "bad_origin", "Request blocked.");
}
