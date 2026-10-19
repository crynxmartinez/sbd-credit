-- Step C of docs/PRODUCTION.md: what the running app's database login (credit_app) may do. One copy, used by the runbook AND by CI
-- (the "grants" job applies it to a throwaway server and then checks, as credit_app, that every promise below holds).
--
--   psql "<owner-or-admin-url>" -v ON_ERROR_STOP=1 -f scripts/grants.sql
--
-- Run it AFTER the migrations (granting on tables that do not exist yet silently does nothing) and again after any migration that
-- adds a table. Safe to repeat.

-- The app reads, adds, and updates. It never deletes, truncates or triggers.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA credit TO credit_app;
-- Append-only: no updates to the audit log, and no access to the migration history.
REVOKE UPDATE ON credit."AuditEvent" FROM credit_app;
-- Write-off allocations are append-only too (a trigger refuses changes anyway; this is the second lock).
REVOKE UPDATE ON credit."WriteOffAllocation" FROM credit_app;
-- Only the owner (migrations, restore) runs the one-off allocation function; the running app never needs it.
REVOKE EXECUTE ON FUNCTION credit.credit_backfill_write_off_allocations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION credit.credit_backfill_write_off_allocations() TO credit_owner;
REVOKE ALL ON credit."_prisma_migrations" FROM credit_app;
-- What an administrator did to sign-in accounts is written by the account tool (as credit_owner); the running app never touches it.
REVOKE ALL ON credit."AccountEvent" FROM credit_app;
-- Staff accounts: the running app only counts failures, ends sessions and records locks. It cannot change a role,
-- a password or whether an account is active (the account tool, run as credit_owner, does that).
REVOKE INSERT, UPDATE ON credit."AppUser" FROM credit_app;
GRANT UPDATE ("failedLogins", "lockedUntil", "sessionVersion", "updatedAt") ON credit."AppUser" TO credit_app;
-- Tables created by future migrations:
ALTER DEFAULT PRIVILEGES FOR ROLE credit_owner IN SCHEMA credit GRANT SELECT, INSERT, UPDATE ON TABLES TO credit_app;
