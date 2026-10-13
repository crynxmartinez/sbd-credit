/**
 * Integration tests against a throwaway schema.
 *
 *   npm run test:db
 *
 * Rebuilds the credit_test schema from the migrations, runs every *.int.test.ts file against it, and leaves it in
 * place so a failure can be inspected. Nothing outside credit_test is touched.
 */
import { spawnSync } from "node:child_process";

const env = { ...process.env, CREDIT_DEV_SCHEMA: "credit_test" };

function step(label, command) {
  console.log(`\n[test-db] ${label}`);
  const result = spawnSync(command, { stdio: "inherit", shell: true, env });
  if (result.status !== 0) {
    console.error(`[test-db] failed during: ${label}`);
    process.exit(result.status ?? 1);
  }
}

step("reset the credit_test schema", "node scripts/dev-db.mjs reset");
step("apply migrations", "node scripts/with-dev-db.mjs prisma migrate deploy");
step("run integration tests", "node scripts/with-dev-db.mjs vitest run --config vitest.int.config.mts");
