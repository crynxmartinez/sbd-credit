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
      // The pure logic, and the code around it that decides who may do what and what an error means. The database services
      // (src/lib/server/services) and the screens are covered by `npm run test:db` and `npm run e2e` instead.
      include: [
        "src/lib/domain/**",
        "src/lib/safe-next.ts",
        "src/lib/validation.ts",
        "src/lib/server/{as-of,clock,db-errors,db-url,env,http,log,public-url}.ts",
        "src/lib/server/auth/**",
        "src/app/api/auth/login/route.ts",
        "src/app/api/portal/accept/route.ts",
      ],
      exclude: ["**/*.test.ts"],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
