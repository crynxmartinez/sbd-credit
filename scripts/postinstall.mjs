/**
 * Generate the Prisma client after install, once a schema exists. Skipped quietly before that.
 *
 * Runs the locally installed prisma only (`--no-install`): without it, `npx` would FETCH whatever the latest prisma is from the
 * registry and run it when prisma was not installed (for example `npm ci --omit=dev`), which is exactly what a lockfile is for
 * preventing.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (existsSync("prisma/schema.prisma")) {
  if (!existsSync("node_modules/prisma")) {
    console.warn("[postinstall] prisma is not installed here, so the client was not generated. Install in full (npm ci) before building.");
  } else {
    const result = spawnSync("npx", ["--no-install", "prisma", "generate"], { stdio: "inherit", shell: true });
    process.exit(result.status ?? 1);
  }
}
