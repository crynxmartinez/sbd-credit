# Credit Tracker — Steel Building Depot

Tracks credit applications, approvals, credit limits, balances and payment reminders, for staff, and gives each customer a
page of their own (sign in on the same page with their email) showing what they can buy on credit, what is due and their
history. Staff invite customers from the customer screen. See `docs/PORTAL_PLAN.md`. A rebuild of the original
single-file artifact (kept in `legacy/` as the design reference) with the same look and the same core idea, on a real
database.

## What changed from the artifact

| Before | Now |
| --- | --- |
| One stored balance, overwritten on every payment | A **ledger**: charges, payments, adjustments, write-offs, reversals. Balance is always computed, so two people recording payments at once cannot lose one |
| Whole dollars, floating-point math | **Integer cents** everywhere |
| One hand-typed "next payment due" | Due dates per charge from the payment terms, payments applied oldest-first, **aging buckets** |
| History array rewritten each time | **Append-only audit trail** with field-level before/after, written in the same transaction as the change |
| Anyone could approve and edit anything | Roles: employees record activity; admins approve, deny, suspend, void, reverse, write off and change credit terms |
| "Today" = UTC date (wrong in the US evening) | Local calendar dates throughout |
| Data lived only in the artifact | Postgres, CSV export, JSON backup |

## Running it

```bash
npm install
npm run dev-db -- create     # once: make the credit_dev schema
npm run db:migrate           # apply migrations
npm run seed                 # dev sign-in + 8 fictional customers
npm run dev                  # http://localhost:3200
```

`npm run dev` always runs against `credit_dev`. It cannot reach the live tables: `scripts/lib/dev-db-url.mjs` and
`src/lib/server/db-url.ts` refuse any schema that is not `credit_dev` / `credit_test*` outside production, and refuse a
schema on the pooled address.

Local sign-in settings live in `.env.local` (git-ignored). With `CREDIT_DEV_AUTOLOGIN=1` the dev server skips the sign-in
screen; remove that line to test the real login page. Database credentials come from `.env.databases`. Neither file is
ever committed. See `.env.example` for the names.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server on port 3200 |
| `npm test` | Unit tests (domain logic, validation, auth, guards) |
| `npm run test:db` | Integration tests against a fresh `credit_test` schema (concurrency, permissions, audit) |
| `npm run typecheck` / `npm run lint` | Static checks |
| `npm run dev-db -- status\|create\|reset\|drop` | Manage the dev schema |
| `npm run seed` | Dev sign-in and demo data (`seed:admin`, `seed:demo` separately) |
| `npm run e2e` | Browser tests (Edge) against a throwaway `credit_test_e2e` schema, with fresh sign-ins each run |
| `npm run backup` / `npm run restore -- <file>` | Consistent JSON snapshot (no password hashes) and restore into an empty schema |
| `npm run user -- list\|create\|reset-password\|deactivate\|activate` | Manage sign-in accounts |

## Layout

```
src/lib/domain/     Pure business rules: money, dates, ledger + aging, alerts, status, roles. No database, fully tested
src/lib/server/     Database client, auth (sessions, lockout), HTTP helpers, services (customers, ledger, audit)
src/app/api/        Route handlers: thin, validate then call a service
src/components/     The interface (design tokens ported from the original in src/app/legacy-tokens.css)
prisma/             Schema and migrations
scripts/            Dev-database tooling, seed, backup
legacy/             The original artifact, for reference
```

## Guarantees worth knowing

- **The database enforces the ledger rules, not just the app.** CHECK constraints reject bad statuses, non-positive
  charges and payments, and half-filled voids. Triggers make `LedgerEntry` and `AuditEvent` append-only: an entry can be
  voided once and nothing else about it can change, and audit rows cannot be edited or deleted by anything.
- **Closed months are never rewritten.** A mistake in the current month can be voided. Anything from an earlier month is
  corrected with a **reversal**: a new opposite entry dated today, linked to the original, which stays in the history. An
  entry can be reversed once, and a reversed entry cannot also be voided. A **write-off** gives up on a balance that will
  not be collected: admin-only, needs a reason, cannot exceed what was owed on its date, and is reported separately
  (customer screen, dashboard, CSV) instead of vanishing into "adjustments".
- **Money writes lock the customer row**, so a charge racing a suspension, or two charges racing the credit limit, are
  decided one at a time and the warnings are accurate.
- **"Today" is the business day.** Overdue and aging use the viewer's local date; if it is missing or implausible the
  server falls back to `BUSINESS_TIME_ZONE` (default `America/Chicago`), never the UTC day.
- **Sign-in:** one error message for every failure (wrong password, unknown user, locked account), atomic lockout after 5
  failures, a per-address rate limit, and signing out invalidates the session everywhere.
- **The dev server listens on 127.0.0.1 only**, because auto-login would otherwise hand a SUPER ADMIN session to anyone
  on the same network.

## Before this goes live

The full runbook, with the database roles, deploy order, backups and rollback, is in [docs/PRODUCTION.md](docs/PRODUCTION.md).

- Create the production `credit` schema and apply migrations with the direct address.
- Set `SESSION_SECRET` (32+ characters) and real users; `CREDIT_DEV_AUTOLOGIN` is ignored outside development.
- Add a Content-Security-Policy. It needs a nonce (the theme script is inline), so it is a small proxy file, not just a
  header, and is the one defence-in-depth item still open.
- Decide on sign-in. This app has its own accounts (`npm run user`). Reusing the shipper app's workers is a separate
  piece of work, NOT a matter of sharing a cookie: the cookie names and payload keys differ (`credit_session` / `u` here,
  `sm_session` / `w` there), the shipper forces password changes, and signing out here ends the user's sessions
  everywhere. The recommended path is one identity with separate sessions: sign in against the shipper's `Worker` table
  through a read-only view, keep this app's own cookie, and grant credit access explicitly.
