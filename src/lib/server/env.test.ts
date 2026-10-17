import { describe, expect, test } from "vitest";
import { validateEnvironment } from "./env";

const GOOD_DEV = {
  NODE_ENV: "development",
  DATABASE_URL: "postgres://u:p@db.example.com:5432/postgres?schema=credit_dev",
  SESSION_SECRET: "a-session-secret-that-is-long-enough-x",
};
const GOOD_PROD = {
  ...GOOD_DEV,
  NODE_ENV: "production",
  DATABASE_URL: "postgres://u:p@db.example.com:5432/postgres?schema=credit&sslmode=require",
  PUBLIC_BASE_URL: "https://credit.example.com",
  TRUSTED_PROXY_HOPS: "1",
};
const GOOD_PROD_TLS = GOOD_PROD;

describe("validateEnvironment", () => {
  test("accepts a complete development and production setup", () => {
    expect(validateEnvironment(GOOD_DEV)).toEqual([]);
    expect(validateEnvironment(GOOD_PROD)).toEqual([]);
  });

  test("reports every missing piece at once, not just the first", () => {
    expect(validateEnvironment({ NODE_ENV: "production" })).toEqual([
      "DATABASE_URL is not set.",
      "SESSION_SECRET is not set.",
      expect.stringContaining("PUBLIC_BASE_URL"),
      expect.stringContaining("TRUSTED_PROXY_HOPS"),
    ]);
  });

  test("refuses a short session secret", () => {
    expect(validateEnvironment({ ...GOOD_DEV, SESSION_SECRET: "short" })).toEqual([expect.stringContaining("at least 32")]);
  });

  test("refuses a database address that would reach the wrong tables", () => {
    const live = { ...GOOD_PROD, DATABASE_URL: "postgres://u:p@db.example.com/postgres?schema=public&sslmode=require" };
    expect(validateEnvironment(live)).toEqual([expect.stringContaining("Refusing")]);
    const noSchema = { ...GOOD_PROD, DATABASE_URL: "postgres://u:p@db.example.com/postgres?sslmode=require" };
    expect(validateEnvironment(noSchema)).toEqual([expect.stringContaining("schema")]);
  });

  test("refuses the sign-in shortcut in production", () => {
    expect(validateEnvironment({ ...GOOD_PROD, CREDIT_DEV_AUTOLOGIN: "1" })).toEqual([
      expect.stringContaining("CREDIT_DEV_AUTOLOGIN"),
    ]);
    expect(validateEnvironment({ ...GOOD_DEV, CREDIT_DEV_AUTOLOGIN: "1" })).toEqual([]);
  });

  test("refuses an unknown business time zone", () => {
    expect(validateEnvironment({ ...GOOD_DEV, BUSINESS_TIME_ZONE: "Mars/Olympus" })).toEqual([expect.stringContaining("time zone")]);
    expect(validateEnvironment({ ...GOOD_DEV, BUSINESS_TIME_ZONE: "America/Chicago" })).toEqual([]);
  });
});

describe("PUBLIC_BASE_URL", () => {
  test("is required in production, because customer invitation links are built from it", () => {
    const withoutIt: Record<string, string | undefined> = { ...GOOD_PROD };
    delete withoutIt.PUBLIC_BASE_URL;
    expect(validateEnvironment(withoutIt)).toEqual([expect.stringContaining("PUBLIC_BASE_URL")]);
  });

  test("must be https in production, and is optional in development", () => {
    expect(validateEnvironment({ ...GOOD_PROD, PUBLIC_BASE_URL: "http://credit.example.com" })).toEqual([expect.stringContaining("https")]);
    expect(validateEnvironment(GOOD_DEV)).toEqual([]);
    expect(validateEnvironment({ ...GOOD_DEV, PUBLIC_BASE_URL: "not a url" })).toEqual([expect.stringContaining("PUBLIC_BASE_URL")]);
  });
});

describe("production-only checks", () => {
  test("the database connection must use TLS in production", () => {
    const noTls = { ...GOOD_PROD, DATABASE_URL: "postgres://u:p@db.example.com:5432/postgres?schema=credit" };
    expect(validateEnvironment(noTls)).toEqual([expect.stringContaining("sslmode")]);
    for (const mode of ["require", "verify-ca", "verify-full"]) {
      expect(validateEnvironment({ ...GOOD_PROD, DATABASE_URL: `postgres://u:p@db.example.com:5432/postgres?schema=credit&sslmode=${mode}` })).toEqual([]);
    }
    expect(validateEnvironment({ ...GOOD_PROD, DATABASE_URL: "postgres://u:p@db.example.com:5432/postgres?schema=credit&sslmode=disable" })).toEqual([expect.stringContaining("sslmode")]);
  });

  test("development may connect without TLS (a local database)", () => {
    expect(validateEnvironment(GOOD_DEV)).toEqual([]);
  });

  test("the sign-in limit overrides used by the test suite are refused in production", () => {
    expect(validateEnvironment({ ...GOOD_PROD_TLS, LOGIN_ATTEMPTS_PER_ADDRESS: "10000" })).toEqual([expect.stringContaining("LOGIN_ATTEMPTS_PER_ADDRESS")]);
    expect(validateEnvironment({ ...GOOD_PROD_TLS, LOGIN_ATTEMPTS_PER_ACCOUNT: "10000" })).toEqual([expect.stringContaining("LOGIN_ATTEMPTS_PER_ACCOUNT")]);
    expect(validateEnvironment({ ...GOOD_PROD_TLS, LOGIN_FREE_FAILURES: "10000" })).toEqual([expect.stringContaining("LOGIN_FREE_FAILURES")]);
    expect(validateEnvironment({ ...GOOD_DEV, LOGIN_ATTEMPTS_PER_ADDRESS: "10000" })).toEqual([]);
  });

  test("production must say how many proxies it is behind", () => {
    const without: Record<string, string> = { ...GOOD_PROD };
    delete without.TRUSTED_PROXY_HOPS;
    expect(validateEnvironment(without)).toEqual([expect.stringContaining("TRUSTED_PROXY_HOPS must be set")]);
    expect(validateEnvironment({ ...GOOD_DEV })).toEqual([]);
  });

  test("production refuses TRUSTED_PROXY_HOPS=0, which would make every visitor one address; development may use it", () => {
    expect(validateEnvironment({ ...GOOD_PROD_TLS, TRUSTED_PROXY_HOPS: "0" })).toEqual([expect.stringContaining("not allowed in production")]);
    expect(validateEnvironment({ ...GOOD_DEV, TRUSTED_PROXY_HOPS: "0" })).toEqual([]);
  });

  test("TRUSTED_PROXY_HOPS must be a small whole number when set", () => {
    expect(validateEnvironment({ ...GOOD_PROD_TLS, TRUSTED_PROXY_HOPS: "2" })).toEqual([]);
    for (const bad of ["many", "-1", "1.5", "9", ""]) {
      expect(validateEnvironment({ ...GOOD_PROD_TLS, TRUSTED_PROXY_HOPS: bad }), bad).toEqual([expect.stringContaining("TRUSTED_PROXY_HOPS")]);
    }
  });

  test("an empty BUSINESS_TIME_ZONE is refused instead of failing on every request", () => {
    expect(validateEnvironment({ ...GOOD_DEV, BUSINESS_TIME_ZONE: "" })).toEqual([expect.stringContaining("BUSINESS_TIME_ZONE")]);
  });
});
