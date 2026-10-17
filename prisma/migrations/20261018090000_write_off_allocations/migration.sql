-- A write-off now names the charges it gives up on. Each write-off is split into allocations (one row per charge, adding up
-- to the write-off's amount exactly). That replaces a guess from dates with a fact: "what covers this charge?" has an answer,
-- a charge nothing covers can always be corrected, and reversing or voiding a write-off frees its charges by itself.
--
-- Allocations are append-only like the ledger: they are never edited or deleted. Whether one is IN FORCE is derived from its
-- write-off (not voided, not undone by a reversal), so nothing here ever needs to be changed when a write-off is corrected.

-- Set by the application on every write-off recorded from now on: such a write-off must be allocated in full. Write-offs from
-- before this change (and old backups restored into a new database) do not carry it, so they need no allocations and can be
-- restored as they were: the app counts an unallocated write-off as an ordinary credit.
ALTER TABLE "LedgerEntry" ADD COLUMN "allocationsRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_allocationsRequired_only_write_off"
    CHECK (NOT "allocationsRequired" OR "type" = 'WRITE_OFF');

-- Append-only, extended: the new column is frozen along with the others.
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
     OR NEW."allocationsRequired" IS DISTINCT FROM OLD."allocationsRequired"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'ledger entries are append-only: only voiding is allowed' USING ERRCODE = 'CR001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE "WriteOffAllocation" (
    "id"              TEXT NOT NULL,
    "writeOffEntryId" TEXT NOT NULL,
    "chargeEntryId"   TEXT NOT NULL,
    "amountCents"     INTEGER NOT NULL,
    "createdAt"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WriteOffAllocation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WriteOffAllocation_amount_positive" CHECK ("amountCents" > 0)
);

CREATE UNIQUE INDEX "WriteOffAllocation_writeOffEntryId_chargeEntryId_key" ON "WriteOffAllocation"("writeOffEntryId", "chargeEntryId");
CREATE INDEX "WriteOffAllocation_chargeEntryId_idx" ON "WriteOffAllocation"("chargeEntryId");

ALTER TABLE "WriteOffAllocation" ADD CONSTRAINT "WriteOffAllocation_writeOffEntryId_fkey"
    FOREIGN KEY ("writeOffEntryId") REFERENCES "LedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WriteOffAllocation" ADD CONSTRAINT "WriteOffAllocation_chargeEntryId_fkey"
    FOREIGN KEY ("chargeEntryId") REFERENCES "LedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only, exactly like the ledger and the audit log: no update, no delete, no truncate.
CREATE TRIGGER "WriteOffAllocation_append_only"
    BEFORE UPDATE OR DELETE ON "WriteOffAllocation"
    FOR EACH ROW EXECUTE FUNCTION credit_forbid_change();
CREATE TRIGGER "WriteOffAllocation_no_truncate"
    BEFORE TRUNCATE ON "WriteOffAllocation"
    FOR EACH STATEMENT EXECUTE FUNCTION credit_forbid_change();

-- What an allocation may point at. The application checks this too; the database refuses a row that breaks it regardless.
CREATE FUNCTION credit_check_allocation_row() RETURNS trigger AS $$
DECLARE
    w RECORD;
    c RECORD;
    w_amount INTEGER;
    already BIGINT;
BEGIN
    SELECT "customerId", "type", "entryDate" INTO w FROM "LedgerEntry" WHERE "id" = NEW."writeOffEntryId";
    SELECT "customerId", "type", "amountCents", "entryDate" INTO c FROM "LedgerEntry" WHERE "id" = NEW."chargeEntryId";
    IF w IS NULL OR c IS NULL THEN
        RAISE EXCEPTION 'a write-off allocation must point at two ledger entries' USING ERRCODE = 'CR002';
    END IF;
    IF w."type" <> 'WRITE_OFF' THEN
        RAISE EXCEPTION 'allocations belong to write-offs only' USING ERRCODE = 'CR002';
    END IF;
    IF w."customerId" <> c."customerId" THEN
        RAISE EXCEPTION 'a write-off can only cover a charge of the same customer' USING ERRCODE = 'CR002';
    END IF;
    IF NOT (c."type" = 'CHARGE' OR (c."type" = 'ADJUSTMENT' AND c."amountCents" > 0)) THEN
        RAISE EXCEPTION 'a write-off can only cover a charge or an adjustment that raised what is owed' USING ERRCODE = 'CR002';
    END IF;
    IF c."entryDate" > w."entryDate" THEN
        RAISE EXCEPTION 'a write-off cannot cover a charge dated after it' USING ERRCODE = 'CR002';
    END IF;
    -- Never more than the write-off itself, at any moment (the exact total is checked at commit, below).
    SELECT w2."amountCents" INTO w_amount FROM "LedgerEntry" w2 WHERE w2."id" = NEW."writeOffEntryId";
    SELECT COALESCE(SUM("amountCents"), 0) INTO already FROM "WriteOffAllocation" WHERE "writeOffEntryId" = NEW."writeOffEntryId";
    IF already + NEW."amountCents" > w_amount THEN
        RAISE EXCEPTION 'allocations cannot add up to more than the write-off: % + % > %', already, NEW."amountCents", w_amount USING ERRCODE = 'CR002';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "WriteOffAllocation_rules"
    BEFORE INSERT ON "WriteOffAllocation"
    FOR EACH ROW EXECUTE FUNCTION credit_check_allocation_row();

