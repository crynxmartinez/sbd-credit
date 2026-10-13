-- Review clock and attribution -------------------------------------------------------------------------------------
ALTER TABLE "AuditEvent" ADD COLUMN     "actorId" TEXT;

ALTER TABLE "Customer" ADD COLUMN     "statusChangedOn" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP;
-- Existing customers: the best available answer to "since when has this status held" is the application date.
UPDATE "Customer" SET "statusChangedOn" = "dateApplied";

-- Integrity rules ----------------------------------------------------------------------------------------------------
-- The application already enforces all of these. Repeating them in the database means no other script, console or
-- future code path can break them, and "append-only" stops being a convention and becomes a guarantee.

ALTER TABLE "Customer"
  ADD CONSTRAINT "Customer_status_check"
    CHECK ("status" IN ('submitted', 'under_review', 'approved', 'denied', 'suspended')),
  ADD CONSTRAINT "Customer_credit_check"
    CHECK ("creditLimitCents" >= 0 AND "version" >= 1);

ALTER TABLE "LedgerEntry"
  ADD CONSTRAINT "LedgerEntry_type_check"
    CHECK ("type" IN ('CHARGE', 'PAYMENT', 'ADJUSTMENT')),
  -- Charges and payments are positive. Only an adjustment may be negative, and it may not be zero.
  ADD CONSTRAINT "LedgerEntry_amount_check"
    CHECK (("type" = 'ADJUSTMENT' AND "amountCents" <> 0) OR ("type" <> 'ADJUSTMENT' AND "amountCents" > 0)),
  -- A void is all three markers together or none of them.
  ADD CONSTRAINT "LedgerEntry_void_check"
    CHECK (
      ("voidedAt" IS NULL AND "voidedBy" IS NULL AND "voidReason" IS NULL)
      OR ("voidedAt" IS NOT NULL AND "voidedBy" IS NOT NULL AND "voidReason" IS NOT NULL)
    );

-- Append-only enforcement ------------------------------------------------------------------------------------------------
CREATE FUNCTION credit_forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: this table is append-only', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- A ledger entry may be voided once, and nothing else about it may ever change.
CREATE FUNCTION credit_ledger_void_only() RETURNS trigger AS $$
BEGIN
  IF OLD."voidedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'a voided ledger entry cannot be changed';
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
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'ledger entries are append-only: only voiding is allowed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LedgerEntry_no_delete"
  BEFORE DELETE ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION credit_forbid_change();

CREATE TRIGGER "LedgerEntry_void_only"
  BEFORE UPDATE ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION credit_ledger_void_only();

CREATE TRIGGER "AuditEvent_append_only"
  BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION credit_forbid_change();
