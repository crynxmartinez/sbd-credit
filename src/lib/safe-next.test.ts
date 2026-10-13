import { describe, expect, test } from "vitest";
import { safeNextPath } from "./safe-next";

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
