import { describe, expect, test } from "vitest";
import { resolveDevConfig } from "./dev-db-env.mjs";

const LIVE = "postgres://live:pw@db.example.com/postgres?sslmode=require";
const DEV = "postgres://dev_only:pw@db.example.com/postgres?sslmode=require";

describe("resolveDevConfig", () => {
  test("prefers the restricted development address over the live one", () => {
    expect(resolveDevConfig({}, { LIVE_DATABASE_URL_DIRECT: LIVE, DEV_DATABASE_URL_DIRECT: DEV })).toMatchObject({ raw: DEV, source: "DEV_DATABASE_URL_DIRECT" });
  });

  test("falls back to the live address, then to the test address CI provides", () => {
    expect(resolveDevConfig({}, { LIVE_DATABASE_URL_DIRECT: LIVE })).toMatchObject({ raw: LIVE, source: "LIVE_DATABASE_URL_DIRECT" });
    expect(resolveDevConfig({ TEST_DATABASE_URL: "postgres://postgres:pw@127.0.0.1:5432/postgres" }, {})).toMatchObject({ source: "TEST_DATABASE_URL" });
  });

  test("the real environment wins over the file", () => {
    expect(resolveDevConfig({ LIVE_DATABASE_URL_DIRECT: DEV }, { LIVE_DATABASE_URL_DIRECT: LIVE }).raw).toBe(DEV);
  });

  test("says nothing was found when there is nothing", () => {
    expect(resolveDevConfig({}, {})).toBeNull();
  });

  test("the schema defaults to credit_dev, comes from either place, and is refused unless it is a development schema", () => {
    expect(resolveDevConfig({}, { LIVE_DATABASE_URL_DIRECT: LIVE }).schema).toBe("credit_dev");
    expect(resolveDevConfig({ CREDIT_DEV_SCHEMA: "credit_test_x" }, { LIVE_DATABASE_URL_DIRECT: LIVE }).schema).toBe("credit_test_x");
    expect(() => resolveDevConfig({ CREDIT_DEV_SCHEMA: "public" }, { LIVE_DATABASE_URL_DIRECT: LIVE })).toThrow(/Refusing/);
  });
});
