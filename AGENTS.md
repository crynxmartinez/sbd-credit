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
- `npm run backup` — JSON backup of customers, ledger and audit (no password hashes)

## Layout
- `src/lib/domain/` pure rules (no database, no clock): money, dates, ledger + aging, alerts, status, roles
- `src/lib/server/` db client, auth, http helpers, services. Route handlers in `src/app/api/` stay thin: validate, then call a service
- `src/components/` UI; design tokens live in `src/app/legacy-tokens.css` (ported from the original, keep the look)
- Write the test first for anything in `domain/`; run `npm run test:db` after touching services

## Domain rules
- Money is integer cents everywhere. Never floats.
- Balance is never stored: it is the sum of ledger entries. Ledger and audit rows are append-only; mistakes are voided, not edited.
- Dates are local calendar dates (`YYYY-MM-DD`), never `toISOString().slice(0, 10)`.
- Roles follow the shipper app: EMPLOYEE | ADMIN | SUPERADMIN. Approve, deny, suspend and limit changes need ADMIN or above.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
