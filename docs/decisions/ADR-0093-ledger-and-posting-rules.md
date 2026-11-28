# ADR-0093: The ledger, posting rules and the account map

Date: 2026-11-25
Status: accepted (owner-ratified doors 2026-11-25; Opus design read, check and confirm while Fable was rate-limited)
Tier: Critical (new platform tables in `db/migrations`, a storage trigger on module tables, money at rest)
Amends: ADR-0083, on purpose. Related: ADR-0084 (unchanged). See §1.

## Context

The owner wants a small business not to need QuickBooks Online (QBO), with a QBO connector as the other choice, for
any record type the in-app AI builds with no code. The ACCOUNTING-1 charter (revision 2, 2026-11-24) was approved by
Fable's review and targeted check; the check left notes A-F for this ADR. Plan §12.9 says a ledger pack needs
"double-entry invariants, periods, posting/reversal, currency, dimensions, reconciliation, permissions, close, audit,
and regulatory evidence", and §10.6 makes accounting posting and ledger effects platform-owned. This ADR is that
admission. It is self-contained: the charter is cited for reasons, never for a binding rule.

**Owner answers (2026-11-24/25), binding:** QBO receives journal entries only. Receivable and payable go to QBO
clearing accounts (option A, question N1). Canada first, GST+PST provinces (BC, SK, MB) first (question N2). No
inventory value and no cost of goods sold (COGS) in v1. Currencies stay separate in v1, with no conversion.

## Decision

### 1. What this amends

- **ADR-0083** says an issued invoice "creates no journal entry, revenue recognition, inventory movement, cost relief or
  accounting balance" until "a future N6 ledger pack" admits posting. This ADR is that pack. **Order-origin invoices
  post from slice 1b; billing-origin invoices post from slice 5**, which also brings deferral over a service period.
  Until then the 1b invoice rule holds a billing-origin invoice in Unposted as "awaiting slice 5": it neither posts
  revenue on issue nor is silently excluded. Still true: no inventory movement and no cost relief; ADR-0017
  (movements never carry money) is unchanged.
- **ADR-0084 is not amended.** "No new event denotes a financial journal posting" stays true (the poster reads committed
  source versions, §5, never a Receivables event), and "grants ... neither a general operation-chaining mechanism nor a
  ledger" still holds of ADR-0084 itself.
- The docs lane that lands this ADR adds to ADR-0083: "Amended by ADR-0093: order-origin invoices post from slice 1b,
  billing-origin from slice 5." It adds to ADR-0084: "Related: ADR-0093."

### 2. Posting rules and the account map are typed platform configuration

A posting rule says: "while this record is in these states, the books hold these amounts against these roles". The
poster posts the **difference** between that desired position and what is already posted. Rules and the map are
typed, versioned platform configuration under §10.6: tenants choose values, never code.

- **Member.** One add-only Customize member `addPostingRule` (stable ID, `schemaVersion`, closed payload), plus
  `endPostingRule` and `addAccountRole`. First-party Receivables and Payables declare rules as authored data in the
  same shape; generic posting code never names a module.
- **Rule shape.** Source: record type ID, optionally one line-table ID; owning company required. Condition: states,
  a choice field's options, or "while live" (the UI-CUSTOM-1 condition block). Date: a declared date field, or the
  business day the source version committed (only when no date field is declared). Effective date. Legs: side, role,
  optional qualifier, and an amount that is one stored money field, the sum of one stored line field, or `balance`
  (at most one). Optional recognition over [start field, end field) through a holding role.
- **Legs read only values stored on the record or its own lines**, never through a relation and never a calculated
  value. A per-line role is a stored role-reference field. A negative amount posts on the opposite side. Explicit legs
  that do not balance hold the record as "unbalanced".
- **Compiler refusals.** More than one currency source; unknown field or role; a control role on a type that does not
  own that subledger; a revenue leg on a type that is also `addBillableSource` (the invoice posts it); retiring a
  field an active rule reads.
