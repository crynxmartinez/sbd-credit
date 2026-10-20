# The books audit

One question: **can the books ever show a balance, an aging bucket or a customer-visible figure that is wrong, and would anyone notice?**

Date: 2026-10-21. Branch `books-audit` (PR 8). Everything below was run, not read: each finding names the command and what it printed.
"Shown by" says who or what checked it: **(a)** a tool, the database or CI; **(b)** believed from reading code and not checked by anything but me; **(c)** needs a person, named.

## How it was done

- **Raw material, not summaries.** The nine migrations (`prisma/migrations/*/migration.sql`), the database's own catalog (`pg_catalog`), the services and the pure rules, and the legacy page (`legacy/credit-tracker-artifact.html`). Earlier audit reports and code comments were not relied on.
- **A real Postgres 16 and a second implementation.** Local runs used a real PostgreSQL 16.14 on this machine (UTF8, not the hosted one, which refuses connections with `planLimitReached`), and CI's ephemeral `postgres:16`. The oracle in `src/test/books-oracle.ts` re-derives every figure from the *raw rows* by settling money **one cent at a time**; it shares no code with the application.
- **Nothing touched the live `public` schema**, or the hosted server at all.

## The claims (and what enforces each)

| # | Claim (falsifiable) | Enforced by | Attacked by |
| --- | --- | --- | --- |
| C1 | A customer's balance on day D = the sum of the signed amounts of live (not voided) entries dated on or before D. Nothing stores a balance. | `domain/ledger.ts` `balanceCents`; SQL mirror `services/ledger.ts` `balanceOf`; `LedgerEntry_amount_check`; no stored balance column | model, scale (every customer vs SQL), catalog, reconcile |
| C2 | What is open adds up to what is owed: Σ aging buckets = max(0, balance), credit = max(0, −balance); the dashboard's outstanding = Σ of all customers' buckets. | `domain/ledger.ts` `computeAging`, `domain/dashboard.ts` | model, scale, mutation-gaps, reconcile |
| C3 | Figures for day D do not change when entries dated after D are added, nor with the order entries are listed in. | `computeAging` | existing property tests; model (entries dated ahead) |
| C4 | A reversal makes the books exactly as if the entry never happened (from its date on); a void as if it never existed; a refused request leaves no trace; an entry is reversed once. | `reverseEntry`/`voidEntry`, `LedgerEntry_reversesEntryId_key`, `transaction()` | model (footprint before/after every refusal), concurrency |
| C5 | A write-off is allocated to charges in full, and no charge is settled twice on any day the write-off is in force. | `domain/write-off.ts`, triggers `WriteOffAllocation_rules`, `_total`, `LedgerEntry_write_off_allocated` | model, concurrency, mutation-gaps, reconcile |
| C6 | Ledger, audit, allocation and account-event rows cannot be changed or deleted (a ledger row can be voided once). | the 12 triggers, `grants.sql` | catalog (pg_catalog), reconcile, scale (after `pg_restore`) |
| C7 | After a database failure the person is told the truth: "nothing was saved" only when nothing was; a write is all-or-nothing; sending it again records it once. | `transaction()`, `classifyDbError`, request keys | faults (TCP proxy), concurrency |
| C8 | Concurrent writers to one customer give a result that could have happened one at a time; the same submission sent ten times is recorded once. | `lockCustomer` row lock, unique indexes | concurrency |
| C9 | Every screen shows ONE moment, and the staff list, the staff page, the dashboard, the CSV exports and the customer portal agree. | one `toSummary`; snapshot reads | model (all surfaces), snapshot (races), scale |
| C10 | A restore reproduces every row, every figure and every safeguard. | `backup.ts`/`restore.ts`; `pg_dump` | restore drill (CI), scale + `pg_dump`/`pg_restore` (CI) |
| C11 | A customer sees only whitelisted fields, and what they see adds up to what they owe. | `domain/portal.ts` `toPortalView` | model (portal entries sum to balance), mutation-gaps |
| C12 | "Today" is the business day (America/Chicago), not the machine's or UTC's. | `businessToday` | legacy differential (the old page used UTC) |

## Findings

### Found, proved, and fixed

