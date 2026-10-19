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
import { openSync } from "node:fs";
import { waitPastMidnightIfNear } from "./lib/midnight-guard.mjs";

const PORT = Number(process.env.E2E_PORT ?? 3201);
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
  LOGIN_ATTEMPTS_PER_ACCOUNT: "10000",
  LOGIN_FREE_FAILURES: "10000",
  // Where invitation links point. They are only ever read by the tests, never followed over the network.
  PUBLIC_BASE_URL: `http://127.0.0.1:${PORT}`,
  // The tests read where the app is from here, so the port is chosen in exactly one place.
  E2E_ORIGIN: `http://127.0.0.1:${PORT}`,
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

await waitPastMidnightIfNear("e2e");
step("reset the schema", "node scripts/dev-db.mjs reset");
step("apply migrations", "node scripts/with-dev-db.mjs prisma migrate deploy");
step("create the e2e admin", 'node scripts/with-dev-db.mjs tsx scripts/users.ts create e2e.admin "E2E Admin" SUPERADMIN', { NEW_USER_PASSWORD: adminPassword });
step("create the e2e employee", 'node scripts/with-dev-db.mjs tsx scripts/users.ts create e2e.employee "E2E Employee" EMPLOYEE', { NEW_USER_PASSWORD: employeePassword });
step("load demo customers", "node scripts/with-dev-db.mjs tsx scripts/seed.ts demo");

// Something already answering on this port would be tested INSTEAD of the app started below, quietly passing or failing
// against whatever schema it points at. Refuse to start rather than test the wrong server.
try {
  await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(1500), redirect: "manual" });
  console.error(`[e2e] port ${PORT} is already in use by another server. Stop it first (or set E2E_PORT to a free port).`);
  process.exit(1);
} catch {
  // nothing answered: the port is free
}

console.log(`\n[e2e] starting the app on port ${PORT} (its output goes to e2e-server.log)`);
const serverLog = openSync("e2e-server.log", "w");
// Its own process group on macOS/Linux, so the whole tree (the shell, the wrapper, next) can be ended together.
const server = spawn(`node scripts/with-dev-db.mjs next dev -p ${PORT} -H 127.0.0.1`, {
  shell: true,
  env: baseEnv,
  stdio: ["ignore", serverLog, serverLog],
  detached: process.platform !== "win32",
});

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
  else {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

// Ctrl+C must not leave a dev server running on the port.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopServer();
    process.exit(130);
  });
}

let status = 1;
try {
  if (!(await waitForServer())) {
    console.error("[e2e] the app did not start in time. Its output is in e2e-server.log");
  } else {
    const extra = process.argv.slice(2).join(" ");
    const result = spawnSync(`npx playwright test ${extra}`, { stdio: "inherit", shell: true, env: baseEnv });
    status = result.status ?? 1;
  }
} finally {
  stopServer();
}
process.exit(status);
