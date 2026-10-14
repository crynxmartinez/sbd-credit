import { describe, expect, test } from "vitest";
import { safeNextFor, safeNextPath } from "./safe-next";

describe("safeNextPath", () => {
  test.each(["/", "/customers", "/customers?status=approved&q=steel", "/?c=abc123", "/customers?c=x#top"])("keeps the local path %s", (path) => {
    expect(safeNextPath(path)).toBe(path);
  });

  test.each([
    "https://evil.example/login",
    "http://evil.example",
    "//evil.example",
    "///evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "javascript:alert(1)",
    "customers",
    "",
    "/ok\nLocation: https://evil.example",
    "/ok\r\n",
    "/\tevil",
  ])("refuses %j and falls back to the dashboard", (value) => {
    expect(safeNextPath(value)).toBe("/");
  });

  test("never loops back to the sign-in page", () => {
    expect(safeNextPath("/login")).toBe("/");
    expect(safeNextPath("/login?next=/customers")).toBe("/");
  });

  test("handles missing input and a custom fallback", () => {
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath(undefined, "/customers")).toBe("/customers");
  });
});

describe("safeNextFor", () => {
  test("a customer only ever lands inside the customer pages", () => {
    expect(safeNextFor("customer", "/portal")).toBe("/portal");
    expect(safeNextFor("customer", "/portal/statements?m=09")).toBe("/portal/statements?m=09");
    for (const value of ["/customers", "/api/customers", "/portalx", "/portal/../customers", "/portal/%2e%2e/customers", "//evil.example", "https://evil.example", "/", undefined, null, ""]) {
      expect(safeNextFor("customer", value)).toBe("/portal");
    }
  });

  test("staff never get sent to the customer pages", () => {
    expect(safeNextFor("staff", "/customers?status=approved")).toBe("/customers?status=approved");
    expect(safeNextFor("staff", "/portal")).toBe("/");
    expect(safeNextFor("staff", "/portal/anything")).toBe("/");
    expect(safeNextFor("staff", "//evil.example")).toBe("/");
    expect(safeNextFor("staff", undefined)).toBe("/");
  });
});
