import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests. Run them with `npm run e2e`, which builds a throwaway schema, starts the app against it and passes
 * in freshly generated sign-in details. They use the Microsoft Edge that Windows already has, so nothing is downloaded.
 */
const PORT = 3201;

export default defineConfig({
  testDir: "e2e",
  // One shared database, and the tests build on each other's data: run them one at a time, in file order.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: "msedge",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // Started by scripts/e2e.mjs, which also prepares the database, so nothing here can point at the wrong schema.
  webServer: undefined,
});
