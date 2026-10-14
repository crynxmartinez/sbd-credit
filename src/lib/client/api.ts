import type { ApiResponse } from "@/lib/types";

const REQUEST_TIMEOUT_MS = 15_000;

/** Fired when the server says the session has ended. The app shows a banner; the page is not left, so typed work survives. */
export const SESSION_EXPIRED_EVENT = "credit:session-expired";

const SESSION_ENDED = "Your session has ended. Sign in again in a new tab, then come back: what you typed is still here.";

/** The sign-in pages themselves answer 401 for a wrong password, which is not an expired session. */
function onSignInScreen(path: string): boolean {
  return path.startsWith("/api/auth/login") || path.startsWith("/api/portal/accept") || window.location.pathname === "/login" || window.location.pathname === "/accept-invite";
}

/**
 * Thrown for any failed API call.
 *
 * `uncertain` is true when a WRITE failed without a clear answer (the connection dropped, it timed out, the reply was
 * garbled, the server crashed): it may well have been saved. Writes carry a request key, so trying again is safe and
 * will not be recorded twice. The message says so, instead of leaving a person to guess and re-enter a payment.
 */
export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
    readonly uncertain = false,
  ) {
    super(message);
  }
}

const UNCERTAIN_NOTE = " It may or may not have been saved. Trying again is safe: nothing will be recorded twice.";

export async function apiFetch<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const isWrite = method !== "GET";
  const hasBody = init.body !== undefined;

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: hasBody ? { "Content-Type": "application/json" } : undefined,
      body: hasBody ? JSON.stringify(init.body) : undefined,
      credentials: "same-origin",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    const base = timedOut ? "The server took too long to answer." : "Can't reach the server.";
    throw new ApiClientError(0, timedOut ? "timeout" : "network", isWrite ? base + UNCERTAIN_NOTE : base, undefined, isWrite);
  }

  let payload: ApiResponse<T>;
  try {
    payload = (await response.json()) as ApiResponse<T>;
  } catch {
    // An HTML error page from a proxy, an empty reply: the request may have reached the app before this happened.
    const base = "The server sent an unexpected response.";
    throw new ApiClientError(response.status, "bad_response", isWrite ? base + UNCERTAIN_NOTE : base, undefined, isWrite);
  }

  if (!payload.success) {
    if (response.status === 401 && typeof window !== "undefined" && !onSignInScreen(path)) {
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
      throw new ApiClientError(401, "session_ended", SESSION_ENDED);
    }
    // A 500 is a crash somewhere in the middle of a write. 503 "busy" is the one server error that guarantees nothing was saved.
    const uncertain = isWrite && response.status >= 500 && payload.error.code !== "busy";
    const message = uncertain ? payload.error.message + UNCERTAIN_NOTE : payload.error.message;
    throw new ApiClientError(response.status, payload.error.code, message, payload.error.fields, uncertain);
  }
  return payload.data;
}
