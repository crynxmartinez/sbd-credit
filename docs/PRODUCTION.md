# Going to production

What has to be true, in order, before real customer money goes through this app. Items marked **Owner** need a person
with access to the database server or hosting account; the app cannot do them for itself.

Commands below use a Linux shell. `<owner-url>` is the address for the `credit_owner` role and `<app-url>` the one for
`credit_app` (see section 2); both are the **direct** database address ending `?schema=credit&sslmode=require`.

## 1. Decisions only the business can make

| Decision | Why it matters |
| --- | --- |
| **Which system is the record of what customers owe: this app or the accounting software?** | Entering the same charges and payments by hand in two places always drifts, and customers now see this app's figures. Pick one as the source and treat the other as a mirror. |
| **Who may see customer credit?** | Access is granted by creating an account (`npm run user -- create`). A warehouse worker who can use the shipper app should not automatically see credit. |
| **Time zone of the books** | `BUSINESS_TIME_ZONE` (default `America/Chicago`) decides what "today" means for overdue and aging. |

**Policy defaults.** These are decisions the code had to make for you. Each is one named setting or one function; change the
default if it does not match how you run credit.

| Rule | Default | Where |
| --- | --- | --- |
| A void is only for entries in the current month; older entries are corrected by a **reversal** dated today, so figures already reported never change. On the 1st, last month is already closed. | Current month | `isInClosedMonth`, `assertVoidable` (`services/ledger.ts`) |
| Who may post an entry into a closed month | Admins only | `ledger.backdate` in `domain/roles.ts` |
| How far ahead an entry may be dated | 90 days | `MAX_POSTDATE_DAYS` in `domain/constants.ts` |
| A write-off | Gives up on the debt: the balance falls and it stops showing as past due. It cannot exceed what is owed on its date AND today, and it cannot be undone by voiding or reversing the charge it covers (reverse the write-off first). The customer sees it as "Credit applied". | `assertWritableOff`, `assertNoWriteOffDependsOn` |
| Available credit | Limit minus balance, never below $0 and never above the limit | `domain/summary.ts` |
| A payment pays the **oldest due** invoice first (balance-forward). There is no way to apply a payment to a specific invoice. | Oldest due first | `settle` in `domain/ledger.ts` |
| An approved account's credit limit | Must be above $0. To stop credit, suspend the account | `updateCustomer` |

## 2. Database (Owner)

The app runs in its own Postgres schema, `credit`, on the shared server. Do these once, as an administrator.

**Use two database roles, not one.** The append-only guarantee (ledger and audit rows can never be edited or erased)
is enforced by triggers, but a role that OWNS the tables can switch triggers off or drop them. So the running app connects
as a role that owns nothing.

**Step A, before the first migration** (as an administrator):

```sql
CREATE ROLE credit_owner LOGIN PASSWORD '<generated>';   -- runs migrations and the account tool; never used by the running app
CREATE ROLE credit_app   LOGIN PASSWORD '<generated>';   -- what the running app connects as
CREATE SCHEMA credit AUTHORIZATION credit_owner;
GRANT USAGE ON SCHEMA credit TO credit_app;
ALTER ROLE credit_app SET search_path = credit;
```

**Step B: migrate** as `credit_owner` (section 4). This creates every table.

**Step C, AFTER the migration** (as `credit_owner` or an administrator). Granting on tables that do not exist yet silently
does nothing, so this must come after Step B, and be repeated after any migration that adds a table (the default privileges
below cover that automatically):

```sql
-- The app reads, adds, and updates. It never deletes, truncates or triggers.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA credit TO credit_app;
-- Append-only: no updates to the audit log, and no access to the migration history.
REVOKE UPDATE ON credit."AuditEvent" FROM credit_app;
REVOKE ALL ON credit."_prisma_migrations" FROM credit_app;
-- Staff accounts: the running app only counts failures, ends sessions and records locks. It cannot change a role,
-- a password or whether an account is active (the account tool, run as credit_owner, does that).
REVOKE INSERT, UPDATE ON credit."AppUser" FROM credit_app;
GRANT UPDATE ("failedLogins", "lockedUntil", "sessionVersion", "updatedAt") ON credit."AppUser" TO credit_app;
-- Tables created by future migrations:
ALTER DEFAULT PRIVILEGES FOR ROLE credit_owner IN SCHEMA credit GRANT SELECT, INSERT, UPDATE ON TABLES TO credit_app;
```

