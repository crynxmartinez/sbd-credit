# Going to production

What has to be true, in order, before real customer money goes through this app. Items marked **Owner** need a person
with access to the database server or hosting account; the app cannot do them for itself.

## 1. Decisions only the business can make

| Decision | Why it matters |
| --- | --- |
| **Which system is the record of what customers owe: this app or the accounting software?** | Entering the same charges and payments by hand in two places always drifts. Pick one as the source and treat the other as a mirror. |
| **Who may see customer credit?** | Access is granted by creating an account (`npm run user -- create`). A warehouse worker who can use the shipper app should not automatically see credit. |
| **Is the month-close rule right?** | A void is only allowed for entries in the current calendar month of `BUSINESS_TIME_ZONE`; anything older is corrected with a **reversal** dated today, so figures already reported never change. On the 1st, last month's entries are already closed. If you want a grace period (say, three business days), it is one line in `assertVoidable` in `src/lib/server/services/ledger.ts`. |
| **Time zone of the books** | `BUSINESS_TIME_ZONE` (default `America/Chicago`) decides what "today" means for overdue and aging. |

## 2. Database (Owner)

The app runs in its own Postgres schema, `credit`, on the shared server. Do these once, as an administrator.

**Use two database roles, not one.** The append-only guarantee (ledger and audit rows can never be edited or erased)
is enforced by triggers, but a role that OWNS the tables can switch triggers off or drop them. So:

```sql
-- Run as an administrator. Names are suggestions.
CREATE ROLE credit_owner LOGIN PASSWORD '<generated>';   -- runs migrations only; never used by the running app
CREATE ROLE credit_app   LOGIN PASSWORD '<generated>';   -- what the running app connects as

CREATE SCHEMA credit AUTHORIZATION credit_owner;
GRANT USAGE ON SCHEMA credit TO credit_app;

-- The app may read and add, and update only where the design needs it. Never DELETE, TRUNCATE or TRIGGER.
-- (Run after the first migration has created the tables.)
GRANT SELECT, INSERT, UPDATE ON credit."Customer", credit."AppUser" TO credit_app;
GRANT SELECT, INSERT, UPDATE ON credit."LedgerEntry" TO credit_app;   -- UPDATE: only to void (a trigger enforces that)
GRANT SELECT, INSERT         ON credit."AuditEvent"  TO credit_app;   -- append-only
ALTER DEFAULT PRIVILEGES FOR ROLE credit_owner IN SCHEMA credit GRANT SELECT, INSERT, UPDATE ON TABLES TO credit_app;

-- Keep the two apps out of each other's data.
REVOKE ALL ON SCHEMA public FROM credit_app;
ALTER ROLE credit_app SET search_path = credit;
```

Check afterwards that the app role really cannot do harm: connected as `credit_app`, `DELETE FROM "LedgerEntry"`,
`TRUNCATE "AuditEvent"` and `ALTER TABLE ... DISABLE TRIGGER ALL` must all fail.

**Connections.** The app uses the direct address (never the pooled one) with up to 10 connections per instance. Budget
that against the server's `max_connections`, which the shipper app also uses, and lower the pool size for production if
needed. Prisma Migrate takes a database-wide advisory lock, so do not run it while the shipper app is migrating.

## 3. Configuration

Set these on the host. The app refuses to start, and says exactly which is wrong, if any is missing or unsafe.

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Direct address, as `credit_app`, ending `?schema=credit` |
| `SESSION_SECRET` | 32+ random characters, unique to this app |
| `BUSINESS_TIME_ZONE` | e.g. `America/Chicago` |
| `TRUSTED_PROXY_HOPS` | How many proxies sit in front of the app (default 1). Wrong values let one person dodge the login rate limit. The proxy MUST set `X-Forwarded-For`: without it every visitor shares one rate-limit bucket, and 20 wrong attempts would block sign-in for everyone. |
| `PUBLIC_BASE_URL` | The address customers use, `https://...`. Customer invitation links are built from it, never from the request, so a forged `Host` header cannot send a customer to another site. The app refuses to start without it. |
| `NODE_ENV` | `production` |

