-- Write-offs and dated reversals ------------------------------------------------------------------------------------------
-- WRITE_OFF: debt given up on. It reduces the balance like a payment but is not money received.
-- REVERSAL: the signed offset of an earlier entry, dated today. A past month is corrected by a new entry, not rewritten.

ALTER TABLE "LedgerEntry" ADD COLUMN "reversesEntryId" TEXT;

ALTER TABLE "LedgerEntry"
  DROP CONSTRAINT "LedgerEntry_type_check",
  DROP CONSTRAINT "LedgerEntry_amount_check";

ALTER TABLE "LedgerEntry"
  ADD CONSTRAINT "LedgerEntry_type_check"
    CHECK ("type" IN ('CHARGE', 'PAYMENT', 'ADJUSTMENT', 'WRITE_OFF', 'REVERSAL')),
  -- Charges, payments and write-offs are positive. Adjustments and reversals are signed, and neither may be zero.
  ADD CONSTRAINT "LedgerEntry_amount_check"
    CHECK (
      ("type" IN ('ADJUSTMENT', 'REVERSAL') AND "amountCents" <> 0)
      OR ("type" NOT IN ('ADJUSTMENT', 'REVERSAL') AND "amountCents" > 0)
    ),
  -- A reversal names what it offsets, and nothing else does.
  ADD CONSTRAINT "LedgerEntry_reversal_check"
    CHECK (("type" = 'REVERSAL') = ("reversesEntryId" IS NOT NULL)),
  -- A write-off or reversal changes the books without new money moving, so it always carries its reason.
  ADD CONSTRAINT "LedgerEntry_reason_check"
    CHECK ("type" NOT IN ('WRITE_OFF', 'REVERSAL') OR ("note" IS NOT NULL AND length(btrim("note")) >= 3));

ALTER TABLE "LedgerEntry"
  ADD CONSTRAINT "LedgerEntry_reversesEntryId_fkey"
  FOREIGN KEY ("reversesEntryId") REFERENCES "LedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One reversal per entry, whatever request key or session it arrives with.
CREATE UNIQUE INDEX "LedgerEntry_reversesEntryId_key" ON "LedgerEntry"("reversesEntryId");

-- Append-only, extended: the new column is frozen along with the others. Only voiding may ever change a row.
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
     OR NEW."reversesEntryId" IS DISTINCT FROM OLD."reversesEntryId"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'ledger entries are append-only: only voiding is allowed' USING ERRCODE = 'CR001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
