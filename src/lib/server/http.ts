import "server-only";
import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import type { ApiFailure, ApiSuccess } from "@/lib/types";
import { classifyDbError } from "./db-errors";
import { log, newErrorId } from "./log";
import { publicBaseUrl } from "./public-url";

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
    if (error instanceof ApiError) {
      // Refusals an operator needs to be able to see: a blocked origin (a proxy misconfiguration), a rate limit, a busy system.
      if (error.status === 403 || error.status === 429 || error.status === 503) log("warn", "api.refused", { status: error.status, code: error.code });
      return failure(error.status, error.code, error.message, error.fields);
    }
    if (error instanceof ZodError) return failure(400, "invalid_input", "Some fields need attention.", fieldsFrom(error));
    // Detail stays in the server log; the browser only gets a reference that finds it there.
    const reference = newErrorId();
    // A read that could not reach the database is not a bug in the app: say so, and keep the reference for the log.
    if (classifyDbError(error) !== "other") {
      log("warn", "api.database_unreachable", { reference, error });
      return failure(503, "unavailable", `The system can't reach its database just now. Please try again in a moment. (Reference ${reference})`);
    }
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
 *
 * In production the Origin is compared with the CONFIGURED public address (PUBLIC_BASE_URL), not with the Host header,
 * which a caller can influence. Without a configured address (local development) the Host header is used.
 */
export function assertSameOrigin(request: Request, env: Readonly<Record<string, string | undefined>> = process.env): void {
  const origin = request.headers.get("origin");
  const expectedHost =
    env.NODE_ENV === "production" && env.PUBLIC_BASE_URL
      ? new URL(publicBaseUrl(env)).host
      : (request.headers.get("x-forwarded-host") ?? request.headers.get("host"));
  if (origin && expectedHost) {
    try {
      if (new URL(origin).host === expectedHost) return;
    } catch {
      // fall through to the refusal below
    }
    throw new ApiError(403, "bad_origin", "Request blocked.");
  }
  if (request.headers.get("sec-fetch-site") === "same-origin") return;
  throw new ApiError(403, "bad_origin", "Request blocked.");
}
