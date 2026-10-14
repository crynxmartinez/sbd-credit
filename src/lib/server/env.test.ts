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
  DATABASE_URL: "postgres://u:p@db.example.com:5432/postgres?schema=credit",
  PUBLIC_BASE_URL: "https://credit.example.com",
};

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
    ]);
  });

  test("refuses a short session secret", () => {
    expect(validateEnvironment({ ...GOOD_DEV, SESSION_SECRET: "short" })).toEqual([expect.stringContaining("at least 32")]);
  });

  test("refuses a database address that would reach the wrong tables", () => {
    const live = { ...GOOD_PROD, DATABASE_URL: "postgres://u:p@db.example.com/postgres?schema=public" };
    expect(validateEnvironment(live)).toEqual([expect.stringContaining("Refusing")]);
    const noSchema = { ...GOOD_PROD, DATABASE_URL: "postgres://u:p@db.example.com/postgres" };
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
