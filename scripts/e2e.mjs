/**
 * End-to-end test run.
 *
 *   npm run e2e
 *
 * 1. rebuilds the credit_test_e2e schema from the migrations,
 * 2. creates an admin and an employee with FRESH random passwords (they exist only for this run and are never printed),
 * 3. loads the demo customers,
 * 4. starts the app on port 3201 against that schema with the sign-in shortcut OFF, so the real login runs,
 * 5. runs the browser tests, then stops the app.
 *
 * Nothing outside credit_test_e2e is touched.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const PORT = 3201;
const SCHEMA = "credit_test_e2e";

const password = () => `Pw-${randomBytes(12).toString("base64url")}`;
const adminPassword = password();
const employeePassword = password();

const baseEnv = {
  ...process.env,
  CREDIT_DEV_SCHEMA: SCHEMA,
  CREDIT_DEV_AUTOLOGIN: "", // present but empty: the real sign-in screen is exercised
  // The suite signs in far more often than a person would, all from one address. The limiter itself is tested separately.
  LOGIN_ATTEMPTS_PER_ADDRESS: "10000",
  E2E_ADMIN_USERNAME: "e2e.admin",
  E2E_ADMIN_PASSWORD: adminPassword,
  E2E_EMPLOYEE_USERNAME: "e2e.employee",
  E2E_EMPLOYEE_PASSWORD: employeePassword,
};

function step(label, command, extraEnv = {}) {
  console.log(`\n[e2e] ${label}`);
  const result = spawnSync(command, { stdio: "inherit", shell: true, env: { ...baseEnv, ...extraEnv } });
  if (result.status !== 0) {
    console.error(`[e2e] failed during: ${label}`);
    process.exit(result.status ?? 1);
  }
}

step("reset the schema", "node scripts/dev-db.mjs reset");
step("apply migrations", "node scripts/with-dev-db.mjs prisma migrate deploy");
step("create the e2e admin", 'node scripts/with-dev-db.mjs tsx scripts/users.ts create e2e.admin "E2E Admin" SUPERADMIN', { NEW_USER_PASSWORD: adminPassword });
step("create the e2e employee", 'node scripts/with-dev-db.mjs tsx scripts/users.ts create e2e.employee "E2E Employee" EMPLOYEE', { NEW_USER_PASSWORD: employeePassword });
step("load demo customers", "node scripts/with-dev-db.mjs tsx scripts/seed.ts demo");

console.log(`\n[e2e] starting the app on port ${PORT}`);
const server = spawn(`node scripts/with-dev-db.mjs next dev -p ${PORT} -H 127.0.0.1`, { shell: true, env: baseEnv, stdio: "ignore" });

async function waitForServer() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/login`, { redirect: "manual" });
      if (response.status === 200) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

function stopServer() {
  // The server was started through a shell, so ask the OS to end the whole tree.
  if (process.platform === "win32") spawnSync(`taskkill /pid ${server.pid} /T /F`, { shell: true, stdio: "ignore" });
  else server.kill("SIGTERM");
}

let status = 1;
try {
  if (!(await waitForServer())) {
    console.error("[e2e] the app did not start in time");
  } else {
    const extra = process.argv.slice(2).join(" ");
    const result = spawnSync(`npx playwright test ${extra}`, { stdio: "inherit", shell: true, env: baseEnv });
    status = result.status ?? 1;
  }
} finally {
  stopServer();
}
process.exit(status);
