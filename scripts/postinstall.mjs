/** Generate the Prisma client after install, once a schema exists. Skipped quietly before that. */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (existsSync("prisma/schema.prisma")) {
  const result = spawnSync("npx", ["prisma", "generate"], { stdio: "inherit", shell: true });
  process.exit(result.status ?? 1);
}