**Deploying the customer portal for the first time signs every staff member out once**, because sessions are now signed with
a key derived from `SESSION_SECRET` instead of the secret itself. Nothing is lost; people sign in again.

After deploying, check the customer pages are never cached: `curl -sI https://<your-address>/portal` and `/accept-invite` must
show `Cache-Control: no-store, max-age=0` and `X-Robots-Tag: noindex`, and `/accept-invite` must show `Referrer-Policy: no-referrer`.

`CREDIT_DEV_AUTOLOGIN` must **not** be set. The app also ignores it in production, and refuses to start if it is present.

## 4. Deploy

1. **Back up first**: `pg_dump -Fc -n credit "$DATABASE_URL_OWNER" > credit-before-deploy.dump`.
2. **Migrate** as `credit_owner`, with `NODE_ENV=production` and the `?schema=credit` address: `npx prisma migrate deploy`.
   Migrations run as one transaction per file, so a failed one leaves nothing half-applied.
3. **Start the app.** Startup checks the configuration and fails loudly if it is wrong.
4. **Check** `GET /api/health` returns `{"status":"ok"}`, then sign in and open the dashboard.
5. **Create the first accounts**: `NODE_ENV=production DATABASE_URL=... npx tsx scripts/users.ts create <username> "<Name>" SUPERADMIN`
   (a strong one-time password is generated and shown once, unless `NEW_USER_PASSWORD` is set).

## 5. Backups

- **Nightly**: `pg_dump -Fc -n credit` to storage the app cannot reach, plus the host's point-in-time recovery if it offers it.
  Test a restore from one of these at least once before launch, into an empty scratch database.
- **Portable export**: `npm run backup` writes a consistent JSON snapshot (no password hashes). `npm run restore -- <file>`
  loads it into an EMPTY schema and checks the row counts before committing. It does not restore sign-in accounts;
  recreate them with `npm run user`.

## 6. If a migration or release goes wrong

- **A migration failed part-way**: nothing is applied (each file is one transaction). Fix the cause, then
  `npx prisma migrate resolve --rolled-back <migration_name>` and deploy again.
- **A migration applied but the release is bad**: there are no automatic "down" migrations. Restore from the pre-deploy
  dump into a scratch schema, compare, and copy back what is needed; or roll the app back to the previous version, which
  works with the new schema as long as the migration only added things (all of ours so far did, apart from converting
  timestamps to carry their time zone).
- **Sessions**: to sign everyone out immediately, `npm run user -- reset-password <username>` for an account, or bump
  `sessionVersion` for all users in SQL.

## 7. Watching it

- The app writes one JSON object per line to its log: `startup.ok`, `api.unhandled_error`, `request.unhandled_error`,
  `health.database_unreachable`, `auth.logout_revoke_failed`. Each error shows the user a short reference that finds
  the line. Passwords, tokens and connection strings are redacted before anything is written.
- Point an uptime monitor at `/api/health` (it returns 503 if the database cannot be reached) and alert on any
  `level":"error"` line.
- Error-reporting services (Sentry and similar) are a deliberate choice, not a default: they receive stack traces from
  a system that handles customer financial data. If you add one, send only the error reference and stack, never request
  bodies, and put the hook in `src/instrumentation.ts` (`onRequestError`).

## 8. Known limits

- The login rate limiter and the lockout are per server process. With several instances the rate limit is per instance
  (the account lockout is shared, because it lives in the database).
- The customer list is computed in memory on each request. That is comfortable to a few thousand ledger entries; beyond
  roughly 10,000, compute the totals in SQL (`GROUP BY` customer) instead of loading rows.
- A signed-in session lasts 12 hours from sign-in and is not extended while working.