(A future table's default `UPDATE` is wider than ideal; tighten it with a `REVOKE` as part of the migration that adds it, as
for `AuditEvent` above.)

**Step D, check it** (connect as `credit_app`; each of these must behave as stated):

```sql
SELECT count(*) FROM "Customer";                       -- works
SELECT count(*) FROM "CustomerUser";                   -- works (a missing grant here makes EVERY sign-in fail)
DELETE FROM "LedgerEntry";                             -- permission denied
TRUNCATE "AuditEvent";                                 -- permission denied
UPDATE "AuditEvent" SET actor = 'x';                   -- permission denied
UPDATE "AppUser" SET role = 'SUPERADMIN';              -- permission denied
SELECT * FROM public."<one of the shipper app's tables>";  -- permission denied. If this WORKS, the shipper tables are open
                                                       -- to PUBLIC: revoke that for credit_app (REVOKE ALL ... FROM PUBLIC
                                                       -- is not enough on its own; grant the shipper role explicitly instead).
```

Then do the real smoke test with the app pointed at `<app-url>`: sign in, sign out, enter a wrong password (it must be counted,
not crash), record and void a payment. Any "permission denied" in the app log means a grant is missing.

**Connections.** Up to 10 per app instance, shared with the shipper app's budget in `max_connections`. Prisma Migrate takes
a database-wide advisory lock, so do not run it while the shipper app is migrating. The app sets `keepAlive` (10 s) and
`idle_in_transaction_session_timeout=30s`, so a firewall that drops idle connections is noticed and a crashed process cannot
hold a customer locked for long.

**Encryption.** The app refuses to start in production unless `DATABASE_URL` contains `sslmode=require` (or `verify-ca` /
`verify-full`).

