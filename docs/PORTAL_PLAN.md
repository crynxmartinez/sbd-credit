# Customer portal: plan

Status: **Phase 1 is built** (accounts, shared sign-in, the "My Credit" page, staff controls). Phases 2 to 5 are proposed,
not started. Decisions marked *Assumed* are defaults chosen so work can begin; change any of them and the affected phase
changes, not the whole plan.

What Phase 1 changed from the first sketch, after an independent security review:
- The invitation token is in the link's **fragment** (`/accept-invite#t=...`), never the query string, so no server log or
  Referer header can carry it. The page reads it, removes it from the address bar, and only an explicit submit uses it.
- A customer is **never locked out by wrong guesses**. Their sign-in name is their email, which anyone who knows them can
  guess, so any lock threshold would let a stranger lock them out on purpose. Per-address and per-account-and-address
  limits, the cost of each password check, and a 12-character minimum stop guessing instead; a long run of failures is logged.
- Staff and customer sessions are signed with **separate keys derived from `SESSION_SECRET`**, and the raw secret is never
  used to sign. (Deploying this signed every staff member out once.)
- A reset keeps the old password working until the new link is used, so a reset never locks out someone who simply asked for
  help. It does sign them out everywhere, and the reset link lasts two days (a first invitation, seven).
- There is no portal data API: the customer page is rendered on the server from the signed-in contact, so no request can
  name a customer. Any future portal API starts with a customer-session check and the same scoping.

## 1. Goal

Staff run credit in the existing app. Customers get their own app where they can:

1. **See their credit plan**: how much they may buy on credit, how much is left, their terms, what is due.
2. **Apply for credit** without calling anyone.
3. **Ask for more credit** and see the answer.
4. **See what they have bought and paid.**

This is **trade credit** (buy materials now, pay on Net 15/30/45/60/90 terms), not a loan. There is no interest or fee
anywhere in the system, and this plan does not add one. *Assumed.*

## 2. Where we are today

Built and tested (staff app only):

- Application and review workflow: `submitted`, `under_review`, `approved` / `denied`, `suspended`, reopen.
- An admin sets the credit limit, payment terms and start date at approval.
- A ledger (charge, payment, adjustment, write-off, reversal). The balance is always computed. Per customer: balance,
  limit, **available credit**, percent used, past due in aging buckets, next payment due.
- Staff alerts, audit trail, CSV export, backup and restore, roles (employee / admin / superadmin).

Not there:

| Gap | Consequence |
| --- | --- |
| Customers have no login or screens | Nothing customer-facing exists |
| Applications are typed in by staff | No online application |
| A limit change is an admin editing a number | No request, no approval trail from the customer's side |
| One limit per customer, no tiers | No "plan" to show beyond their own limit and terms |
| No messages (email or text) | Customers learn nothing unless staff call |
| Charges are typed in by staff | Purchases are not linked to orders |

## 3. Principles (apply to every phase)

1. **The server decides who the customer is.** From the session only. No portal request ever carries a customer id that is
   trusted. This is the rule the whole portal is built and tested around.