- **Added rule versus replacement (note D-b).** A rule declares either `succeeds: <ruleId>` or nothing. A rule that
  declares nothing is an *added* rule (a Deposit's "Forfeited" rule, a second currency leg). It is refused if it shares
  a (role, qualifier, side) leg, **whatever the amount source**, with an active rule on the same type, unless the
  conditions are provably disjoint (otherwise assumed to overlap), the currency sources differ, or it declares
  `alsoPosts: <ruleId>` and the confirmation preview shows the combined Dr/Cr. Opposite sides pass (a forfeit debits
  what "Received" credits). So "Cr revenue sum(lines.net)" plus "Cr revenue header.subtotal" is refused; AI-BUILD-1
  carries that negative case. A successor posts nothing until positions move to it by re-post.
- **Ended rule (note D-a).** `endPostingRule` freezes positions at its effective date: no further differences and no
  unwinding. The poster still evaluates frozen records; if the desired position would have moved (a void after the end
  date), the record appears in Unposted as "rule ended" instead of being dropped. A release rollback that removes a
  rule freezes the same way, shown as "rule not in the active release".
- **Moving positions.** Only two confirmation-class operations: **re-post** (chosen records to a successor rule or
  version, or to the same rule version under the current map) and **reclass** (an account balance to another account), each bound to the release fence and the exact
  decision digest. Reclass also re-points every affected posted position from the old account to the new one in the
  same transaction and records that in the entry, so a later decrease unwinds into the new account. A record pins its
  rule version at first posting; a new version never silently re-posts history.
- **Date move (note D-c).** Editing the declared date reverses at the old date and posts at the new one: two entries
  under one source version and currency, told apart by the accounting date in the key (§6). If either date is
  closed, the record holds as "date moves across closed books".
- **Account map.** One versioned map and one destination per company; a binding maps a role (optionally a qualifier
  value and a currency) to an account, written only by the map operation. Class fit and active account are checked at
  binding, entry and send. A tenant role with no direct binding uses its parent's, and the map screen shows which.
- **Authoring.** Drafter descriptions are generated from each member's schema, with AI-BUILD-1 cases. The assistant
  reaches chart, map, books start, close, re-post and reclass only through released Semantic Operations; a person
  confirms each change.
- **Releases (rule 13).** Each member's key is optional and emitted only when declared; it takes the next reader rung
  at merge. First-party rules are a base move replayed under ADR-0085. If the shape cannot ride the adopted profile, it
  joins PROFILE-V3-ADOPT.

### 3. The role list and permanent IDs

Core role IDs are `northstar.ledger:role.<name>`, following the repository's `<namespace>:<kind>.<name>` form. Tenant
roles from `addAccountRole` live in the tenant's customization namespace (names are snake_case; the charter's
camelCase names were illustrative); the compiler refuses a tenant role ID under
`northstar.`, so a future core role cannot collide. A tenant role names a non-control parent core role and inherits
its class and normal balance. Labels are display text and may change; IDs, classes and normal balances may not.
Normal balance drives display sign and the "abnormal balance" warning; class drives the binding check.

| Class | Role name (normal balance; * = control role, posted only by its subledger owner) |
| --- | --- |
| Asset | cash (Dr), undeposited_funds (Dr), receivable* (Dr), tax_recoverable (Dr), prepaid_expense (Dr), inventory_asset (Dr), fixed_asset (Dr), other_current_asset (Dr), supplier_prepayments* (Dr), supplier_credit* (Dr), currency_clearing (either sign) |
| Liability | payable* (Cr), tax_payable (Cr), deferred_revenue (Cr), customer_deposits* (Cr), customer_credit* (Cr), accrued_liability (Cr), other_current_liability (Cr), loan (Cr) |
| Equity | owner_equity (Cr), retained_earnings (Cr), opening_balance (either sign) |
| Income | revenue (Cr), other_income (Cr), discounts_given (Dr, contra-income) |
| Expense | expense (Dr), cost_of_sales (Dr; manual journal only in v1), other_expense (Dr), bank_fees (Dr), rounding_difference (either sign) |

Control owners: receivable, customer_credit and customer_deposits belong to Receivables and its customer balance;
payable, supplier_prepayments and supplier_credit belong to Payables and its supplier mirror. Manual journals cannot
post to a control role. Qualifiers come from a stored field: `tax_payable[component]`, `tax_recoverable[component]`.

