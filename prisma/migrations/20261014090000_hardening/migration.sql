-- Hardening: time zones, idempotency, attribution, stronger append-only rules ---------------------------------------------

DROP INDEX "Customer_status_idx";

-- Timestamps carry their zone. Every existing value was written by the app in UTC, so say so explicitly instead of
-- letting the converting session's TimeZone setting decide.
ALTER TABLE "AppUser"
  ALTER COLUMN "lockedUntil" SET DATA TYPE TIMESTAMPTZ(3) USING "lockedUntil" AT TIME ZONE 'UTC',
  ALTER COLUMN "createdAt"   SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt"   AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt"   SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt"   AT TIME ZONE 'UTC';

ALTER TABLE "AuditEvent"
  ADD COLUMN "ledgerEntryId" TEXT,
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE "Customer"
  ADD COLUMN "requestKey" TEXT,
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMPTZ(3) USING "updatedAt" AT TIME ZONE 'UTC',
  -- The app always supplies this date; a default would be computed in the session's time zone.
  ALTER COLUMN "statusChangedOn" DROP DEFAULT;

ALTER TABLE "LedgerEntry"
  ADD COLUMN "createdById" TEXT,
  ADD COLUMN "requestKey" TEXT,
  ADD COLUMN "voidedById" TEXT,
  ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMPTZ(3) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "voidedAt"  SET DATA TYPE TIMESTAMPTZ(3) USING "voidedAt"  AT TIME ZONE 'UTC';

-- Idempotency: the same form submission cannot be recorded twice.
CREATE UNIQUE INDEX "Customer_requestKey_key" ON "Customer"("requestKey");
CREATE UNIQUE INDEX "LedgerEntry_customerId_requestKey_key" ON "LedgerEntry"("customerId", "requestKey");

ALTER TABLE "AuditEvent"
  ADD CONSTRAINT "AuditEvent_ledgerEntryId_fkey"
  FOREIGN KEY ("ledgerEntryId") REFERENCES "LedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- More rules the database enforces itself ---------------------------------------------------------------------------------
ALTER TABLE "Customer"
  ADD CONSTRAINT "Customer_requested_check"
    CHECK ("requestedLimitCents" IS NULL OR "requestedLimitCents" >= 0);

ALTER TABLE "AppUser"
  ADD CONSTRAINT "AppUser_role_check"
    CHECK ("role" IN ('EMPLOYEE', 'ADMIN', 'SUPERADMIN')),
  ADD CONSTRAINT "AppUser_failed_check"
    CHECK ("failedLogins" >= 0);

-- Append-only, tightened -----------------------------------------------------------------------------------------------------
-- Same rule as before, now with a distinct error code the application can recognise, and TRUNCATE is refused too
-- (a row-level trigger never sees TRUNCATE, which would otherwise erase the whole history in one statement).
CREATE OR REPLACE FUNCTION credit_forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: this table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LedgerEntry_no_truncate"
  BEFORE TRUNCATE ON "LedgerEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION credit_forbid_change();

CREATE TRIGGER "AuditEvent_no_truncate"
  BEFORE TRUNCATE ON "AuditEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION credit_forbid_change();

-- A ledger entry may be voided once; nothing else about it may ever change. The new identity columns are frozen too.
CREATE OR REPLACE FUNCTION credit_ledger_void_only() RETURNS trigger AS $$
BEGIN
  IF OLD."voidedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'a voided ledger entry cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."customerId" IS DISTINCT FROM OLD."customerId"
     OR NEW."type" IS DISTINCT FROM OLD."type"
     OR NEW."amountCents" IS DISTINCT FROM OLD."amountCents"
     OR NEW."entryDate" IS DISTINCT FROM OLD."entryDate"
     OR NEW."dueDate" IS DISTINCT FROM OLD."dueDate"
     OR NEW."reference" IS DISTINCT FROM OLD."reference"
     OR NEW."note" IS DISTINCT FROM OLD."note"
     OR NEW."createdBy" IS DISTINCT FROM OLD."createdBy"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."requestKey" IS DISTINCT FROM OLD."requestKey"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'ledger entries are append-only: only voiding is allowed' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