**F1. The customer page could show a screen that never existed.** (a) `getDetail` ran **five separate statements** (customer, ledger, "reversed" marks, allocations, history) with no common snapshot. A reversal committing between the ledger read and the "reversed" read produced an entry marked *reversed* with no reversal on the page, and a balance that still counted it.
- Command: `npm run test:db -- books-snapshot` (the test holds one statement at the driver, commits the reversal, releases it).
- Before the fix: `AssertionError: the entry says it was reversed, so the reversal must be on the page: expected true to be false`. After: passes.
- Fix: one repeatable-read snapshot, reads issued one after another (`customers.ts`).

**F2. The customer list could move overdue money between aging buckets.** (a) `listSummaries` read customers, ledger and write-off allocations as three concurrent statements. A write-off committed after the allocations were read but before the ledger was read was counted as an ordinary payment, which settles the *oldest* charge instead of the one it was allocated to.
- Scenario: charge A $50 (45 days overdue), charge B $60 (not due), write-off $30 allocated to B.
- Before the fix: `expected { balance: 8000, overdue: 2000, nextDueCents: 2000 } to deeply equal { …overdue: 5000, nextDueCents: 5000 }`: **overdue shown as $20.00 when it was $50.00**.
- The window is the duration of the ledger query, so it grows with the size of the books. Fix: one repeatable-read snapshot.

**F3. The customer portal had the same hazard** (customer row and ledger read concurrently). (b) Fixed the same way; the model test reads the portal after every step, but the *race* itself is proved only for F1 and F2.

**F4. Two orderings were not deterministic.** (a) `npm run test:db` failed locally on `audit-fixes.int.test.ts › the export is the same whatever the page size`: the "Written off against" column listed `INV-B; INV-A` in one export and `INV-A; INV-B` in the next, because the allocations of one write-off share a `createdAt` and had no tie-break. The customer list had the same problem for two customers with the same name (an unstable list is an unstable ETag). Fixed with an id tie-break everywhere.

**F5. The unit tests would have passed with money rules broken.** (a) Stryker (`npm run mutation`) changed the code 1,180 ways; **150 survived and 11 had no test at all**. Real gaps, each now pinned by `mutation-gaps.test.ts`:
  - the overdue total with money 61-90 days late (`+ d61_90` could be `- d61_90`);
  - the whole rule that a write-off must have room on **every day it is in force** (every mutation of it survived);
  - a chosen write-off split that does not add up to the amount was not rejected by the pure rule (the database trigger would have);
  - alert thresholds at exactly 80% and 100%, the due-soon window edges, and the conditions for a due-soon reminder;
  - the portal showing a due date only for a purchase (an adjustment carries one in the database);
  - the dashboard's counts and totals (53% of its mutations survived);
  - impossible dates ("2026-02-30"), a third decimal place in a number, and the ledger export's columns.
  - Score: **85.1% → 93.2%** across `src/lib/domain` (1,416 mutations), and `backup.ts` 80.6% → 92.9%. What still survives is listed there, each marked equivalent or open.

**F6. A production database that is not UTF8 would refuse some writes.** (a) The local database was created as WIN1252 by default; three integration tests failed with `character with byte sequence 0xe2 0x88 0x92 in encoding "UTF8" has no equivalent in encoding "WIN1252"`: the minus sign the app writes into the history of a negative adjustment or reversal. Loud, not silent, but every such write would be refused. Production now refuses to start on any other encoding (`role-check.ts`), and the runbook says so.

**F7. The ledger export can combine two moments (open: known limit, executable).** (a) The ledger CSV is read a page at a time; each page is a separate statement. `books-snapshot.int.test.ts` (marked `test.fails` so CI stays green while the limit exists) holds the read after the page containing one entry, voids that entry and adds a new charge, then releases it. Run as an ordinary test it prints:
`AssertionError: the file adds up to a balance the books had at no moment: expected [ 3000, 2500 ] to include 3500` (the books had 30.00 before and 25.00 after; the file says 35.00).
- It needs two writes landing inside one export, so it is rare; it matters because the export is described as reconciling to the books. Not fixed here: the fix is one repeatable-read transaction fed through a small queue (so the stream can still be pulled), with the idle-in-transaction timeout raised for that transaction. Until then: export when few people are saving, and use `npm run reconcile` as the figure of record (docs/PRODUCTION.md §9).