**Canadian starter (owner N2).** The 1a starter chart and tax codes cover GST plus PST for BC, SK and MB (Manitoba's
RST). Starter default: GST is recoverable only for a GST-registered company (registration is tax-lane company data),
posting to `tax_recoverable`; for an unregistered small supplier it is a cost. PST/RST is not recoverable and posts to
**the line's own debit role** (expense, or `inventory_asset` on a first-party stock bill). The poster posts the frozen
recoverable amount per component (§10), so a partial claim such as 50% on meals needs no arithmetic here. Rates and
recoverability are tax-lane data, not this ADR, and a company can change them. HST and QST provinces follow.

### 4. The journal line shape and money at rest

New platform tables in `db/migrations` (number taken at merge per MIGRATION-RULE).

- **Entry:** entry ID; company; currency (ISO 4217 code); accounting date; recorded time; kind
  (`posting | recognition | repost | reclass | opening | manual`; a re-route is a `repost` with reason "not delivered"); source type ID, record ID and source version
  (null for manual and opening-balance entries); rule ID and version; map version; reason code; per-company entry
  number (§7); inputs digest.
- **Line:** entry ID; line number; account ID; role ID; qualifier; side (`D` or `C`); currency (ISO 4217 code);
  amount as a positive `bigint` count of that currency's minor units; **counterparty party ID** (reserved, nullable); **dimension-set ID** (reserved, nullable).
- **Reserved columns.** In v1 a storage check refuses a non-null counterparty or dimension set. Lines are append-only,
  so the columns exist now and a later ADR relaxes the check (counterparty for QBO option B or party ledgers;
  class, location and department for the dimension set).
- **Money (owner door 1, ratified 2026-11-25).** Side plus a positive `bigint` count of the currency's own smallest
  unit, its ISO 4217 minor-unit exponent (cents for CAD, USD and EUR; zero- and three-decimal currencies work the same
  way). Each line carries its currency, so the exponent is fixed by the currency through a pinned platform currency
  table; the line's currency must equal the entry's. A source amount finer than the currency's minor unit is never
  rounded: it holds as "unrepresentable amount". The one computed split is recognition: earned through day D is
  floor(total x elapsed days / total days) in BigInt, and the last period takes the remainder, so a replay is
  bit-identical.
- **Storage invariants, checked before commit by a deferred constraint trigger:** one currency per entry, at least two
  lines, debits equal credits, every amount positive, every line's account belongs to the entry's company. A trigger
  refuses UPDATE and DELETE on both tables, and those privileges are revoked from every role.
- **Writers.** Only SECURITY DEFINER functions with `search_path = pg_catalog, pg_temp`; no runtime table grants;
  RLS on; the stored company is checked. Tenant workflows, rules, imports and generic CRUD cannot write these facts.
  **The one entry writer, used by the poster and every operation**, takes the company closed-through row FOR SHARE and
  refuses any accounting date on or before closed-through, and any date before books start except kind `opening`
  (rule-8 red test per refusal). So manual, opening, re-post and reclass entries cannot bypass close.
- **Implementation note (slice 1a-i, 2026-11-25, rulings R7a and A3).** One currency per entry and the entry's own
  company are composite foreign keys, and positivity is a check; the deferred trigger keeps at least two lines and
  debits equal credits. Each is stricter than the trigger wording and has its own red. Both §6 keys are partial unique
  indexes (posting kinds; operation kinds) with exactly the stated columns and `NULLS NOT DISTINCT`, so one kind's
  null columns never collide on the other kind's key; the partial predicate is part of the unchangeable key shape.
- **Amended 2026-11-28 (DOCUMENT-POSTING slice 1, design read amendment 8).** A manual or opening entry posted from a
  staged document stores that document: its header entity as source type ID, its record ID and the header revision the
  person confirmed. A unique partial index on (company, source type ID, record ID, entry ordinal) for those two kinds
  is the backstop behind the document's state field (`ledger.documentPosted`): one document makes at most one entry per
  ordinal. Manual and opening entries made without a document keep a null record ID. Staged amounts are exact decimals
  (precision 18, scale 4) converted once in SQL to whole minor units; zero, negative and finer-than-minor-unit amounts
  refuse by name and are never rounded.
