import { describe, expect, test } from "vitest";
import { assertDevSchema, devUrl, plainUrl, toDirectUrl } from "./dev-db-url.mjs";

const RAW = "postgres://user:secret@pooled.db.example.com:5432/postgres?sslmode=require&schema=public";

describe("assertDevSchema", () => {
  test.each(["credit_dev", "credit_test", "credit_test_ledger", "credit_dev2"])("allows %s", (name) => {
    expect(assertDevSchema(name)).toBe(name);
  });

  test.each(["public", "credit", "qa_test", "credit_prod", "Credit_dev", "credit_dev; drop schema public", "", undefined])(
    "refuses %s",
    (name) => {
      expect(() => assertDevSchema(name)).toThrow(/Refusing/);
    },
  );
});

describe("toDirectUrl", () => {
  test("removes the pooled prefix", () => {
    expect(toDirectUrl(RAW).hostname).toBe("db.example.com");
  });

  test("states certificate verification explicitly", () => {
    expect(toDirectUrl(RAW).searchParams.get("sslmode")).toBe("verify-full");
  });

  test("leaves an already direct host alone", () => {
    expect(toDirectUrl("postgres://u:p@db.example.com/postgres").hostname).toBe("db.example.com");
  });
});

describe("plainUrl", () => {
  test("drops any schema parameter and keeps the rest", () => {
    const url = new URL(plainUrl(RAW));
    expect(url.searchParams.has("schema")).toBe(false);
    expect(url.searchParams.get("sslmode")).toBe("verify-full");
  });
});

describe("devUrl", () => {
  test("pins the dev schema on the direct host, replacing the live schema", () => {
    const url = new URL(devUrl(RAW, "credit_dev"));
    expect(url.hostname).toBe("db.example.com");
    expect(url.searchParams.get("schema")).toBe("credit_dev");
  });

  test("refuses to build an address for a live schema", () => {
    expect(() => devUrl(RAW, "public")).toThrow(/Refusing/);
  });

  test("does not mutate its input", () => {
    devUrl(RAW, "credit_dev");
    expect(RAW).toContain("schema=public");
  });
});
