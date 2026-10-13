import "dotenv/config";
import { defineConfig } from "prisma/config";
import { assertSafeTarget } from "./src/lib/server/db-url";

// The Prisma CLI can migrate, reset or push, so it gets the same guard as the app: an address with no schema (which
// would land on the live `public` tables), a pooled address, or a schema outside this environment is refused.
// Production is an explicit choice: run with NODE_ENV=production and a ?schema=credit address.
const url = process.env["DATABASE_URL"];
if (url) assertSafeTarget(url, process.env.NODE_ENV);

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env["DATABASE_URL"] },
});
