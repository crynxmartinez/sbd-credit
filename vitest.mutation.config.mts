import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Used only by `stryker.services.config.json`: the integration tests that exercise services/ledger.ts, against a real database.
export default defineConfig({
  resolve: { alias: { "@": fromRoot("./src"), "server-only": fromRoot("./src/test/server-only.ts") } },
  test: {
    environment: "node",
    include: [
      "src/lib/server/services/services.int.test.ts",
      "src/lib/server/services/ledger-rules.int.test.ts",
      "src/lib/server/services/write-off-allocations.int.test.ts",
      "src/lib/server/services/books-model.int.test.ts",
    ],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