**On the developer machine.** `.env.databases` holds the live server credential, and the guards that keep local work inside
`credit_dev` are in code. Anything that runs locally (a package's install script, a test runner) could read that file.
Create a separate database role for development that can only use `credit_dev*` and `credit_test*` schemas and has no access
to `public`, put THAT role's address in `.env.databases`, and keep the live credential only on the host. Rotate the live
credential if it has ever been pasted into a chat, ticket or log.

## 3. Configuration

Set these on the host. The app refuses to start, and says exactly which is wrong, if any is missing or unsafe.

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Direct address, as `credit_app`, ending `?schema=credit&sslmode=require` |
| `SESSION_SECRET` | 32+ random characters, unique to this app |
| `PUBLIC_BASE_URL` | The address customers use, `https://...`. Invitation links and the same-origin check use it, never the request's `Host` header, which a caller can influence. |
| `BUSINESS_TIME_ZONE` | e.g. `America/Chicago` (an empty value is refused) |
| `TRUSTED_PROXY_HOPS` | How many proxies sit in front of the app, 0 to 5 (REQUIRED in production, usually 1; anything else is refused). The proxy MUST set `X-Forwarded-For`: without it every visitor shares one rate-limit bucket, and 20 wrong attempts would block sign-in for everyone. |
| `NODE_ENV` | `production` |

`CREDIT_DEV_AUTOLOGIN`, `LOGIN_ATTEMPTS_PER_ADDRESS`, `LOGIN_ATTEMPTS_PER_ACCOUNT` and `ACCEPT_ATTEMPTS_PER_ADDRESS` must **not**
be set in production: they exist for the automated tests, and the app refuses to start if they are present.

**Sessions.** Staff sessions last 12 hours and customer sessions 4, from sign-in, and are not extended while working. Each
kind is signed with its own key derived from `SESSION_SECRET`. **Rotating `SESSION_SECRET` signs everyone out** (staff and
customers) and invalidates nothing else: change it, restart, and people sign in again. Do this if the secret may have leaked.
Deploying the customer portal for the first time also signed every staff member out once, for the same reason.

**After deploying**, check the pages that must not be cached: `curl -sI https://<your-address>/portal`, `/login` and
`/accept-invite` must show `Cache-Control: no-store, max-age=0` and `X-Robots-Tag: noindex`, and `/accept-invite` must also
show `Referrer-Policy: no-referrer`.

## 4. Install and deploy

**Node 22 or newer.** Install in full (`npm ci`, which includes the dev dependencies): the migration tool (`prisma`), the
account tool (`tsx`) and `dotenv` are dev dependencies **on purpose**. Moving them to runtime dependencies would put their
advisories in the production audit, and they are not code the running app executes. After migrating you may run
`npm prune --omit=dev` and start the app from the pruned install.

1. **Back up first.** A database-level dump (the real recovery path; it also holds password hashes, so treat it as a secret).
   `pg_dump` does not understand `?schema=`, so give it a plain connection URI:

   ```bash
   pg_dump -Fc -n credit "postgres://credit_owner:<password>@<host>:5432/postgres?sslmode=require" > credit-before-deploy.dump
   ```

2. **Migrate** as `credit_owner`. Migrations run as one transaction per file, so a failed one leaves nothing half-applied.

   ```bash
   NODE_ENV=production DATABASE_URL="<owner-url>" npx prisma migrate deploy
   ```

3. **Grants** (section 2, Step C) after the FIRST migration, and whenever a migration adds a table.
4. **Start the app** as `credit_app`. Startup checks the configuration and fails loudly if it is wrong.
5. **Check** `GET /api/health` returns `{"status":"ok"}`, then sign in and open the dashboard.
6. **Create the first accounts**, as `credit_owner` (the app role cannot create accounts):

   ```bash
   NODE_ENV=production DATABASE_URL="<owner-url>" npx tsx scripts/users.ts create <username> "<Name>" SUPERADMIN
   ```

   A strong one-time password is generated and shown once, unless `NEW_USER_PASSWORD` is set. `list`, `reset-password`,
   `deactivate`, `activate` and `unlock` work the same way. **`unlock`** is how an administrator lets someone back in after
   the account was locked by repeated wrong passwords (anyone who knows a username can lock it for 15 minutes).

**Customers.** On an approved customer, an admin chooses "Add a person", copies the one-time link and sends it. The link works
once, lasts 7 days (a reset link 2), and is shown only once. If it is lost, "New link" makes another and cancels the old one.

## 5. Backups

There are two kinds, and they hold different things.

| | Holds | Does NOT hold | Use it for |
| --- | --- | --- | --- |
| **`pg_dump -Fc -n credit`** | Everything, including password hashes and invitation records | | Disaster recovery. Treat as a secret. |
| **`backup.ts`** (JSON) | Customers, ledger, audit, customer contacts, sign-in account list | Any password hash or invitation link | A portable, inspectable copy; restoring into a fresh schema |

- **Nightly** `pg_dump` to storage the app cannot reach, plus the host's point-in-time recovery if it offers it. Suggested
  retention: 14 daily and 12 monthly copies.
- **Encrypt and move off the host.** Both kinds hold customer names, contacts and balances. Encrypt them (for example
  `gpg --symmetric`, or the storage provider's encryption with its own key), store them off the app host with access limited
  to the people who hold the owner credentials, and delete the local copy once uploaded.
- **JSON backup of production**, as `credit_app` (it only reads):

  ```bash
  NODE_ENV=production DATABASE_URL="<app-url>" npx tsx scripts/backup.ts
  ```

  It writes `backups/credit-credit-<time>.json` (git-ignored). The `npm run backup` / `npm run restore` shortcuts are for
  the development schema only: they pin `credit_dev` and would silently back up the wrong data.
- **JSON restore** goes into an EMPTY schema, as `credit_owner`:

  ```bash
  NODE_ENV=production DATABASE_URL="<owner-url-for-the-scratch-schema>" npx tsx scripts/restore.ts <file>
  ```

  Sign-in accounts come back with their original ids but **without passwords** (set each with `reset-password`), and customer
  contacts come back "invited" (send each a new link).
- **Restore drill.** A backup nobody has restored is a hope. `npm run restore-drill` (development and test schemas only) backs
  up a schema, restores it into a scratch schema, backs that up again and compares every row. It runs in CI on every change.
  For production, restore a `pg_dump` into a scratch **database** at least once before launch and then on a schedule
  (quarterly), check the customer count and a few balances against the live app, and write the date and result below.

  | Date | What was restored | Result |
  | --- | --- | --- |
  | 2026-10-14 | JSON backup of a test schema (14 customers, 20 ledger entries including a void, two reversals and a write-off, 53 audit events, 4 customer contacts) | Identical, including every balance |
  | _first production drill_ | _pg_dump into a scratch database_ | _to be recorded_ |

## 6. If a migration or release goes wrong

- **A migration failed part-way**: nothing is applied (each file is one transaction). Fix the cause, then
  `npx prisma migrate resolve --rolled-back <migration_name>` and deploy again.
- **A migration applied but the release is bad**: there are no automatic "down" migrations. Restore from the pre-deploy
  dump into a scratch schema, compare, and copy back what is needed; or roll the app back to the previous version, which
  works with the new schema as long as the migration only added things.
  **Exception:** once any write-off or reversal has been recorded (migration `20261015090000_writeoff_reversal`), do not roll the
  app back to a version older than that migration. It does not know those entry types and would add them to balances with
  the wrong sign.
- **Migrations that rewrite tables.** `20261014090000_hardening` converts timestamp columns on four tables, which locks them
  for the duration. It is instant on small tables; on a large `AuditEvent` run it in a quiet window.
- **Sessions**: to sign everyone out immediately, rotate `SESSION_SECRET` (section 3). To sign out one person,
  `npm run user -- reset-password <username>`, or turn off a customer contact's access on the customer screen. In SQL, bump
  `sessionVersion` on `AppUser` and `CustomerUser`.

## 7. Watching it

The app writes one JSON object per line to its log. Passwords, tokens and connection strings are redacted before anything
is written; the name typed into the sign-in box is never logged. Every error shows the user a short reference that finds the line.

| Event | Level | Meaning |
| --- | --- | --- |
| `startup.ok` / `startup.invalid_environment` | info / error | The configuration was accepted, or the list of what is wrong |
| `startup.database_not_ready` | warn | The first database connection failed at startup (the health check reports it) |
| `auth.login_ok` / `auth.login_failed` | info / warn | A sign-in. A failure carries the **reason** (`bad_password`, `unknown`, `inactive`, `not_invited`, `locked`, `ambiguous`), the account kind and the address. The person is never told which. |
| `auth.locked` | warn | A staff account was locked by repeated wrong passwords (use `unlock` if it was not them) |
| `portal.many_failed_logins` | warn | A customer account has had a multiple of 30 failures. Customers are never locked, so this is how a guessing run is noticed |
| `api.refused` | warn | A 403, 429 or 503 was returned (a blocked origin usually means a proxy misconfiguration; many 429s mean a guessing run) |
| `tx.connection_problem` / `api.database_unreachable` | warn | A write or read could not complete because of the connection (`outcome`: `not_saved` or `unknown_outcome`) |
| `api.unhandled_error` / `request.unhandled_error` | error | A bug. Each has a reference |
| `health.database_unreachable` | error | The health check could not reach the database |
| `auth.logout_revoke_failed` / `auth.customer_logout_revoke_failed` | error | A sign-out could not be saved; the person was told to try again |
| `export.downloaded` | info | Who downloaded a CSV of customer data, and which |

- Point an uptime monitor at `/api/health` (503 if the database is unreachable). It is public, queries the database, and is not
  rate-limited by the app: rate-limit it at the proxy.
- Alert on any `"level":"error"` line, on bursts of `auth.login_failed`, and on `auth.locked`.
- Also watch Postgres `max_connections` headroom (shared with the shipper app) and disk.
- Error-reporting services (Sentry and similar) are a deliberate choice, not a default: they receive stack traces from
  a system that handles customer financial data. If you add one, send only the error reference and stack, never request
  bodies, and put the hook in `src/instrumentation.ts` (`onRequestError`).

**Incidents.**
- *Database down*: people see "can't reach its database" (reads) or "busy / interrupted" (writes). Nothing is lost. A write
  that says "may or may not have been saved" should be checked in the customer's record before it is entered again.
- *An admin is locked out*: `scripts/users.ts unlock <username>` as `credit_owner`.
- *A customer lost their invitation link*: "New link" on that person. It cancels the old one.
- *Suspected leaked session secret or stolen session*: rotate `SESSION_SECRET`; for a stolen customer session, turn that
  contact's access off and on.
- *A customer's account is being guessed*: it is not locked (so nobody can lock a customer out on purpose). Look at
  `auth.login_failed` for the address, block it at the proxy, and reset the contact with "New link".

## 8. Privacy and retention

The system holds customer business details, contact names, email addresses and phone numbers, balances, and a record of who
did what. Decide and write down: how long closed accounts are kept, who may see them, and who holds the `credit_owner` password.

- Ledger and audit rows are append-only by design (that is what makes the history trustworthy), so a request to erase a person
  cannot be met by deleting rows. The workable answer is to **deactivate** a customer contact (turn their access off) and, for a
  genuine erasure request, have the owner role replace the contact's name and email with a placeholder. Decide that procedure
  with whoever handles such requests before the first one arrives.
- Reads of customer data are not audited, but CSV exports are logged (`export.downloaded`). Add view logging if you need to
  answer "who looked at this customer".
- Backups contain the same data (section 5): the same retention and access rules apply to them.

## 9. Known limits and what to do about them

- **Rate limits are per server process.** With several instances each has its own count. Customers are never locked by wrong
  passwords (their sign-in name is their email, so any lock would let a stranger lock them out); staff accounts are locked for
  15 minutes after 5 wrong passwords, which also means anyone who knows a username can do the same, hence `unlock`.
- **The customer list is computed in memory on each request, and every open tab asks every 30 seconds.** Comfortable below
  roughly 1,000 customers or 10,000 ledger entries. Beyond that, in order: (1) send an `ETag` and answer "unchanged" without
  recomputing (needs a per-customer revision counter, not `max(updatedAt)`, which can miss a late-committing transaction);
  (2) read only the columns the list uses; (3) compute balances in SQL (`GROUP BY` customer), keeping the aging rules in Node.
- **A save takes about eight database round trips** (about 0.8 s over a link with 100 ms latency), holding that customer's row
  for most of it. Putting the app and database in the same region is the biggest single improvement; folding the lock,
  duplicate check and balance into one statement is the next.
- **Password hashing is pure JavaScript** (about 0.6 s per sign-in, one at a time on the main thread). The app caps concurrent
  hashes at 4 and refuses extras, so a flood cannot stall other requests. Switch to a native hash only if sustained sign-ins
  exceed about one every two seconds, for example after inviting hundreds of customers at once.
- **Staff cannot change their own password**, and neither can customers; an administrator resets it (`reset-password`, or "New
  link"). A self-service change and "forgot password" by email need an email service, which does not exist yet.
- **After ANY restore, change `SESSION_SECRET`.** Restored customer sign-ins are ended automatically, but a staff session cookie
  from before the restore (up to 12 hours old) would still be accepted for any staff account that did not sign out. A new
  secret signs everyone out, which is what you want after an incident. Do not skip it.
- **Pressing the browser Back button closes the customer panel without asking**, even with a half-typed form or a just-issued
  invitation link on screen (the Close button and Escape do ask). The link can be re-issued with "New link".
- **A write-off is matched to charges by date, not by which charge it was "for".** Several entries on the same day have no
  order, so a write-off and a charge dated the same day cannot be told apart. The void and reverse checks (a charge a write-off
  covers cannot be voided until the write-off is reversed) work on dates and today's balance.