-- A write-off recorded with "allocationsRequired" must be allocated to charges EXACTLY, checked when the transaction commits
-- (the entry and its allocations are written one after the other inside it). Older write-offs are not checked: the function
-- below allocates them where it can, and any it cannot allocate stay as they were (the app treats those as an ordinary credit).
CREATE FUNCTION credit_check_write_off_total() RETURNS trigger AS $$
DECLARE
    write_off_id TEXT;
    write_off_amount INTEGER;
    required BOOLEAN;
    allocated BIGINT;
BEGIN
    -- (An IF, not a CASE: a CASE would read both columns, and each table has only one of them.)
    IF TG_TABLE_NAME = 'LedgerEntry' THEN
        write_off_id := NEW."id";
    ELSE
        write_off_id := NEW."writeOffEntryId";
    END IF;
    SELECT "amountCents", "allocationsRequired" INTO write_off_amount, required FROM "LedgerEntry" WHERE "id" = write_off_id;
    IF NOT required THEN RETURN NULL; END IF;
    SELECT COALESCE(SUM("amountCents"), 0) INTO allocated FROM "WriteOffAllocation" WHERE "writeOffEntryId" = write_off_id;
    IF allocated <> write_off_amount THEN
        RAISE EXCEPTION 'a write-off must be allocated to charges in full: % of % allocated', allocated, write_off_amount USING ERRCODE = 'CR002';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "LedgerEntry_write_off_allocated"
    AFTER INSERT ON "LedgerEntry"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW WHEN (NEW."allocationsRequired")
    EXECUTE FUNCTION credit_check_write_off_total();
CREATE CONSTRAINT TRIGGER "WriteOffAllocation_total"
    AFTER INSERT ON "WriteOffAllocation"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION credit_check_write_off_total();

-- Allocates every write-off in force that has no allocations yet, the way the app would have: write-offs oldest first, each
-- covering the oldest-due charges that are still open (payments settle charges oldest-due-first, so "still open" is what is
-- left after them). If later payments left too little open, the rest is placed on the charges' remaining capacity; if even
-- that is not enough, the write-off is left unallocated (the app counts it as an ordinary credit, so balances never change).
-- Safe to run again: it only ever touches write-offs that have no allocations.
CREATE FUNCTION credit_backfill_write_off_allocations() RETURNS integer AS $$
DECLARE
    cust RECORD;
    w RECORD;
    d RECORD;
    pool BIGINT;
    pool_left BIGINT;
    need BIGINT;
    take BIGINT;
    open_amount BIGINT;
    planned BIGINT;
    made INTEGER := 0;
