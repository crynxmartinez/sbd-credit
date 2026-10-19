import { describe, expect, test } from "vitest";
import { assertDevSchema, devUrl, plainUrl, toDirectUrl } from "./dev-db-url.mjs";

const RAW = "postgres://user:secret@pooled.db.example.com:5432/postgres?sslmode=require&schema=public";

describe("assertDevSchema", () => {
  test.each(["credit_dev", "credit_test", "credit_test_ledger", "credit_test_e2e", "credit_test_restore_old"])("allows %s", (name) => {
    expect(assertDevSchema(name)).toBe(name);
  });

  test.each(["public", "credit", "qa_test", "credit_prod", "Credit_dev", "credit_dev; drop schema public", "", undefined, "credit_devious", "credit_testing_prod", "credit_dev2", "credit_test_", "credit_dev\n"])(
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
    expect(toDirectUrl("postgres://u:p@db.example.com/postgres?sslmode=require").hostname).toBe("db.example.com");
  });

  test("refuses a remote server with no encryption, in development too", () => {
    expect(() => toDirectUrl("postgres://u:p@db.example.com/postgres")).toThrow(/sslmode/);
    expect(() => toDirectUrl("postgres://u:p@db.example.com/postgres?sslmode=disable")).toThrow(/sslmode/);
    expect(() => toDirectUrl("postgres://u:p@db.example.com/postgres?sslmode=allow")).toThrow(/sslmode/);
  });

  test("a server on this machine may be unencrypted (CI starts one)", () => {
    expect(() => toDirectUrl("postgres://postgres:pw@127.0.0.1:5432/postgres")).not.toThrow();
    expect(() => toDirectUrl("postgres://postgres:pw@localhost:5432/postgres")).not.toThrow();
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
