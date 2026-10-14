import { describe, expect, test } from "vitest";
import { inviteLink, publicBaseUrl } from "./public-url";

describe("publicBaseUrl", () => {
  test("uses the configured address, ignoring any path or trailing slash", () => {
    expect(publicBaseUrl({ PUBLIC_BASE_URL: "https://credit.example.com/" })).toBe("https://credit.example.com");
    expect(publicBaseUrl({ PUBLIC_BASE_URL: "https://credit.example.com/some/path?x=1" })).toBe("https://credit.example.com");
  });

  test("in production it must be set, and must be https", () => {
    expect(() => publicBaseUrl({ NODE_ENV: "production" })).toThrow(/PUBLIC_BASE_URL/);
    expect(() => publicBaseUrl({ NODE_ENV: "production", PUBLIC_BASE_URL: "http://credit.example.com" })).toThrow(/https/);
  });

  test("plain http is allowed only for this machine", () => {
    expect(publicBaseUrl({ PUBLIC_BASE_URL: "http://127.0.0.1:3201" })).toBe("http://127.0.0.1:3201");
    expect(() => publicBaseUrl({ PUBLIC_BASE_URL: "http://credit.example.com" })).toThrow(/https/);
  });

  test("refuses something that is not a web address", () => {
    expect(() => publicBaseUrl({ PUBLIC_BASE_URL: "not a url" })).toThrow(/PUBLIC_BASE_URL/);
    expect(() => publicBaseUrl({ PUBLIC_BASE_URL: "javascript:alert(1)" })).toThrow();
  });

  test("falls back to the local dev server when nothing is set outside production", () => {
    expect(publicBaseUrl({})).toBe("http://127.0.0.1:3200");
  });
});

describe("inviteLink", () => {
  test("puts the token in the fragment, which the browser never sends to any server or in a Referer", () => {
    const link = inviteLink("abc_DEF-123", { PUBLIC_BASE_URL: "https://credit.example.com" });
    expect(link).toBe("https://credit.example.com/accept-invite#t=abc_DEF-123");
    expect(new URL(link).search).toBe("");
  });
});