2. **One sign-in page, two separate identities.** Staff and customers use the same page, form and design ("Username or
   email"). Behind it they stay apart: customer accounts live in their own table, and the session records whether it is a
   staff or a customer session. After sign-in staff go to the dashboard and customers to `/portal`. Staff screens and APIs
   reject customer sessions, and portal screens and APIs reject staff sessions, so a missed check fails closed instead
   of exposing staff data. No shared "role" column decides it.
3. **Whitelist what they see.** A dedicated portal data type, built field by field. Internal notes, the audit trail,
   voided entries, other customers and staff names are never in it.
4. **Reuse the money rules.** Available credit, aging, balance and the ledger are the existing pure functions. The portal
   adds no second copy of any money rule.
5. **Same safety bar as the staff app.** Money writes through `transaction()` with request keys, strict CSP, CSRF check,
   rate limits, generic sign-in errors, audit events, tests before code in `domain/`.

## 4. Phases

Each phase ships on its own and is useful on its own. Size: S under a day, M a few days, L about a week.

### Phase 1 (M-L). Accounts and "My Credit" page, read-only

The core of what was described.

- **Data:** `CustomerUser` (customer, email, name, password hash, active, session version, lockout fields) and
  `PortalInvite` (hashed single-use token, expiry, used-at).
- **Auth:** invite link sets the customer's own password. **The existing sign-in page serves both:** the server looks the
  identifier up as staff, then as customer, and sends each to their own home (staff `/`, customer `/portal`). The same
  username or email may not exist as both kinds (sign-in refuses an ambiguous match rather than guess). Identical error
  for wrong password, unknown name and locked account; shared lockout and rate limit; customer sessions are shorter than
  staff sessions. Staff and customer sessions use different cookies and signing keys.
- **Routes:** `/portal` (server-rendered, no data API) and `/api/portal/accept` (public, rate-limited). Staff manage
  contacts under `/api/customers/[id]/portal`.
- **"My Credit" page:**
  - *Available to purchase* (the big figure), credit limit, percent used.
  - Payment terms, next payment due, past due with age.
  - Their charges and payments, newest first.
  - If suspended: available shows 0 with a plain message to contact us.
- **Staff side:** a "Portal access" panel in the customer drawer (admin): invite a contact, list contacts, disable, resend,
  reset password. Each is an audit event.
- **What a customer sees of the ledger** *(Assumed)*: charges as "Purchase", payments as "Payment", a write-off as "Credit
  applied", a reversal as "Correction", voided entries not at all.

Done when: tests prove customer A cannot read customer B by any route; an admin can onboard a customer end to end.

### Phase 2 (L). Apply online and track the application

- **Public application form** (business, contact, email, phone, requested limit, trade references): creates a `submitted`
  customer flagged `source = portal`, so the existing review flow takes over unchanged.
- **Abuse protection** (this is the first unauthenticated write in the system): per-address rate limit, honeypot field,
  email verification before anything reaches staff, size limits, and a daily cap.
- **No information leak:** the form never says whether a business or email already exists. Possible duplicates are
  flagged for staff to merge by hand, never merged automatically.
- **Status page:** the applicant signs in after verifying their email and sees Submitted, Under review, Approved or Not
  approved. A denial reason stays internal *(Assumed)*.
- **Staff side:** new online applications show a "From portal" tag and sit in the existing list.

Done when: an applicant can apply, verify, and watch the status change as staff decide; a bot cannot flood the list.

### Phase 3 (M). Requests for more credit

- **Data:** `CreditRequest` (customer, requested limit, reason, status pending / approved / declined, decided by and when,
  note, request key).
- **Customer:** one open request at a time, with a reason; sees pending, approved or declined.
- **Staff:** an inbox for admins. **Approving applies the new limit through the existing change-credit path** (version
  check, audit event), so nothing new can bypass the credit rules. Employees can see requests but not decide.
- **Rules:** a request above a ceiling, or on a past-due account, can be blocked or flagged *(threshold Assumed: flag, not
  block; set it in `constants.ts`)*.

Done when: request, approve, and decline each change exactly what they should and leave an audit trail; a retried request
is recorded once.

### Phase 4 (M, needs a decision). Messages and statements

- **Email** (needs a provider; see decisions): invite, application received, approved or not approved, payment due soon,
  past due.
- **Monthly statement** as of a closed month, PDF and CSV. Closed months are stable because corrections are made by
  reversal, so a statement never changes after it is sent.
- **Preferences:** which messages a contact receives.

### Phase 5 (S-M, only if wanted). Fixed credit plans

- `CreditPlan` (name, limit, terms) used as presets when an admin approves, and shown to customers as their plan name.
- Skipped by default: today a "plan" is simply the customer's own limit and terms.

### Later (not planned yet)

- **Orders link:** charges created from the shipper / order system instead of typed in.
- **Pay online:** a payment provider, with safe handling of retries and duplicate notices.
- **Automatic approval** of small limits by rule.
- **Database row-level security** as a second lock behind the application checks.

## 5. What customers may see

| Customer sees | Never |
| --- | --- |
| Their limit, available, percent used | Other customers, any internal figure |
| Their terms, next due, past due and age | Internal notes, the audit trail |
| Their charges, payments, credits, corrections | Voided entries, which staff member did what |
| Their application and request status | The reason for a denial, review comments |

## 6. How it will be proven safe

- **Unit:** the portal mapper cannot return a field that is not whitelisted (fails if an internal field is added to the
  source type without a decision).
- **Database tests:** try to read or change another customer's data by every portal route; a staff session is refused by
  portal APIs and the reverse; lockout, invite expiry and single use; concurrent requests recorded once.
- **Browser tests:** two customers signed in at once, each trying the other's data by editing the URL and the request;
  apply, verify and track; request and decision; accessibility and the security policy, as for the staff app.
- **Abuse test (Phase 2):** a burst of submissions is limited.

## 7. Decisions and defaults

| # | Decision | Default used here | If it changes |
| --- | --- | --- | --- |
| 1 | Which system is the record of what customers owe: this app or the accounting software | **Open.** Phase 1 shows this app's figures | Customers would see numbers that may differ from your accounting; decide before launch |
| 2 | Trade credit or interest-bearing loan | Trade credit | Interest and fees need a new money model |
| 3 | Plans: own limit only, or fixed tiers | Own limit and terms (Phase 5 optional) | Add Phase 5 earlier |
| 4 | Customers apply themselves | Yes (Phase 2) | Drop Phase 2 |
| 5 | Approval manual or by rule | Manual | Add a rule engine later |
| 6 | Email service | None yet: admin copies the invite link and sends it | Phase 4 needs one |
| 7 | Contacts per customer | Several | One login per customer is simpler |
| 8 | Write-offs shown as | "Credit applied" | Hide them or show as written off |
| 9 | Site address | Same site, under `/portal` | Own subdomain is a small change |
| 10 | Pay online | No | A whole new phase |
| 11 | Sign-in page | One page for staff and customers, separate accounts and sessions behind it | Fully separate pages are simpler to secure but two doors to maintain |
| 12 | Admin "view as customer" | Not in Phase 1; later, read-only and audited | Useful for support; needs care so it cannot write |

## 8. Risks

- **Showing wrong numbers to customers.** Mitigation: Decision 1, and reuse the tested figures.
- **Customer sees another customer's data.** Mitigation: Principle 1, the cross-customer tests, and later row-level
  security.
- **Public form abused.** Mitigation: Phase 2 protections; the form ships only after they are tested.
- **Scope growth.** Mitigation: each phase is separate; Phases 4 and 5 and "Later" are only started on request.
