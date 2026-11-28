# OPEN-ITEM-1 — the order-free open-item core (design note v2, 2026-11-28)

Designed to the owner's seven ratified decisions (2026-11-28). The core is one general block any declared
record type takes on through an `openItem` role. Branch A: the core comes first; billing later supplies lines.
The core names no module. Refs are `file:line` on `origin/main` @32139da unless a branch is named.
**UNVERIFIED** marks claims not traced.

## 1. Declaration shape (optional v6 keys, compiled into the release)
- `openItem` on a record type: `side: debit|credit` (an invoice is debit and a credit note or customer
  payment credit, relative to the counterparty; payables mirror this). Fields it names: `counterparty` (relation),
  `currency` (a create-only field, ADR-0094 Contract 3), `documentDate`, `taxPointDate`, `total` (an ADR-0094
  `rollups` field over the line relation, or a plain amount for a payment), `applied`, `balance`,
  `draftReference`, `number`, and a `stateMachine` with named `issue` and `void` transitions
  (schemas.ts:707-733). The fields `applied` and `balance` are provider-written; no operation input reaches them.
- `openItemApplication` on one record type: `source` (relation to a credit-side item), `target`
  (relation to a debit-side item) and `amount` (positive decimal). One shape covers payment→invoice,
  credit note→invoice and refund→credit, for receivables and payables alike.
- Line amounts come from ADR-0094 `derivedDecimals` (qty × price − discount; a line is never negative,
  decision 4) and the document total from `rollups` (branch packet/LINE-TOTALS-s1, ADR-0094 :42, :89, :152).
- The compiler refuses: a missing role field, a currency that is not create-only, a `total` that is not
  a rollup or amount, an application whose two relations do not land on opposite `side`s, and an `issue`
  transition whose target state is not open.

## 2. Operations (each a `registeredCapabilityEffect`, `confirmation: humanRequired`)
`issue` (draft→open: assigns the number and freezes the figures), `apply` (writes application lines),
`void` (refused while `applied` ≠ 0; voided items keep their number, and nothing is hard-deleted, AGENTS.md §5),
`unapply` (later slice). Draft edits stay ordinary create/update operations without confirmation.
Settlement today has a single-relation `pay`/`credit` and a closed action list
(settlement-capability-executor.ts:56-57, :1221-1300). The core replaces that with one `apply` over lines.

## 3. Numbering (Q1: the block exists for CREATE only, so assign-at-issue is a missing block)
- Evidence: the compiler emits `assignedFields` only when `effectKind === 'createRecordEffect'`
  (projections.ts:2825-2827). The interpreter assigns only for `createRecordEffect`
  (module-runtime-interpreter.ts:2128-2131), called once at :911. The contract comment says the same
  (semantic-operation-gateway.ts:209). The scope is per tenant and environment across ALL companies: the
  lock key is tenant:env:sequence and the max is taken over all of the tenant's rows
  (module-runtime-interpreter.ts:2106-2113, :2164-2174). Decision 2 needs per company, so that is a second gap.
- Smallest general addition: `FieldNumbering` (schemas.ts:2993-2999) gains optional
  `assignOn: { transition: <ref> }` and `scope: 'tenant' | 'legalEntity'`. Absent, a release compiles
  byte-identically (create, tenant). With `assignOn`, the compiler moves the entry onto the operation whose
  `transitionStateEffect` (or open-item `issue` capability) names that transition. The pinned-contract parser
  (semantic-operation-gateway.ts:1886-1938) gains the two keys. Release verification keeps the `V-` sentinel
  path (module-runtime-interpreter.ts:2150-2162; release-verification-service.ts:2392-2397) for transitions.
- Allocator for `assignOn`: a counter row `platform.document_number_counters(tenant, env, legal_entity,
  sequence_id, last_value)` taken FOR UPDATE and incremented in the issuing transaction. A rollback
  returns the number, and voided and archived items keep theirs, so issued numbers are gap-free per
  company per series (one series per record type = per document type). Drafts carry `draftReference`
  through the existing create-time sequence (prefix such as `DR`), unchanged.
- **UNVERIFIED:** whether a number field's business-key unique index is company-scoped. Two companies
  sharing a prefix need it to be (or the prefix must differ per company). Settle in s1a with one red.

## 4. Payment applications and locking (Q2)
- In the data model from day one: application lines (source → target, amount). An item's `applied` is the
  sum of its live application amounts, and `balance = total − applied`, for source and target alike.
  The v1 screen offers one payment → one invoice; the API takes N lines.
- Locks, inside one transaction, in a fixed order: (0) the grant row (§5); (1) the counterparty advisory
  lock, as settlement does today (settlement-capability-executor.ts:855-859); (2) every touched item row
  `FOR NO KEY UPDATE`, sources and targets together, **sorted by record_id**. The current single-row lock is
  :681-692, with a revision CAS at :727-757. Sorting is what makes "one payment across three invoices" and
  "two payments on one invoice" deadlock-free. The second payer blocks on the invoice row and, after the
  first commits, re-reads the new balance (Postgres re-fetches the locked row under READ COMMITTED). It then
  applies or refuses `exceedsBalance` exactly.
