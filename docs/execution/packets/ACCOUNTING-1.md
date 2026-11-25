# ACCOUNTING-1 · Books for any record type, kept natively or in QuickBooks Online

**Slice 0 · Design accepted, 2026-11-25; slice 1a may start.** Docs only, no code and no Critical path touched. The owner wants a small business not to need QuickBooks Online (QBO), with a QBO connector as the other choice, for any record type the in-app AI builds. [ADR-0093](../../decisions/ADR-0093-ledger-and-posting-rules.md) admits the ledger against plan §12.9 and amends [ADR-0083](../../decisions/ADR-0083-period-and-usage-billing.md) on purpose; [ADR-0084](../../decisions/ADR-0084-receivables-billing-origin-drafts.md) is related, not amended. The charter (revision 2, 2026-11-24) is `/home/rvham/2rain-missions/charters/ACCOUNTING-1-charter.md`; its reasons, findings F1–F14 and risks stay there, and every binding rule is in the ADR.

**Reviews.** Charter by Fable (REVISE, then targeted check APPROVE with notes A–F). Fable was rate-limited for the ADR, so Opus did the ADR design read (AMEND, 11 findings), its targeted check (AMEND, A–E plus two notes) and the confirm read; all findings are applied in the ADR.

**Owner answers, 2026-11-24/25.** QBO receives journal entries only. Receivable and payable go to QBO clearing accounts (option A, N1). Canada first, GST+PST provinces (BC, SK, MB) first (N2). No inventory value and no cost of goods sold in v1. Currencies stay separate, with no conversion.

**Ratified one-way doors, 2026-11-25.** Door 1: every journal amount is a whole count of the currency's ISO 4217 minor unit with a separate debit-or-credit marker and the currency on each line. Door 2: the core role list and its permanent IDs (`northstar.ledger:role.<name>`), classes and normal sides, as written in ADR-0093 §3.

CI tier: quick RUNLINK

## Dependency packets (not yet chartered; each needs an owner lane before the slice that needs it)

| Packet | Owner | Needed by |
| --- | --- | --- |
| TAX-EVIDENCE-1: tax codes with components and a recoverable flag; code and frozen component amounts on invoice and bill lines and charges; credits with lines and tax evidence | Receivables/Payables | Slice 1b |
| OPEN-ITEM-1: any record type declares an open item of a subledger | Receivables/Payables | Slice 4 proofs |
| TAX-DETERMINATION-1: platform tax determination on a tenant money field | Platform tax | Slice 4 taxable proofs |
| CONNECT-OUTBOUND-1: general outbound connector runtime, host-owned OAuth refresh, bound vault, QBO connector ADR | Connector owner | Slice 3 |

Also gated on CUSTOMIZE-6 slices 1 and 2, REPORTS-1 slice 2, BILLING slice 3, Receivables v2 and the B3 customer balance (see the table).

## Slice plan

Slices that write the journal run one after the other (AGENTS §3). Each slice ends with Test it yourself, a rule 17 statement and rule 8 reds, and gets an independent review.

| Slice | What the business gets | Entry conditions |
| --- | --- | --- |
| 1a · Ledger core | Journal, Canadian starter chart, account map with validation, books-start date, manual journal, trial balance and GL detail. An accountant can keep books by hand. | ADR-0093 accepted |
| 1b · Built-in documents post | Invoices, payments, credits, voids and bills post themselves through the poster; Unposted worklist; reconcile caller. | 1a, TAX-EVIDENCE-1 |
| 1c · Custom types post | `addPostingRule`, `endPostingRule`, re-post, reclass, `addAccountRole`, with drafter cases. | 1b, CUSTOMIZE-6 s1 |
| 2 · Statements and close | P&L, balance sheet, close and reopen, AR and AP aging, GST/HST/PST summary, vendor payment totals. | 1b, REPORTS-1 s2 |
| 3 · QBO connector on fakes | External-ledger map, human-confirmed batch send, retry, exits, reconciliation. | 1a, 2, CONNECT-OUTBOUND-1 |
| 4 · Any shape of custom type | Line legs, role-reference fields, qualifiers; rental, clinic and field-service proofs. | 1c, CUSTOMIZE-6 s2, OPEN-ITEM-1, TAX-DETERMINATION-1 |
| 5 · Billing cases | Billing-origin posting, deferral and recognition, credit notes, deposits, refunds. | 4, BILLING s3, Receivables v2, B3 |
| 6 · Bank | Statement import, matching, reconciliation report. | 2 |

## Test it yourself

| Slice | Try it after the slice ships | Expected observation |
| --- | --- | --- |
| 1a | Bind roles in the account map, set a books-start date, post a manual journal of CAD 105.00 against cash and revenue, then try one that does not balance. | Trial balance shows 105.00 each side. The unbalanced entry refuses. A role left unmapped is named. |
| 1b | Issue and void a CAD invoice with GST and PST in two companies of one tenant. | Each company posts only its own entries. The void nets to zero by a reversing entry. An unmapped role leaves the invoice in Unposted with its reason. |
| 1c | Customize an Expense claim with a rule: Approved posts Dr Travel expense 100.00, Dr GST recoverable 5.00, Cr Reimbursements owed 105.00. | The review previews those legs. Approving the claim posts them. Editing the amount posts only the difference. |
| 2 | Close through a date, then edit an earlier record. Run the trial balance. | The change holds as closed books. The report shows posted-through time and the Unposted count. |
| 3 | Send a batch of entries to the fake QBO. | One confirmation bound to the entry set. A refused entry shows as not delivered with the two exits. |

## Discriminating proofs for executable slices

- Storage (rule 8): each of the deferred balance/currency/positivity trigger, the append-only trigger, revoked privileges, both `NULLS NOT DISTINCT` keys (with a two-poster race) and the closed-through and books-start refusals has a red that fails when only that check is removed. [ADR-0093 Enforcement](../../decisions/ADR-0093-ledger-and-posting-rules.md#enforcement)
- Two companies in one tenant with a company-scoped principal (rule 2): remove only the company predicate on the poster and observe the other company's entry.
- Poster: a held version never computes against a later position; a pre-start invoice voided after books start moves the opening position; a billing-origin invoice holds as "awaiting slice 5".
- Release (rule 13): an older reader refuses the posting-rule element by name, fed the recorded change, through the archived loader; a rollback below the first rule-bearing release is refused while positions exist.
- Structural: no generic posting code names a module; the core role list is pinned and a removed, renamed or reclassed role ID fails.
- Drafter (rule 12): AI-BUILD-1 live cases for expense claim, deposit, clinic payment, donation and cash sale, plus the negative cases in the charter §3. No live AI spend in slice 0.

## Rule 17

**Most general form:** a typed, versioned rule maps any record's stored money facts, while a declared condition holds, to balanced role-level legs; a per-company map binds roles to accounts; one append-only journal stores the differences. **Used unchanged by** first-party invoices, payments, credits and bills; with OPEN-ITEM-1 and TAX-DETERMINATION-1, every tenant type; and both destinations (native and QBO). **Narrower in v1:** control roles reserved to their subledgers; no tenant receivable or taxPayable credit until its dependency; no inventory value, COGS or currency conversion (owner); company is the only dimension; months are the reporting calendar only; no unbilled-revenue accrual or cash basis; one destination per company, home-currency entries only to QBO, sends human-confirmed until N5; no bank feeds or tax filing. Full list: charter §12.

## Decisions

- Desired position, post the difference (not event rules): voids, edits and replays need no extra rules.
- QBO option A (clearing accounts); native financial statements are not offered in QBO mode.
- ADR number 0093 was free on main at the packet base, so it is kept.
