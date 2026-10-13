import "server-only";
import { PrismaClient } from "@/generated/prisma/client";
import { adapterFor } from "./db-url";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set. Start the app with `npm run dev`.");
  return new PrismaClient({ adapter: adapterFor(connectionString) });
}

/** Created on first use, not on import, so `next build` works on a machine with no database configured. */
function getClient(): PrismaClient {
  // Kept on globalThis so development hot reloads reuse one pool instead of opening a new one per edit.
  globalForPrisma.prisma ??= createPrismaClient();
  return globalForPrisma.prisma;
}

/**
 * The database client. A thin proxy over the real one: every property is looked up on the client when it is used.
 * Functions are bound to the real client so Prisma's internals never see the proxy as `this`.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property) {
    const client = getClient();
    const value = Reflect.get(client, property, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