- Per line, refuse: different company, counterparty or currency (currency is frozen, decision 5); a target
  not open or partially settled; amount ≤ 0; and over-application on either side. Updates write
  `applied`/`balance`/state with the revision CAS. Before returning, the executor re-selects
  `sum(amount)` per touched item under the held locks and refuses unless it equals `applied`. The gate
  observes the fact, not a proxy (AGENTS.md §5). Application lines are append-only; unapply writes a
  reversing line (s5).

## 5. Confirmation path (Q3), mirroring branch packet/ACCOUNTING-1-s1a-ii
- Gateway: the operation declares `confirmation: 'humanRequired'` (schemas.ts:2774). The gateway carries
  `confirmationGrant` (semantic-operation-gateway.ts:65, :280, :839, :1082).
- Executor (new `open-item-capability-executor.ts`, shaped like ledger-capability-executor.ts:160-240 on
  the branch): `verifyConfirmation` (:173) → refused without grant or human (:185) → attest through the
  approval-issuer pool (:187-202) → `PostgresTrustService.executeIdempotentAcceptedMutation` (:204) → an
  apply definer that consumes the exact grant once and returns the invocation id
  (0074_ledger_books_by_hand.sql:321-342: every request field compared, spent and expired refused) → a
  deferred constraint trigger verifies the trust receipt at commit (:276-300).
- The 0074 grant table is engine-locked: `capability_id ~ '^northstar\.ledger:...'` (0074:247), with rule 19
  ("ledger SQL names no other engine"). v1 adds a sibling `platform.open_item_approval_grants` +
  attest/consume/receipt of the same shape. Extracting one shared grant table is a later re-baseline
  (ADR-0066), not this vertical.
- Business work runs in TypeScript driven by a compiled binding (the `settlementBinding` pattern,
  settlement-capability-executor.ts:284). Only grant consumption and the counter are SQL definers.

## 6. Thin end-to-end slice (Q4): one tenant-declared invoice type, draft → issue (numbered) → one payment
- **s1a (compile):** schemas.ts (`openItem`, `openItemApplication`, `FieldNumbering.assignOn/scope`),
  projections.ts (binding + transition-assigned fields), semantic-operation-gateway.ts (pinned parser),
  release-verification-service.ts (arranges an issue). Rung: unit reds for every compiler refusal in §1.
- **s1b (storage + execute):** `db/migrations/00NN_open_items.sql` (the next free number at build time; 0074 is
  held by ACCOUNTING-1-s1a-ii): number counters, open-item grant table, attest/consume/receipt.
  `open-item-capability-executor.ts` (issue, apply); module-runtime-interpreter.ts (`assignOn` allocator call);
  `test/architecture/engines.manifest.json`. Schema snapshots come from CI (AGENTS.md §5).
- **Fixture:** a test-declared application (an invoice type with lines, a payment type, one application
  type), declared as data under `test/`. No `packages/domain` code and no per-app executor.
- **Rungs (postgres):** issue assigns `INV-000001` then `-000002` per company, and a rolled-back issue
  leaves no gap; a draft has no number; a grant replay is refused `approvalSpent`; two concurrent payments
  over-applying one invoice give exactly one success; one payment across three invoices sorts locks
  (no deadlock under a crossing pair); a currency mismatch is refused; a balance equals total − applied.
  Records: an evidence expected-red file plus a ≤80-line packet record.
- Serialization: touches `db/migrations/**`, the mount chain and the gateway, so it runs after
  ACCOUNTING-1-s1a-ii and LINE-TOTALS-s1 merge (AGENTS.md §3), not in parallel with them.

## 7. Later slices
s2 the multi-line apply UI and payment allocation; s3 credit notes (the same role, credit side, applied
through the same lines); s4 tax: per component on the taxable subtotal per code, rounded once per component
per document, the rate in force on `taxPointDate`, tax-exclusive (TAX s2 evidence rows + a rollup); s5
`void`/`unapply`; s6 posting to the ADR-0093 ledger (account-map roles, not module words); s7 billing
supplies lines (Branch A); s8 the receivable/payable specs move onto the core and
settlement-capability-executor.ts retires; s9 aging and statements as declared reports.

## 8. Rule notes
- No module or document words in generic code: `openItem`, `side`, `application` only. The guard is
  `test/architecture/first-party-names.policy.json` / `.baseline.json` (Critical), and it must not grow.
- No hand-built per-app code: an app supplies declarations only. The settlement spec-per-module pattern
  is what this core retires.
- Money: exact decimals in the document currency, with no conversion in v1. Negative lines are refused,
  and a return is a credit note (decision 4).
- STOP candidates: none open. Decisions 1-7 settle the product forks. The company-scoped unique index (§3)
  is checked in s1a and is not a fork.
