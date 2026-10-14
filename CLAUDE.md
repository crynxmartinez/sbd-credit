# Credit Tracker — Steel Building Depot

Credit applications, approvals, credit limits, balances and payment reminders for Steel Building Depot customers.
Rebuild of a single-file artifact (`legacy/credit-tracker-artifact.html`, kept as the design and behavior reference).
Own app, same Postgres database server as the Storage Materials shipper app.

## Stack
- Next.js 16.3 (App Router), React 19.2, TypeScript 5, Prisma 7 with `@prisma/adapter-pg`, zod 4, Vitest.
- Plain CSS carrying over the legacy design tokens. No Tailwind, so the look matches the original.
- Read `node_modules/next/dist/docs/` before writing Next code: this version has breaking changes.

## Database rules (hard)
- Local work runs ONLY in the `credit_dev` schema (or `credit_test_*`) on the DIRECT address.
- `npm run dev` and `npm run with-dev-db -- <cmd>` pin `DATABASE_URL` for you. Never export the live address.
- `scripts/lib/dev-db-url.mjs` refuses any schema that is not `credit_dev` / `credit_test*`. Do not weaken it.
- `.env.databases` holds live credentials. Never print, paste, log or commit its values.
- Never run Prisma against `public`. The live shipper tables live there.

## Commands
- `npm run dev-db -- status|create|reset|drop` — manage the dev schema
- `npm run dev` — dev server on http://localhost:3200 (against `credit_dev`)
- `npm run test` / `npm run test:db` / `npm run typecheck` / `npm run lint`
- `npm run db:migrate` — apply migrations to `credit_dev`; `npm run seed` — dev sign-in + demo customers
- `npm run backup` / `npm run restore -- <file>` — JSON snapshot (no password hashes) / restore into an EMPTY schema
- `npm run user -- list|create|reset-password|deactivate|activate` — sign-in accounts
- `npm run e2e` — Playwright (Edge) against `credit_test_e2e`; run it after any UI or auth change
- Production runbook: `docs/PRODUCTION.md`
- Customer portal: Phase 1 built; plan and what is next in `docs/PORTAL_PLAN.md`
- `npm run test:db -- <name>` runs only the integration test files whose name contains it (e.g. `portal`)

## Layout
- `src/lib/domain/` pure rules (no database, no clock): money, dates, ledger + aging, alerts, status, roles
- `src/lib/server/` db client, auth, http helpers, services. Route handlers in `src/app/api/` stay thin: validate, then call a service
- `src/components/` UI; design tokens live in `src/app/legacy-tokens.css` (ported from the original, keep the look)
- Write the test first for anything in `domain/`; run `npm run test:db` after touching services

## Domain rules
- Money is integer cents everywhere. Never floats. Display a broken amount as a dash, never "$0".
- Every write goes through `transaction()` in `src/lib/server/tx.ts` (lock and statement timeouts, "busy" mapping) and
  carries a request key, so a retried request is recorded once.
- "Today" is the business day (`BUSINESS_TIME_ZONE`), decided by the server and returned with the data. The browser never sends a date for this.
- Balance is never stored: it is the sum of ledger entries. Ledger and audit rows are append-only; mistakes are voided, not edited.
- Ledger types: CHARGE adds; PAYMENT and WRITE_OFF reduce; ADJUSTMENT and REVERSAL are signed. `effectOnBalance()` in `domain/ledger.ts` is the one place that knows the sign. The SQL in `services/ledger.ts` mirrors it, so change both together.
- A void is only for the current business month. Older entries are corrected by a reversal dated today (`reverseEntry`). A reversal is never posted directly, never reversed, and never voided; a reversed entry is never voided.
- A write-off and a reversal always carry a reason (also a CHECK constraint). Write-offs and reversals are ADMIN actions.
- Customer portal: customers are `CustomerUser`, a separate table and cookie from staff (`AppUser`). The two never share a role column, and `src/lib/portal-boundaries.test.ts` fails if portal code reaches staff services or the reverse.
- What a customer may see is whitelisted in `domain/portal.ts` (`toPortalView`), field by field. Never pass a customer-facing page a staff object. A customer is never locked out by wrong passwords (their email is guessable); see `auth/lockout.ts`.
- Invitation links are built from `PUBLIC_BASE_URL` (never the request Host) with the token in the URL fragment. Only the token's hash is stored. Accepting and re-sending lock the contact row, so they are race-safe.
- Dates are local calendar dates (`YYYY-MM-DD`), never `toISOString().slice(0, 10)`.
- Roles follow the shipper app: EMPLOYEE | ADMIN | SUPERADMIN. Approve, deny, suspend and limit changes need ADMIN or above.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
