import { describe, expect, test } from "vitest";
import { assertSafeTarget, isPooledHost, poolConfigFor, schemaFromUrl, withExplicitSsl } from "./db-url";

const base = "postgres://u:p@db.example.com:5432/postgres?sslmode=require";

describe("assertSafeTarget", () => {
  test("allows the dev schemas outside production", () => {
    expect(() => assertSafeTarget(`${base}&schema=credit_dev`, "development")).not.toThrow();
    expect(() => assertSafeTarget(`${base}&schema=credit_test_ledger`, "test")).not.toThrow();
  });

  test("refuses the live shipper tables from a developer machine", () => {
    expect(() => assertSafeTarget(`${base}&schema=public`, "development")).toThrow(/Refusing/);
    expect(() => assertSafeTarget(`${base}&schema=qa_test`, "development")).toThrow(/Refusing/);
    expect(() => assertSafeTarget(`${base}&schema=credit`, "development")).toThrow(/Refusing/);
  });

  test("production uses only the credit schema", () => {
    expect(() => assertSafeTarget(`${base}&schema=credit`, "production")).not.toThrow();
    expect(() => assertSafeTarget(`${base}&schema=credit_dev`, "production")).toThrow(/Refusing/);
    expect(() => assertSafeTarget(`${base}&schema=public`, "production")).toThrow(/Refusing/);
  });

  test("refuses an address with no schema", () => {
    expect(() => assertSafeTarget(base, "development")).toThrow(/schema/);
  });

  test("refuses a schema on the pooled host", () => {
    const pooled = "postgres://u:p@pooled.db.example.com/postgres?schema=credit_dev";
    expect(() => assertSafeTarget(pooled, "development")).toThrow(/pooled/);
  });
});

describe("helpers", () => {
  test("schemaFromUrl reads the schema and tolerates junk", () => {
    expect(schemaFromUrl(`${base}&schema=credit_dev`)).toBe("credit_dev");
    expect(schemaFromUrl(base)).toBeUndefined();
    expect(schemaFromUrl("not a url")).toBeUndefined();
  });

  test("isPooledHost detects the pooled prefix and common pooler ports", () => {
    expect(isPooledHost("postgres://u:p@pooled.db.example.com/x")).toBe(true);
    expect(isPooledHost("postgres://u:p@db.example.com:6432/x")).toBe(true);
    expect(isPooledHost("postgres://u:p@db.example.com:6543/x")).toBe(true);
    expect(isPooledHost("postgres://u:p@db.example.com:5432/x")).toBe(false);
    expect(isPooledHost("postgres://u:p@db.example.com/x")).toBe(false);
  });
});

describe("withExplicitSsl", () => {
  test.each(["require", "prefer", "verify-ca"])("turns sslmode=%s into verify-full", (mode) => {
    const url = new URL(withExplicitSsl(`postgres://u:p@db.example.com/x?sslmode=${mode}&schema=credit_dev`));
    expect(url.searchParams.get("sslmode")).toBe("verify-full");
    expect(url.searchParams.get("schema")).toBe("credit_dev");
  });

  test("leaves other modes and missing modes alone", () => {
    expect(new URL(withExplicitSsl("postgres://u:p@h/x?sslmode=disable")).searchParams.get("sslmode")).toBe("disable");
    expect(new URL(withExplicitSsl("postgres://u:p@h/x")).searchParams.has("sslmode")).toBe(false);
  });
});

describe("poolConfigFor", () => {
  test("pins the connection's search path to the app's schema, so raw SQL cannot reach another app's tables", () => {
    expect(poolConfigFor(`${base}&schema=credit_dev`, "development").options).toBe("-c search_path=credit_dev");
    expect(poolConfigFor(`${base}&schema=credit`, "production").options).toBe("-c search_path=credit");
  });

  test("still refuses an unsafe target, so the search path can never name a live schema", () => {
    expect(() => poolConfigFor(`${base}&schema=public`, "development")).toThrow(/Refusing/);
    expect(() => poolConfigFor(`${base}&schema=credit_dev; DROP SCHEMA public`, "development")).toThrow(/Refusing/);
  });

  test("keeps the explicit TLS mode and the pool limits", () => {
    const config = poolConfigFor(`${base}&schema=credit_dev`, "development");
    expect(new URL(config.connectionString).searchParams.get("sslmode")).toBe("verify-full");
    expect(config.max).toBe(10);
    expect(config.keepAlive).toBe(true);
  });
});
