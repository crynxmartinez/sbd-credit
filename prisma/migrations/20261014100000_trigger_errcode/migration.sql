-- The previous migration raised these with SQLSTATE 'restrict_violation' (23001). Prisma reports that class of error as
-- a foreign-key violation and drops the message, which hid WHY a write was refused. A code of our own keeps the message
-- ("ledger entries are append-only: only voiding is allowed") and still lets the application recognise these refusals.
CREATE OR REPLACE FUNCTION credit_forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: this table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'CR001';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION credit_ledger_void_only() RETURNS trigger AS $$
BEGIN
  IF OLD."voidedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'a voided ledger entry cannot be changed' USING ERRCODE = 'CR001';
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
    RAISE EXCEPTION 'ledger entries are append-only: only voiding is allowed' USING ERRCODE = 'CR001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
