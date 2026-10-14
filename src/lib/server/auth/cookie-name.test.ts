import { describe, expect, test } from "vitest";
import { cookieNameFor } from "./cookie-name";

describe("cookieNameFor", () => {
  test("staff and customers use different cookies", () => {
    expect(cookieNameFor("staff", false)).not.toBe(cookieNameFor("customer", false));
  });

  test("in production the name carries the __Host- prefix, so a sibling subdomain cannot plant a cookie for this site", () => {
    expect(cookieNameFor("staff", true)).toBe("__Host-credit_session");
    expect(cookieNameFor("customer", true)).toBe("__Host-credit_portal_session");
  });

  test("in development it is plain, because the prefix needs https", () => {
    expect(cookieNameFor("staff", false)).toBe("credit_session");
    expect(cookieNameFor("customer", false)).toBe("credit_portal_session");
  });
});
