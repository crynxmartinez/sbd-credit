import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Which tables this process may read and write.
 *
 * A schema is chosen by changing the database SESSION. On the pooled address the pool hands that session to the next
 * client, the live website included, so a schema on a pooled address is refused outright. Outside production, only the
 * credit_dev / credit_test* schemas are allowed, so a developer machine can never be pointed at live data by accident.
 */
const DEV_SCHEMA_PATTERN = /^credit_(dev|test)[a-z0-9_]*$/;
const PRODUCTION_SCHEMA = "credit";

export function schemaFromUrl(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get("schema") ?? undefined;
  } catch {
    return undefined;
  }
}

/** Ports connection poolers commonly listen on (pgbouncer, Supabase, Prisma Postgres). */
const POOLER_PORTS = new Set(["6432", "6543"]);

export function isPooledHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /^pooled\./i.test(parsed.hostname) || POOLER_PORTS.has(parsed.port);
  } catch {
    return false;
  }
}

/** Throws unless this address is a safe target for the given environment. */
export function assertSafeTarget(url: string, nodeEnv: string | undefined): void {
  const schema = schemaFromUrl(url);
  if (!schema) {
    throw new Error("DATABASE_URL must name a schema (?schema=credit_dev). Refusing to use the default schema.");
  }
  if (isPooledHost(url)) {
    throw new Error("Refusing to use a schema on the pooled database address. Use the direct address.");
  }
  const allowed = nodeEnv === "production" ? schema === PRODUCTION_SCHEMA : DEV_SCHEMA_PATTERN.test(schema);
  if (!allowed) {
    throw new Error(`Refusing schema "${schema}" outside its environment (NODE_ENV=${nodeEnv ?? "unset"}).`);
  }
}

/**
 * Spell out the TLS mode pg already applies. `require` and `prefer` currently mean full certificate verification;
 * saying so explicitly keeps that true after pg changes its defaults (and silences its warning).
 */
export function withExplicitSsl(url: string): string {
  const parsed = new URL(url);
  const mode = parsed.searchParams.get("sslmode");
  if (mode === "require" || mode === "prefer" || mode === "verify-ca") parsed.searchParams.set("sslmode", "verify-full");
  return parsed.toString();
}

/** Opening a connection to a remote database is slow, so idle ones are kept for a while instead of closed at once. */
const POOL = { max: 10, idleTimeoutMillis: 5 * 60_000, connectionTimeoutMillis: 20_000, keepAlive: true } as const;

/**
 * The connection settings for one database address.
 *
 * `search_path` is set on the connection itself. Prisma qualifies the tables in the queries it generates, but a raw SQL
 * statement uses whatever the connection's search path is, and by default that is `public`: on a server shared with
 * another application, an unqualified table name would resolve into ITS tables. Pinning the search path here means
 * every statement, raw or generated, can only ever see this app's schema.
 */
export function poolConfigFor(connectionString: string, nodeEnv: string | undefined = process.env.NODE_ENV) {
  assertSafeTarget(connectionString, nodeEnv);
  const schema = schemaFromUrl(connectionString);
  return {
    connectionString: withExplicitSsl(connectionString),
    ...POOL,
    // assertSafeTarget already limited the schema to letters, digits and underscores, so this cannot be abused.
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  };
}

export function adapterFor(connectionString: string, nodeEnv: string | undefined = process.env.NODE_ENV): PrismaPg {
  const schema = schemaFromUrl(connectionString);
  return new PrismaPg(poolConfigFor(connectionString, nodeEnv), schema ? { schema } : undefined);
}
