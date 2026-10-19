-- Hardening found by the audit of 2026-10-19. Nothing here changes what the application does; it makes the database refuse more.

-- 1. A ledger entry may be voided once and nothing else about it may ever change. The earlier version listed the frozen columns one by
--    one, so a column added in a later migration was changeable until somebody remembered to add it to the list. This compares the
--    WHOLE row except the four void columns, so a new column is frozen by default.
CREATE OR REPLACE FUNCTION credit_ledger_void_only() RETURNS trigger AS $$
BEGIN
  IF OLD."voidedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'a voided ledger entry cannot be changed' USING ERRCODE = 'CR001';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['voidedAt', 'voidedBy', 'voidedById', 'voidReason'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['voidedAt', 'voidedBy', 'voidedById', 'voidReason']) THEN
    RAISE EXCEPTION 'ledger entries are append-only: only voiding is allowed' USING ERRCODE = 'CR001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. Rules the application relies on, now held by the database too.
--    Staff sign-in names never contain "@": that is what keeps a staff name from ever equalling a customer's email.
ALTER TABLE "AppUser" ADD CONSTRAINT "AppUser_username_format" CHECK ("username" ~ '^[a-z0-9][a-z0-9._-]{2,31}$');
--    A session version is a counter that only goes up from 1.
ALTER TABLE "AppUser" ADD CONSTRAINT "AppUser_sessionVersion_positive" CHECK ("sessionVersion" >= 1);
ALTER TABLE "CustomerUser" ADD CONSTRAINT "CustomerUser_sessionVersion_positive" CHECK ("sessionVersion" >= 1);
--    Payment terms drive every due date: an unknown value used to fall back to Net 30 without a word.
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_paymentTerms_known"
  CHECK ("paymentTerms" IN ('Net 15', 'Net 30', 'Net 45', 'Net 60', 'Net 90', 'Due on receipt', 'COD'));

-- 3. The history of one ledger entry is looked up by this column.
CREATE INDEX "AuditEvent_ledgerEntryId_idx" ON "AuditEvent"("ledgerEntryId");

-- 4. The trigger functions read tables by name. Left alone they resolve those names through whatever search_path the CONNECTION has;
--    pinned, they can only ever see this schema (and the system catalog), whoever connects and however they are configured.
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'credit_forbid_change()',
    'credit_ledger_void_only()',
    'credit_check_allocation_row()',
    'credit_check_write_off_total()',
    'credit_backfill_write_off_allocations()'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = %I, pg_catalog', fn, current_schema());
  END LOOP;
END
$$;

-- 5. What an administrator did to sign-in accounts from the command line (create, reset, deactivate, unlock, end all sessions, erase a
--    contact). Audit events belong to a customer; these do not, so they had nowhere to go and were only printed on a terminal.
--    Append-only like everything else that is a record.
CREATE TABLE "AccountEvent" (
    "id"             TEXT NOT NULL,
    "actor"          TEXT NOT NULL,
    "action"         TEXT NOT NULL,
    "targetUsername" TEXT,
    "details"        JSONB,
    "createdAt"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AccountEvent_createdAt_idx" ON "AccountEvent"("createdAt");

CREATE TRIGGER "AccountEvent_append_only"
    BEFORE UPDATE OR DELETE ON "AccountEvent"
    FOR EACH ROW EXECUTE FUNCTION credit_forbid_change();
CREATE TRIGGER "AccountEvent_no_truncate"
    BEFORE TRUNCATE ON "AccountEvent"
    FOR EACH STATEMENT EXECUTE FUNCTION credit_forbid_change();
