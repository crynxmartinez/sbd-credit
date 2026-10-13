import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": fromRoot("./src"),
      "server-only": fromRoot("./src/test/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    // Integration tests need a database: run them with `npm run test:db`.
    exclude: ["**/node_modules/**", "**/*.int.test.ts"],
    coverage: {
      provider: "v8",
      // Pure logic only. Cookie and database glue (auth/current-user.ts, services) is covered by `npm run test:db`.
      include: ["src/lib/domain/**", "src/lib/server/auth/{token,lockout,rate-limit}.ts", "src/lib/server/as-of.ts"],
      exclude: ["**/*.test.ts"],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