### Not found (the claim held)

**C1, C2, C9, C11: every surface equals the one-cent-at-a-time oracle after every step.** (a) `books-model.int.test.ts`: random programs of up to 24 real service calls (charges, payments, adjustments, write-offs by default and by chosen allocation, reversals, voids, changes of the account's standing, and five kinds of deliberately bad request), checked after **every step** against the raw rows on the customer page, the list, the customer portal, the CSV export and a SQL `SUM`.
- Final run, six seeds (201-206), 70 programs each: **420 programs, 4,363 steps, 2,901 accepted and 1,462 refused**. Accepted: 899 charges, 938 payments, 198 adjustments, 218 write-offs, 240 reversals, 214 voids, 194 decisions (156 suspensions, 33 reopenings). Refusals by reason: `nothing_owed` 639, `invalid_state` 281, `closed_month` 71, `exceeds_balance` 37, `invalid_transition` 45, `not_found` 133, `invalid_entry` 94, `already_reversed`/`already_voided` 56, `not_reversible` 36, `not_voidable` 29, `write_off_covers` 41.
- **Zero disagreements, zero unexpected errors, and every refused step left nothing behind** (ledger, history and allocation counts identical before and after).
- Earlier runs of the same test (about 900 more programs, different seeds, before the standing changes were added) also passed. Command: `BOOKS_MODEL_SEED=201 BOOKS_MODEL_RUNS=70 npm run test:db -- books-model`.
- What it does **not** cover: customers with hundreds of entries each (programs are short), several customers at once (the scale test does that), and anything about what the rules *should* be.

**C1/C2 at size.** (a) `books-scale.int.test.ts`, 3,000 customers and **182,378 ledger rows** generated in the database: for **every** customer the application's balance equals the database's `SUM`, and open + credit conserve. Run: `BOOKS_SCALE=1 BOOKS_SCALE_CUSTOMERS=3000 npm run test:db -- books-scale`.

**C8: many writers.** (a) `books-concurrency.int.test.ts`: crowds of 12-28 simultaneous mixed writes on one customer end in books that equal the oracle (and nobody waits near the 10 s lock timeout); ten identical submissions → one row and one history line; two write-offs of everything owed at the same instant → exactly one accepted, allocations never exceed what was owed; two administrators reversing the same entry → one reversal, one `already_reversed`; a void racing a payment on a charge a write-off covers → always `write_off_covers`.

**C7: the connection cut at the worst moment.** (a) `books-faults.int.test.ts`. Not toxiproxy: a small TCP proxy between the app and Postgres cuts the connection (1) while the entry is being written, (2) at the instant COMMIT is sent, before the server sees it, (3) **after the server has committed but before the answer reaches the app**.
- In case 3 the row is in the database, the person is told "may or may not have been saved" (never "nothing was saved"), and resending the same submission returns `duplicate: true` with one row and one history line. Same for a reversal.
- In cases 1 and 2 nothing is left behind. The pool recovers and the books still equal the oracle.

**C6: the safeguards are really installed.** (a) `books-catalog.int.test.ts` reads `pg_catalog`: exactly the 12 expected triggers exist and all are enabled; UPDATE, DELETE and TRUNCATE are covered on every record table; every trigger function has a pinned `search_path`; the void-only trigger compares the whole row; **no column anywhere stores a balance, total or running figure**; money is `integer`, never float or decimal; moments carry their zone; the 16 named CHECK constraints exist; every foreign key on the ledger, audit and allocation tables is `RESTRICT`; every table has a primary key; and DELETE, UPDATE of an amount and TRUNCATE are refused by the database itself.

### The answer to "would anyone notice?"

Before this branch: **no**. Nothing checked the live books against anything. A change made with the owner's keys (a trigger switched off, an amount updated) would show only as a wrong number someone happened to question.

Now: `npm run reconcile` (read-only; runs as the app's own login; exit code 1 on any finding). `books-reconcile.int.test.ts` shows it **fails when it should**: with the database's own rules switched off the way a rogue owner could, it finds (a) an entry written straight into the ledger with no history line, (b) an amount changed after the fact (the history line recorded when it was entered no longer agrees: audit rows are append-only, so they are the witness), (c) a write-off allocated to a charge for more than the charge was and one not allocated in full, (d) a reversal that does not offset what it names, (e) an entry outside the dates and amounts the app allows, (f) a trigger switched off. At 182,378 entries it takes about 6 s and cross-checks every amount against its history line. It is **not scheduled anywhere yet**: someone must run it nightly and alert on a non-zero exit (docs/PRODUCTION.md, section 7).

### The legacy system (differential)

(a) `legacy-differential.test.ts` lifts the legacy page's own functions out of the HTML and runs them on the same customers as the new rules. **What the legacy page can be compared on is small**: it keeps one typed-in balance per customer (no ledger, no aging, no write-offs), so only the credit-line percentage, its warning levels and its alerts are comparable. Every disagreement is one of two, each asserted by name (a disagreement outside them fails the test):
- D1: the legacy page rounds to the *nearest* percent, so 79.5% already warns and 99.5% already says "over its limit"; the new rules round down.
- D2: the new rules alert on overdue money for suspended, denied and under-review accounts; the legacy page only for approved ones.
- The legacy page also decided "today" from the UTC clock (so from 7 pm Central it was tomorrow) and floored an overpayment at zero (the extra money vanished); the new system keeps it as credit. Both are bugs in the old system, not the new.

### Scale, restore and timing

(a) At 182,378 ledger rows and 3,000 customers (measured on a laptop while another heavy job was running, so conservative): the customer list takes **3.8 s** to compute with the **event loop frozen for up to 0.7 s**, the dashboard 0.04 s, the customers CSV 3.6 s, the ledger CSV 17 s for 18 MB (streamed), the nightly reconciliation 6 s, the heaviest customer's page 0.04 s. The list is recomputed after every write (it is cached until one), so at this size **every save makes the next list view cost about 4 s of server time**. That is inside the documented limit (docs/PRODUCTION.md §9, "beyond roughly 5,000 customers move the sums into SQL") but it is the first thing to break as the business grows.

`pg_dump` → `pg_restore` into a clean database, with a row-and-figure comparison and the triggers re-checked, runs in CI only (this machine has no `pg_dump`): see the `books` job and its artifact `books-scale-report`. **Result: see "CI results" below.**

## What a person must decide (c)

These are not defects a test can find. They are rules the system follows exactly, and whether they are the *right* rules is not something the code, the tests or I can say.

| Rule | The question | Who |
| --- | --- | --- |
| A payment settles the **oldest due** charge first and cannot be applied to a named invoice. | Does this match how customers pay and how their own books apply it? A customer paying invoice B will see invoice A reduced; their statement will not match ours invoice by invoice. | the accountant, then a customer |
| Aging counts days past the **due date**, in buckets 1-30 / 31-60 / 61-90 / 90+. | Many AR reports age from the **invoice date**. Which does the business, the auditor and the bank expect? | the accountant |
| A write-off is allocated to charges, reduces the balance like a payment, is shown to the customer as "Credit applied", and is counted separately as "written off". | Is that the right treatment (bad-debt expense vs credit memo), and is "Credit applied" the right word for a customer? | the accountant |
| The over-limit warning starts at the limit; the near-limit warning at 80% (rounded down). | Policy. | you |
| A void is allowed only in the current month; older entries are corrected by a reversal dated today. | Does the month-end close match how the books are closed elsewhere (the accounting app)? | the accountant |
| Every figure above, against reality. | Do the system's balances equal the customer's own records and the bank? | **a customer** (ask three to confirm their balance and last three payments); **a staff member** closing one real month and tying the system's totals to the books that are kept today; the bank statement for the payments |

## Mutation: what still survives

(a) `npm run mutation` (Stryker, `stryker.config.json`; weekly in `.github/workflows/mutation.yml`, which fails below 88%).

**`src/lib/domain`** (13 files + `backup`, `idempotency`, `csv`): 1,180 mutations at the start, **85.1%** killed; after the gap tests **93.2%** (alerts, dashboard, ledger-csv, portal, summary, corrections, entry-dates 100%; ledger 97.9%; write-off 96.3%). `backup.ts` was 80.6% (every way a damaged backup file should be refused was untested); after its tests 92.9% (re-measured on its own).

What still survives in the domain is, on inspection, **equivalent or a tooling artifact**, not a way for the books to be wrong:
- `ledger.ts` `>`/`>=` on amounts that are never zero (a zero amount is refused by `LedgerEntry_amount_check`); an allocation on an entry that is not a write-off (cannot exist).
- `write-off.ts` the days set and its sort (the minimum over days does not depend on order or on whether an edge day is included twice); an allocations list that is undefined (data from before allocations existed, covered by the legacy tests).
- `dates.ts` the single-conjunct mutations of the calendar round-trip (each is implied by the other two: if the year and the day match, the month must), and the regex of the date pattern: Stryker cannot reliably activate mutations in a module-level constant. **Checked by hand**: removing the `$` from the pattern fails 4 tests.
- `money.ts` `<` vs `<=` on a float tolerance, and the string-literal defaults of a destructuring.
- `customer-list.ts`, `status.ts`, `csv.ts`: a `case` label replaced by itself, an error label, the empty-search shortcut.

**`src/lib/server/services/ledger.ts`** (481 mutations, run against the integration suite on a real database): **82.6%** killed (371 killed, 9 timeouts, 60 survived, 20 with no covering test). The survivors were mostly the wording of refusal messages, but five were real gaps in rules about money, now covered by `books-ledger-gaps.int.test.ts`: a write-off from before allocations existed protecting the balance when a charge is corrected (no test reached it at all), a retry of an entry that was later voided, a post-dated entry on retry, the exact overpayment boundary, and a second void by a different person or for a different reason. The same file now asserts the words of every refusal (the words say what to do next, so they are part of the behaviour). A targeted re-run over the affected functions (329 mutations) was still running when this was pushed; its result is not in this document, so the services score above is the measurement **before** those tests.

Not mutation-tested: the other services (`customers.ts`, `portal-access.ts`, `exports.ts`), the route handlers, and the screens.


## CI results

Run `39503765824` (commit `e5a4587`) on this branch: **every job green** (`check`, `database` including the restore drill, `browser`, `grants`, `books`, `windows`, three time-zone jobs, `ci-ok`). Later commits only add tests and were re-run by CI after this was written; see the checks on PR 8 for the current state.

The `books` job's report (ubuntu runner, quiet machine, 3,000 customers, 182,378 ledger rows and as many history lines):

| Step | Result |
| --- | --- |
| Generate the rows in the database | 11.4 s |
| Customer list (computed) | 1.27 s |
| Nightly reconciliation (all 182,378 amounts cross-checked against their history lines) | 2.06 s |
| Dashboard | 0.02 s |
| Customers CSV / ledger CSV (18 MB, streamed) | 1.12 s / 5.7 s |
| Heaviest customer's page | 0.01 s |
| `pg_dump -Fc` of the schema | **0.85 s** |
| `pg_restore` into a clean database | **3.33 s** |
| Rows (4 tables), their md5, and every customer's balance, restored vs original | **identical** |
| Triggers after the restore | all present and enabled; DELETE and UPDATE of a recorded amount refused by the restored database |
| CHECK constraints after the restore | 22 |

The first `database` run on this branch failed, and that was a real lesson: the reconcile tests (which deliberately corrupt rows as a rogue owner could) left corrupt rows in the shared test schema, and the restore drill **correctly refused to restore them** (`allocations cannot add up to more than the write-off`). The tests now undo their damage. It also shows the restore does enforce the rules on the way back in.


## What was not done, and why

- **toxiproxy**: replaced by a small TCP proxy in the test itself (no binary to download, and it can cut at an exact protocol message, which toxiproxy cannot).
- **Mutation testing of the services**: `services/ledger.ts` only (below); the other services need the same treatment.
- **A differential run on aging, write-offs and reversals**: impossible, the legacy page has none of them.
- **Production-shaped data**: none was provided; the scale test generates deterministic data in the database. It is realistic in size and shape, not in behaviour (real customers pay late in clumps).
- **The hosted database**: unreachable (`planLimitReached`), so nothing here says anything about its settings. Check `SHOW server_encoding` and run `scripts/verify-grants.mjs` against it.
