/**
 * Pure helpers that decide which database address this project is allowed to use while developing.
 *
 * The rule: local work only ever runs inside a schema named credit_dev / credit_test*, on the DIRECT address.
 * It never gets the live `public` tables, and never the pooled address (a pooled session keeps its schema
 * setting and would hand it to the next client, the live website included).
 */

const DEV_SCHEMA_RULE = /^credit_(dev|test)[a-z0-9_]*$/;

/** Throws unless `schema` is a development schema this project owns. Returns it unchanged. */
export function assertDevSchema(schema) {
  if (typeof schema !== "string" || !DEV_SCHEMA_RULE.test(schema)) {
    throw new Error(
      `Refusing: development schema must look like credit_dev or credit_test_<name> (got "${String(schema)}").`,
    );
  }
  return schema;
}

/** Same address with the pooled prefix removed, so sessions end with the connection. */
export function toDirectUrl(rawUrl) {
  const url = new URL(rawUrl);
  url.hostname = url.hostname.replace(/^pooled[.]/i, "");
  // pg already verifies the certificate for these modes; say so explicitly so a future pg default cannot weaken it.
  const mode = url.searchParams.get("sslmode");
  if (mode === "require" || mode === "prefer" || mode === "verify-ca") url.searchParams.set("sslmode", "verify-full");
  return url;
}

/** Address with no schema pinned. Used only to create or drop the schema itself. */
export function plainUrl(rawUrl) {
  const url = toDirectUrl(rawUrl);
  url.searchParams.delete("schema");
  return url.toString();
}

/** Address pinned to one development schema. This is what DATABASE_URL gets set to. */
export function devUrl(rawUrl, schema) {
  assertDevSchema(schema);
  const url = toDirectUrl(rawUrl);
  url.searchParams.set("schema", schema);
  return url.toString();
}
