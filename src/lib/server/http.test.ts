import { describe, expect, test, vi } from "vitest";
import { z, ZodError } from "zod";
import { ApiError, assertSameOrigin, readJson, route } from "./http";

interface FailureBody {
  success: boolean;
  error: { code: string; message: string; fields?: Record<string, string> };
}
const json = async (response: Response) => (await response.json()) as FailureBody;

function request(init: { headers?: Record<string, string>; body?: string | null } = {}): Request {
  return new Request("http://app.example/api/x", { method: "POST", headers: init.headers, body: init.body ?? null });
}

describe("route()", () => {
  test("passes a normal response straight through", async () => {
    const response = await route(async () => Response.json({ ok: true }));
    expect(await response.json()).toEqual({ ok: true });
  });

  test("turns an ApiError into the standard failure body with its own status", async () => {
    const response = await route(async () => {
      throw new ApiError(409, "stale", "Someone else changed this.", { name: "taken" });
    });
    expect(response.status).toBe(409);
    expect(await json(response)).toEqual({ success: false, error: { code: "stale", message: "Someone else changed this.", fields: { name: "taken" } } });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("turns a validation failure into a 400 listing the fields, one message each", async () => {
    const response = await route(async () => {
      z.object({ name: z.string().min(2), age: z.number() }).parse({ name: "x", age: "old" });
      return Response.json({});
    });
    const body = await json(response);
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("invalid_input");
    expect(Object.keys(body.error.fields ?? {}).sort()).toEqual(["age", "name"]);
  });

  test("an unexpected error becomes a generic 500 with a reference, and leaks nothing", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await route(async () => {
      throw new Error("connect failed for postgres://user:supersecret@db.example.com/postgres");
    });
    const body = await json(response);

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("server_error");
    expect(JSON.stringify(body)).not.toContain("supersecret");
    expect(JSON.stringify(body)).not.toContain("postgres://");
    const reference = /Reference ([0-9a-f]{8})/.exec(body.error.message)?.[1];
    expect(reference).toBeDefined();

    // The full detail went to the log under the SAME reference, with the connection string already scrubbed.
    const logged = String(spy.mock.calls[0]?.[0]);
    expect(logged).toContain(reference);
    expect(logged).not.toContain("supersecret");
    spy.mockRestore();
  });
});

describe("readJson()", () => {
  const schema = z.object({ amount: z.number() });
  const jsonHeaders = { "content-type": "application/json" };

  test("reads and validates a JSON body", async () => {
    expect(await readJson(request({ headers: jsonHeaders, body: '{"amount":5}' }), schema)).toEqual({ amount: 5 });
  });

  test("accepts the media type with a charset parameter", async () => {
    const body = await readJson(request({ headers: { "content-type": "application/json; charset=utf-8" }, body: '{"amount":1}' }), schema);
    expect(body.amount).toBe(1);
  });

  test.each([
    { type: "text/plain", why: "a plain-text body" },
    { type: "text/plain; x=application/json", why: "a body that only MENTIONS json in a parameter" },
    { type: "application/jsonp", why: "a lookalike type" },
    { type: undefined, why: "no content type at all" },
  ])("refuses $type with 415 ($why)", async ({ type }) => {
    const headers = type ? { "content-type": type } : undefined;
    await expect(readJson(request({ headers, body: '{"amount":5}' }), schema)).rejects.toMatchObject({ status: 415 });
  });

  test("refuses a body that is not valid JSON with 400", async () => {
    await expect(readJson(request({ headers: jsonHeaders, body: "{nope" }), schema)).rejects.toMatchObject({ status: 400, code: "invalid_json" });
  });

  test("refuses a body that does not match the schema, by throwing the validation error", async () => {
    await expect(readJson(request({ headers: jsonHeaders, body: '{"amount":"five"}' }), schema)).rejects.toBeInstanceOf(ZodError);
  });

  test("refuses an oversized body declared up front, without reading it", async () => {
    const big = "x".repeat(150_000);
    await expect(readJson(request({ headers: { ...jsonHeaders, "content-length": String(big.length) }, body: JSON.stringify({ big }) }), schema)).rejects.toMatchObject({ status: 413 });
  });

  test("refuses an oversized body even when no length was declared (chunked)", async () => {
    const big = JSON.stringify({ amount: 1, pad: "x".repeat(150_000) });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(big);
        controller.enqueue(bytes.slice(0, 60_000));
        controller.enqueue(bytes.slice(60_000));
        controller.close();
      },
    });
    const chunked = new Request("http://app.example/api/x", { method: "POST", headers: jsonHeaders, body: stream, duplex: "half" } as RequestInit);
    await expect(readJson(chunked, schema)).rejects.toMatchObject({ status: 413 });
  });

  test("an empty body is invalid JSON, not a crash", async () => {
    await expect(readJson(request({ headers: jsonHeaders, body: "" }), schema)).rejects.toMatchObject({ status: 400 });
  });
});

describe("assertSameOrigin()", () => {
  const allowed = (headers: Record<string, string>) => () => assertSameOrigin(request({ headers }));

  test("lets a request from this site through", () => {
    expect(allowed({ origin: "http://app.example", host: "app.example" })).not.toThrow();
  });

  test("blocks a request from another site, even with a valid session", () => {
    expect(allowed({ origin: "https://evil.example", host: "app.example" })).toThrow(/Request blocked/);
  });

  test("blocks a lookalike host", () => {
    expect(allowed({ origin: "http://app.example.evil.example", host: "app.example" })).toThrow();
    expect(allowed({ origin: "http://evil-app.example", host: "app.example" })).toThrow();
  });

  test("compares the port as well", () => {
    expect(allowed({ origin: "http://app.example:3000", host: "app.example:3200" })).toThrow();
    expect(allowed({ origin: "http://app.example:3200", host: "app.example:3200" })).not.toThrow();
  });

  test("behind a proxy, trusts the forwarded host the proxy reports", () => {
    expect(allowed({ origin: "https://public.example", host: "internal:3000", "x-forwarded-host": "public.example" })).not.toThrow();
  });

  test("with no Origin, accepts only a browser that says the request is same-origin", () => {
    expect(allowed({ "sec-fetch-site": "same-origin" })).not.toThrow();
    expect(allowed({ "sec-fetch-site": "cross-site" })).toThrow();
    expect(allowed({})).toThrow();
  });

  test("a malformed Origin is refused rather than crashing", () => {
    expect(allowed({ origin: "not a url", host: "app.example" })).toThrow(/Request blocked/);
  });
});