BEGIN
    CREATE TEMP TABLE IF NOT EXISTS _bf_debits (ord SERIAL, id TEXT, remaining BIGINT, eligible BOOLEAN, entry_date DATE) ON COMMIT DROP;
    CREATE TEMP TABLE IF NOT EXISTS _bf_plan (id TEXT PRIMARY KEY, amount BIGINT) ON COMMIT DROP;
    CREATE TEMP TABLE IF NOT EXISTS _bf_view (LIKE "LedgerEntry") ON COMMIT DROP;

    FOR cust IN
        SELECT DISTINCT e."customerId" AS id
        FROM "LedgerEntry" e
        WHERE e."type" = 'WRITE_OFF' AND e."voidedAt" IS NULL
          AND NOT EXISTS (SELECT 1 FROM "LedgerEntry" r WHERE r."reversesEntryId" = e."id" AND r."voidedAt" IS NULL)
          AND NOT EXISTS (SELECT 1 FROM "WriteOffAllocation" a WHERE a."writeOffEntryId" = e."id")
        ORDER BY 1
    LOOP
        -- The books as the app sees them today: not voided, not dated ahead, and with each reversal cancelling the entry it names.
        -- Nothing else may write to this customer while its write-offs are allocated.
        PERFORM 1 FROM "Customer" WHERE "id" = cust.id FOR UPDATE;

        DELETE FROM _bf_view;
        INSERT INTO _bf_view
            WITH live AS (
                SELECT * FROM "LedgerEntry"
                WHERE "customerId" = cust.id AND "voidedAt" IS NULL AND "entryDate" <= CURRENT_DATE
            ), cancelled AS (
                SELECT r."id" AS reversal_id, r."reversesEntryId" AS target_id
                FROM live r WHERE r."type" = 'REVERSAL' AND r."reversesEntryId" IN (SELECT "id" FROM live)
            )
            SELECT l.* FROM live l
            WHERE l."id" NOT IN (SELECT reversal_id FROM cancelled) AND l."id" NOT IN (SELECT target_id FROM cancelled);

        DELETE FROM _bf_debits;
        ALTER SEQUENCE _bf_debits_ord_seq RESTART WITH 1;
        INSERT INTO _bf_debits (id, remaining, eligible, entry_date)
            SELECT v."id",
                   v."amountCents" - COALESCE((
                       SELECT SUM(a."amountCents") FROM "WriteOffAllocation" a
                       WHERE a."chargeEntryId" = v."id" AND a."writeOffEntryId" IN (SELECT "id" FROM _bf_view)
                   ), 0),
                   (v."type" = 'CHARGE' OR (v."type" = 'ADJUSTMENT' AND v."amountCents" > 0)),
                   v."entryDate"
            FROM _bf_view v
            WHERE (CASE WHEN v."type" IN ('PAYMENT', 'WRITE_OFF') THEN -v."amountCents" ELSE v."amountCents" END) > 0
            ORDER BY COALESCE(v."dueDate", v."entryDate"), v."entryDate", v."id" COLLATE "C";

        -- Payments and reductions settle charges oldest-first. Write-offs are handled one by one below.
        SELECT COALESCE(SUM(-(CASE WHEN v."type" = 'PAYMENT' THEN -v."amountCents" ELSE v."amountCents" END)), 0) INTO pool
        FROM _bf_view v
        WHERE v."type" <> 'WRITE_OFF'
          AND (CASE WHEN v."type" IN ('PAYMENT', 'WRITE_OFF') THEN -v."amountCents" ELSE v."amountCents" END) < 0;

        FOR w IN
            SELECT v."id", v."amountCents", v."entryDate" FROM _bf_view v
            WHERE v."type" = 'WRITE_OFF'
              AND NOT EXISTS (SELECT 1 FROM "WriteOffAllocation" a WHERE a."writeOffEntryId" = v."id")
            ORDER BY v."entryDate", v."createdAt", v."id"
        LOOP
            need := w."amountCents";
            pool_left := pool;
            DELETE FROM _bf_plan;

            -- First choice: what is genuinely still open, oldest due date first.
            FOR d IN SELECT * FROM _bf_debits ORDER BY ord LOOP
                open_amount := d.remaining - LEAST(d.remaining, pool_left);
                pool_left := pool_left - LEAST(d.remaining, pool_left);
                IF d.eligible AND d.entry_date <= w."entryDate" AND need > 0 AND open_amount > 0 THEN
                    take := LEAST(open_amount, need);
                    INSERT INTO _bf_plan VALUES (d.id, take) ON CONFLICT (id) DO UPDATE SET amount = _bf_plan.amount + take;
                    need := need - take;
                END IF;
            END LOOP;

            -- Later payments may have over-paid: place the rest on what each charge still has room for.
            IF need > 0 THEN
                FOR d IN SELECT * FROM _bf_debits ORDER BY ord LOOP
                    IF d.eligible AND d.entry_date <= w."entryDate" AND need > 0 THEN
                        SELECT COALESCE(amount, 0) INTO planned FROM _bf_plan WHERE id = d.id;
                        planned := COALESCE(planned, 0);
                        take := LEAST(d.remaining - planned, need);
                        IF take > 0 THEN
                            INSERT INTO _bf_plan VALUES (d.id, take) ON CONFLICT (id) DO UPDATE SET amount = _bf_plan.amount + take;
                            need := need - take;
                        END IF;
                    END IF;
                END LOOP;
            END IF;

            IF need = 0 THEN
                INSERT INTO "WriteOffAllocation" ("id", "writeOffEntryId", "chargeEntryId", "amountCents")
                    SELECT 'wa' || md5(w."id" || p.id), w."id", p.id, p.amount FROM _bf_plan p;
                UPDATE _bf_debits b SET remaining = b.remaining - p.amount FROM _bf_plan p WHERE b.id = p.id;
                made := made + 1;
            ELSE
                -- Cannot be allocated: it stays an ordinary credit, so it keeps settling the oldest charges.
                pool := pool + w."amountCents";
                RAISE NOTICE 'write-off % could not be allocated to charges and was left as it was', w."id";
            END IF;
        END LOOP;
    END LOOP;
    RETURN made;
END;
$$ LANGUAGE plpgsql;

-- (Restricting who may run it is a grant, which some hosted databases do not allow inside a migration: see Step C in
-- docs/PRODUCTION.md, which revokes it from the running app's role.)

SELECT credit_backfill_write_off_allocations();