- **Alongside:** posted position per (company, record, rule, role, qualifier, currency, account), held queue, chart,
  map, closed-through date, books-start date and the balance projection (§9).

### 5. Source version and the line-set counter (note B)

A line write does not bump its parent's revision, so the **source version** is the pair (header revision, line-set
version). **It is a storage trigger, not a writer convention** (note B: the interpreter, template lines, ten provider
files with their own SQL and the backfill all write lines; a writer audit would go stale, a trigger cannot be bypassed).

- **A compiled storage element, `createSourceVersionTrigger`**, emitted only for the header and line tables of a type
  with an admitted posting rule. The materializer's live-catalog verifier derives the expected trigger from target
  data like any other element, so it is not catalog drift and a pointer rollback stays attributable (the union-live-root
  ruling). Writer-side emission (WORKFLOW-2's route) is rejected: note B's ten provider files and the backfill are why
  the trigger exists. **Its reader rung ships one deploy ahead** of any release that declares it (ADR-0090, ADR-0085),
  so an older binary refuses that release by name, never the database by drift.
- **What it writes.** A deferred constraint trigger fires per row, so it upserts on the dedupe key (tenant,
  environment, record, transaction ID): one **source-version row** per record per transaction, for header-only and
  line writes alike. On that row's first insert, the same trigger advances the record's counter row once, allocating
  the line-set version (when lines changed) and the per-record sequence. Row: (company, record, header revision, line-set version,
  sequence, commit business day, posting inputs).
- **Posting inputs:** the whole stored header row plus its live line rows, since a trigger cannot tell which fields a
  rule reads; the poster selects what the pinned rule needs. A payment moves an invoice's revision with no change
  document of its own, so change documents cannot be the source.
- **Seeding.** The transaction that creates the trigger also seeds one source-version row per live record, holding the
  header and line tables IN SHARE MODE, so no concurrent writer can slip between seed and trigger and no record that
  existed before installation goes unseen. The trigger reads posting inputs in a statement after it takes the
  counter-row lock, so a version's sequence and its inputs always match.
- **Carried forward.** Once a type holds positions (an ended rule counts), every later release emits the element for
  it. A rollback below the first rule-bearing release is refused while positions exist. The element is additive in
  `mergeCompatibleEntity`, so a live set holding a release with the rule and one without it does not conflict.
- **Catalog shape.** The element emits both the expected trigger and its expected `pg_constraint` row (contype `t`,
  deferrable, initially deferred), because the verifier's constraint query has no contype filter.
- **Access.** The source-version table has company RLS, no runtime grants, and is unreachable from report, query and
  assistant paths, so field narrowing (ADR-0071, ADR-0089) cannot be bypassed through the snapshot.
- Line writers lock the parent FOR SHARE, then the counter row, so each record's versions have one order. A backfill
  fires the same trigger and gets its own source version. No writer may set `session_replication_role` (structural
  test). The 1b audit no longer gates the design; it lists every money fact and checks the trigger on each rule table.

### 6. The poster, ordering and the unique key (note A)

The poster is a platform consumer, not a tenant workflow. **Ordering words, ruled:** "in commit order", "by cursor" and
"posted through" in the charter mean: **per record, by source-version sequence, with due work found as source-version
rows that have no disposition** (ADR-0073's pattern). No ID or time is ever a high-water mark, because rows become
visible out of order. Final dispositions are posted, nothing to post, frozen and "superseded by vK". **Held is not
final.** When a later version vK exists, the poster disposes every earlier version held for a reason in the record's
own inputs (the input-derived list below) as "superseded by vK" in the same transaction and evaluates only vK; that
is safe because desired minus posted depends only on state, and commit-day rules date at vK. **External holds** (the
external list below) still block later
versions, shown as "waiting on held version n", until cleared. A re-post or freeze disposes the holds it covers.

- **One difference.** Compute desired legs at role level (role, qualifier, currency); subtract the posted position;
  write one entry per currency. An increase resolves accounts through the current map; a decrease unwinds the
  accounts it was posted to, most recent first (after any reclass re-pointing). A map change never reclassifies
  history. An unwind into an inactive account holds as "account inactive", with reclass as the named exit.
- **Dating.** A rule with a date field dates every difference by that field. Only a rule without one uses the
  source version's commit business day, so dates never depend on poster lag.
- **Unique keys, both `UNIQUE NULLS NOT DISTINCT`** (precedent: the booking commitments migration), because
  recognized-through is null on `posting` entries. `posting` and `recognition`: (tenant, environment, company, record,
  rule ID, rule version, source version, currency, accounting date, recognized-through date, kind). Operation entries
  (`repost`, `reclass`, `manual`, `opening`): (tenant, environment, company, operation receipt ID, entry ordinal); a
  reversal and its replacement differ by ordinal. A rule-8 red races two posters on one source version.
- **"Posted through T"** means every source-version row visible to a snapshot taken at T has a disposition. Close
  checks it in its own transaction; reports print the last T at which it held ("posted through 10:42").
- **Lock order:** (company, record, rule) ascending; the record; the company closed-through row FOR SHARE; balance
  rows ascending; the per-company entry-number counter row last. Close takes only the closed-through row FOR UPDATE.
  READ COMMITTED writers carry the isolation guard. Tests use two companies in one tenant, company-scoped principal.
  **Amended 2026-11-25 (slice 1a-i, ruling R4):** the full order is (company, record, rule) ascending; the record; the
  company closed-through row FOR SHARE; the company account-map row (slice 1a-iii); the entry's account rows ascending
  FOR SHARE; balance rows ascending, upserted in key order including rows that do not exist yet; the counter row last.
  Close and provisioning each lock one row FOR UPDATE and nothing else. The books operations (books start, an account
  put, chart setup; migration 0074) lock, ahead of this order: the grant row FOR UPDATE; the active release pointer FOR
  SHARE; the policy epoch FOR SHARE; the company's legal-entity master row FOR SHARE; then the company row (FOR UPDATE
  for books start only, FOR SHARE otherwise); then account rows in account-code order.
  **Amended 2026-11-28 (DOCUMENT-POSTING slice 1).** The document post (migration 0077) locks: the grant row
  FOR UPDATE; the active release pointer FOR SHARE; the policy epoch FOR SHARE; the posted document's header FOR NO KEY
  UPDATE (which a line writer's parent FOR SHARE conflicts with, so the line set is fixed to commit); the header
  company's legal-entity master row FOR SHARE; then the journal order above. "The record" before the master row is
  this section's position; no writer takes a master row and then a document header.
  **Corrected 2026-11-26 (1a-i review, R4):** this order is acyclic only for a transaction that makes ONE writer
  call. "Counter last" holds per call, not per transaction: after entry 1 a transaction holds the counter, and entry
  2's balance (or record) rows can be held by a writer that waits on that counter, so two entries in one transaction
  can deadlock. Until the fix, no caller makes two writer calls in one transaction. The fix lands before the first
  multi-entry write (slice 1b: one entry per currency; re-post's reversal and replacement): every lock that precedes
  the counter is taken for the whole transaction, in this order, before its first counter take.
- **Holds, never drops.** All 15 reasons, classified:
  - *Input-derived (superseded by a later version):* unbalanced, unsupported currency, unrepresentable amount, source
    unreadable, tax evidence missing, rule ended, date moves across books start, predates rule.
  - *External (blocks later versions until cleared):* unmapped role, closed books (here or in QBO), account inactive,
    rule not in the active release, date moves across closed books, awaiting slice 5, and waiting on held version
    (which lasts exactly as long as the external hold before it).
  Holds show in an Unposted worklist and as a count on every financial report; a map change,
  reopen or record change re-runs them.

### 7. The external-ledger contract, QBO first

The destination is `native | externalLedger`, and an external ledger is a connector installation that implements this
contract; no vendor name is a persisted enum value. The contract: list accounts with their types and active flag;
validate a binding's type; create one entry idempotently under an external reference; find an entry by that
reference; read the closing date; read changes since a point (QBO change data capture); declare capabilities
(home currency only, party lines supported or not).

- **External reference.** QBO's DocNumber holds about 21 characters, so the key in §6 cannot be sent. Each entry gets
  a per-company entry number at write time; the reference is a short prefix plus that number. The prefix is fixed
  per destination at books start, as protection against other writers to the realm. **One company per QBO realm ID**,
  enforced platform-wide across tenants and environments: binding a second company (or a sandbox environment) to a
  realm already bound is refused, because shared clearing accounts would break each company's reconcile and mix two
  legal entities' P&L and GST/HST. Lookup by reference runs before any resend.
- **QBO (option A, ruled).** One journal entry becomes one QBO JournalEntry; nothing else is sent. Receivable binds to
  an Other Current Asset and payable to an Other Current Liability ("Receivables, kept in 2rain"), because QBO refuses
  A/R and A/P lines without a customer or vendor. No contact sync. Only home-currency entries are sent; any other
  currency holds as "unsupported currency". Entries dated inside QBO's closing date hold as "closed books".
- **Sending.** The sender finds entries with no send disposition and never writes the journal. v1 sends as a
  human-confirmed batch bound to the entry set's digest and the release fence; unattended sending waits for an N5
  grant (ADR-0080). Retry follows ADR-0080 (leased worker, bounded backoff, per-realm quota).
- **Permanent refusal and re-route (note F).** A refused entry is marked "not delivered". The person picks one
  confirmation-class exit: **re-route**, which calls the slice-1c **re-post** operation with reason "not delivered"
  (a local reversal, given a "local only" send disposition in the same transaction so it is never sent, plus a
  replacement under the current map that is sent), or **mark entered by hand in QBO** with
  evidence. So slice 3's sender stays read-only on the journal, and slice 3 now depends on 1c. Re-post may target
  the same rule version under the current map. Re-post is record-based, so a not-delivered manual, opening or reclass
  entry has only the "entered by hand" exit in v1.
- **Cutover double counting (note E).** If QBO already holds the open invoices and bills, the opening entries count
  them twice (once in QBO's own A/R and A/P, once in the clearing accounts). The QBO books-start operation shows both
  totals side by side and requires the person to acknowledge that the accountant clears QBO's own A/R and A/P against
  opening equity; reconciliation lists "QBO A/R or A/P not cleared" while either is non-zero.
- **Reconciliation.** Daily and on demand: balances compared only on accounts nothing but 2rain posts to (the
  clearing accounts); entries compared one by one elsewhere; differences listed; QBO never overwritten.
- **Sandbox checks before slice 3 claims them:** party rules on A/R and A/P lines; request idempotency; tax fields on
  lines in a Canadian company and the GST/HST return; **a line posted straight to QBO's GST/HST agency account**; the
  closing date; several A/R lines per entry; DocNumber query; change data capture. CI uses a network-free fake only.
  QBO's own ADR (required by ADR-0080's "Later connectors") and CONNECT-OUTBOUND-1 are still owed.

### 8. Books start, periods and close

- **Books-start date.** Per company, confirmation-class. Records dated earlier never post under their own rules. Items
  open on that date post through an opening rule declared by the subledger owner (Dr receivable, Cr opening_balance per
  open invoice; the mirror for payables). **The opening rule's desired position is live**: the item's open amount while
  it is open. So a later payment, void or credit of a pre-start invoice posts as a difference at its commit day, and the
  GL receivable keeps matching aging. A date edit across books start holds as "date moves across books start". An
  added rule that would unwind a role for a record predating the other rule's effective date (Forfeited on a
  pre-effective deposit) holds as "predates rule"; it never posts one-sided. Other balances enter as one
  confirmation-class opening entry against opening_balance. Changing destination is a new books start: the old journal
  freezes at cutover and the new destination gets opening balances.
- **Periods are a closed-through date per company**, the same mechanism as the inventory lock and separate from it;
  reports show both. Months and the fiscal-year start are a reporting calendar, not the lock. An entry dated on or
  before the closed-through date holds as "closed books"; the person may confirm "post on the first open date".
- **Close** is confirmation-class and waits until "posted through" covers the close's snapshot. It refuses while
  recognition has not run through the date, held items are dated before it, or reconcile fails, unless the person
  acknowledges the count. **Reopen** lowers the date, is confirmation-class and audited.

### 9. Native ledger and §12.9 admission

The balance projection holds one row per (company, account, currency, accounting month), so a fiscal-year-start change
(reporting-calendar data) needs no rebuild; fiscal views sum months. It is written and checked by the poster
in the same transaction, rebuildable as a sum of lines, with its own recordedAt horizon (ADR-0057). The trial balance
is balance-sheet accounts cumulative, income and expense for the fiscal year to date, and one computed "prior years'
earnings" row. Aging comes from subledger open items, never the GL.

| §12.9 word | Ruling | Checked by |
| --- | --- | --- |
| Double entry | One currency per entry, debits equal credits, positive amounts, two or more lines | Deferred storage trigger; red tests per check |
| Periods / close | Closed-through date; close waits for "posted through" | Lock-order and close tests; two companies |
| Posting and reversal | Desired minus posted; correction only by a new entry, re-post or reclass | Append-only trigger; unique key |
| Currency | Separate per currency; `currency_clearing` per currency; no rate, no gain or loss | Storage check; compiler one-currency rule |
| Dimensions | Company only; dimension-set column reserved and null | Storage check refuses non-null |
| Reconciliation | Nightly projection verify; GL control total versus aging; QBO reconcile | Production callers tested |
| Permissions | Chart, map, books start, close, reopen, re-post, reclass, manual journal and send are confirmation-class with write or confirm grants, bound to fence and digest | Gateway tests; no runtime grants |
| Audit | Every entry carries rule, map and source version and inputs digest; operations write trust rows | Catalog test of revocations |
| Regulatory evidence | Tax posts from frozen components only; GST/HST/PST summary in slice 2; nothing is deleted | TAX-EVIDENCE-1 gate on 1b |

### 10. TAX-EVIDENCE-1 additions (note C) and other dependencies

TAX-EVIDENCE-1 (owner: Receivables/Payables lane) gains four items, all needed before slice 1b's rules compile:
1. **A stored currency on payment and credit records**, which have none today, so their rules have a currency source.
   (The charter's claim that Receivables already refuses a payment in another currency is withdrawn.)
2. **A frozen recoverable amount per tax component on the line**, computed by the tax lane from the code and the
   company's GST registration, so a partial claim works and the poster never multiplies or rounds.
3. **Tax component amounts as line fields**, because a rule reads one line table.
4. **A revenue role frozen on each invoice line** (a stored role reference), so first-party sales can post to more
   than one revenue account.

Other packets stand as chartered: OPEN-ITEM-1 and TAX-DETERMINATION-1 before slice 4, CONNECT-OUTBOUND-1 before slice
3. Slice order is the charter's, with two changes: slice 1b builds the §5 trigger and snapshot, and slice 3's entry
conditions add slice 1c.

## Consequences

- Any record type can post with no code; the journal is the one posting stream for native books or QBO.
- A QBO-mode company loses in QBO: customer and vendor balances, aging and statements; T5018/T4A totals; possibly the
  GST/HST return; cash-basis reports; bank-feed matching to invoices; and must clear QBO's own A/R and A/P at cutover.
- The trigger adds a counter write and a snapshot row per record per transaction, only on tables of types with a
  rule; 1b measures it on a no-rule tenant (expected unchanged) and on the invoice journey.
- The money format, the role IDs, both key shapes (§6) and the reserved columns cannot change once rows exist. Before the first
  production tenant, ADR-0066 lets the lineage re-baseline, but `db/migrations` stays append-only.
- Rollback of a release freezes positions; it never deletes or edits journal rows.

## Owner ratification needed

These two are one-way doors: once real books exist, changing them means rewriting every stored entry.

**Door 1: how money is stored in the journal. Ratified by the owner, 2026-11-25.** Every amount is stored as a whole
number of the currency's own smallest unit (its ISO 4217 minor unit: cents for CAD, USD and EUR; a zero- or
three-decimal currency works the same way), with a separate debit-or-credit marker. Each journal line carries its
currency, so the currency fixes how many decimals the number means. So $105.00 is stored as 10500, debit, CAD. The
rejected alternative was storing decimals like 105.00 directly: whole numbers cannot drift or round, add up exactly,
and make "debits equal credits" a simple check. A fraction of the minor unit is held for a person, never rounded.

**Door 2: the permanent names of account roles. Ratified by the owner, 2026-11-25.** A role is a kind of account ("revenue", "tax payable", "receivable")
that rules post to; your account map says which real account each role means. The role's internal name (for example
`northstar.ledger:role.tax_payable`), its class and its normal side are permanent, because every posted line stores
it. Labels on screen, and which account a role maps to, can change any time. The list in §3 includes the supplier-side
roles (supplier_prepayments, supplier_credit) and other_expense. Adding roles later is always possible; renaming or
removing one is not. The §3 list is ratified as written.

## Evidence

- Charter ACCOUNTING-1 revision 2; Fable REVISE (14 findings) and targeted-check APPROVE with notes A-F, all ruled here
  (A §6, B §5, C §10, D §2, E §7, F §7). Design read of this ADR (Opus, AMEND, 11 findings) and its targeted check (AMEND, A-E plus two notes), all applied.
- Code facts: line writes and payments do not bump the parent's revision (`module-runtime-interpreter.ts`,
  `settlement-capability-executor.ts`); catalog verification of every module trigger and the backfill
  (`module-storage-materializer.ts`); the inventory lock (`inventory-posting-service.ts`); BigInt cents
  (`commercial-amounts.ts`); tax codes without components (`app/builder.ts`).
- Patterns reused: ADR-0083's "earned minus allocated", ADR-0057's rebuildable sum, ADR-0073's disposition consumer.

## Enforcement

- **Storage:** deferred balance/currency/positivity trigger, append-only trigger, revoked privileges, both
  `NULLS NOT DISTINCT` keys (with a two-poster race red), reserved-column null checks, the entry writer's closed-through
  and books-start refusals; each with a red test that fails when the check is removed (rule 8).
- **Poster tests:** a held version never computes against a later position; reclass re-points positions; a pre-start invoice voided after
  books start moves the opening position; a billing-origin invoice holds as "awaiting slice 5".
- **Compiler:** the refusals in §2 (currency source, control roles, billed-type revenue, same-side overlap whatever
  the amount source, tenant role under `northstar.`, retired field read by a rule); drafter coverage for the members.
- **Catalog and release:** the verifier expects `createSourceVersionTrigger` and its contype-`t` constraint exactly on
  tables of types that have or held positions; the rung binary reads and verifies the element, and a binary older
  than the rung refuses by name (rung test through the archived loader). Red tests: a writer racing the seed, a
  rollback below the first rule-bearing release refused while positions exist, a mixed live set merging cleanly.
- **Poster and connector tests:** an input hold is superseded by a later version; an external hold blocks; a second
  company binding a bound QBO realm ID is refused.
- **Structural tests:** no writer sets `session_replication_role`; no generic posting code names a module; the
  snapshot table is absent from report, query and assistant sources; the core role list is pinned, and a test refuses
  a removed, renamed or reclassed role ID.
- **Gates:** this ADR is accepted, so slice 1a may start; 1b waits for TAX-EVIDENCE-1 with the four §10 items and
  for the §5 rung to be deployed; slice 3 waits for 1c, CONNECT-OUTBOUND-1, QBO's own ADR and the sandbox list. Each
  slice gets an independent review.

### Slice 1a implementation notes (from the confirm read; no ADR re-read needed)

1. **Seed locks.** Take the header and line tables in one LOCK statement, in a fixed order, directly in SHARE ROW
   EXCLUSIVE mode (what CREATE TRIGGER needs, so there is no SHARE upgrade), under `lock_timeout` with retry. While it
   waits, new writers queue behind it.
2. **Snapshots.** Pin the seed transaction to READ COMMITTED, as the materializer's `createIndex` path already does, so
   the seed reads a fresh snapshot after the lock (under REPEATABLE READ the advisory-lock SELECT would freeze the
   snapshot before the LOCK and reopen the seed race). The trigger function is VOLATILE, so its post-lock statement
   takes a fresh snapshot.
