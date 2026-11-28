# DOCUMENT-POSTING · Any staged document posts through one general binding

**Slice 1 · The binding envelope and the ledger's manual journal post, BUILD 2026-11-28.** Critical (money, ledger,
authority, RLS-adjacent SQL, a migration and a reader rung) under charter rule 24 (build mode). Design note
`origin/notes/DOCUMENT-POSTING:docs/design-notes/DOCUMENT-POSTING-binding.md`; one design read (Mythos, APPROVE WITH
AMENDMENTS, `/home/rvham/2rain-missions/DOCUMENT-POSTING-design-read.result.txt`), whose binding amendments 1-12 and
thin first slice are the scope. The opening entry is slice 2 (`ledger.openingNotYet` until then).

CI tier: pending full

## What was built

- **The block.** `packages/canonical-model/src/document-posting.ts`: an optional v6 operation key `documentPosting`
  (`documentPosting/v1`: engine, header entity, line relation, state field with `from` and `to`, a role-to-field map
  and an option map), every value a canonical ID. Engines register a declaration (capability, roles with scope, value
  class and required flag, choice options); the registry is `document-posting-engines.ts` and the ledger's
  declaration `ledger-document-posting.ts` (header kind, currency, date, memo; line number, account, side, amount).
  Nothing in the block or its checks names an engine.
- **Compiler** `COMPILER_DOCUMENT_POSTING_INVALID` (beside the booking check; the Customize candidate compiles through
  the same compiler): the engine's own humanRequired o1 capability operation; roles exactly the engine's, each an
  active field of its value class (amount: exact decimal 18,4), required where the role is; every option bound,
  distinct and of its own field; the line relation a required parent-scoped child of the header whose compiled key
  carries `legal_entity_id`; `from` a state some transition enters and not the initial state; `to` terminal, never
  initial, and no transition into or out of it; every header update, archive and restore guard refuses every state
  but the initial one in the `not(state = S)` form (a positive form would refuse every create, purchasing's
  `editableStates`); a transition permission on the header; a get read-back on the header; the catalog carries the
  block byte-equal. Release load re-checks the block against the released catalog and storage plan.
- **Rung.** `DOCUMENT_POSTING_OPERATION_READER = 9`, above line totals (8), tops every operation floor ladder
  (projections, compiler, release repository, request-runtime-view service including its consumesRules and
  consumesFormula conditions) and the runtime maximum. Provisional: assigned at merge. Books carries the first bound
  post, so every composed release moves to 9 (one lineage entry). The gateway's catalog parser admits the key only on
  its engine's humanRequired o1 capability operation.
- **Company ownership (G2).** `bookkeeping_draft` and `bookkeeping_draft_line`, and the line-to-draft pair, are rows
  of the pinned company-ownership lists (`packages/compiler/src/conformance.ts`, mirrored in the inventory contract).
  Rule 20: a compiler list naming first-party families; orchestrator ruling A (2026-11-28) raised the name baseline
  for `conformance.ts` by those two names; FIRST-TENANT-OWED lists the replacement (a declared company-ownership flag
  on the entity) for the hardening pass.
- **Books.** `packages/domain/src/bookkeeping/draft.ts`: the journal draft (kind manual|opening, currency, date,
  memo) and its lines (number, account code, side debit|credit, amount 18,4), a required parent-scoped relation, the
  machine Draft → Ready → (Reopen) → Draft, and Posted reached only by the post; generic create/update/archive/restore
  (the header's guarded `not(Ready) and not(Posted)`), get/list/search/resolve, Mark ready, Reopen and the bound Post
  (`northstar.ledger:capability.general_ledger`). A draft document editor in the composed application (Journal
  drafts, in Books).
- **Migration 0075 (provisional; three packets claim 0075).** `ledger_release_projection(released, family)` (keyed by
  the decided release, not the pointer); `ledger_minor_units(numeric, smallint)` (numeric arithmetic, refuses <= 0,
  a fraction of the minor unit and bigint overflow, never rounds); `ledger_document_binding` (STRICT by operation ID
  and engine from that release's catalog; entity, relation and columns from its storage plan by canonical ID); the
  preparation read `platform.ledger_document_company` (one null for missing, archived and foreign);
  `platform.ledger_apply_document_post` (order: READ COMMITTED guard; consume under its own constant; pointer and
  epoch FOR SHARE; header FOR NO KEY UPDATE; `journal_post` for the header's stored company; master row FOR SHARE;
  one read statement after the lock; Ready and the confirmed revision; currency known; 2-200 lines; account by code
  within the company; one manual entry with the draft as provenance; the state flip pinned to exactly one row by
  record, company, revision, state and liveness); the backstop index
  `ledger_entries_document_key (tenant, environment, company, source_type_id, record_id, entry_ordinal)` for manual
  and opening (amendment 8: entry_ordinal kept, so an opening document may make one entry per currency in slice 2).
- **G1.** The definer's owner is the migration role, which bypasses the module tables' forced row security (0074's
  master-row read already depends on it), so every dynamic statement names tenant, environment and company. No
  materializer grant was needed; the flip never moved to TypeScript.
- **Executor.** `DOCUMENT_POST` in `ledger-capability-executor.ts`: the target is the draft; preparation reads its
  company for the policy scope (exactly-one read-back scope required); the change document is of the draft (the
  receipt check binds it to the grant's `input.recordId`) at the draft's new revision; engine grant
  `northstar.ledger:permission.journal_post` on `northstar.ledger:capability.journal`, never books_configure.

## Reds (rule 24: nine silent-harm controls, `test/evidence/DOCUMENT-POSTING-s1.expected-red.json`)

Line writes frozen after Ready and Posted; the header lock (a line change committed during the wait is posted);
the record-ID backstop; the post's own grant constant; journal_post as the money gate; authority for the stored
company, not the caller's; exact minor units; the pinned Ready revision; Posted unreachable by any declared or
customized transition (compiler). Ordinary tests: the thin path with its evidence, notReady, staleRelease,
requiresReadCommitted, inactive and control accounts, function grants, the gateway's own permission refusal, and
each misbound block refused with its reason.

## Fallout of rung 9 on every composed release (full run 46149784858)

- The older-reader fixture (`withoutBooks`) strips Books' journal draft with the module.
- Tests that measure a lower feature's operation floor on the composed application strip the post
  (`test/helpers/without-document-posting.ts`): field and formula validation, line totals, booking. Two Customize
  sandbox tests whose base is the compiled composed release now expect reader 9 (the narrowing floor 2 and the template
  floor 7 are still proved by their own feature tests, not on that base).
- Re-measured: composed surfaces 124 -> 130, navigation 25 -> 26 (and the browser journey's "Books"), surface-grammar
  debt for Books 6 -> 23, page-budget surface-binding parses (+2 to +6 per page; no statement, transaction or policy
  read changed), the reversibility census (184 operations), the inventory-contract golden.
- Preceding-binary tests that expected a refusal of the current base at another family now pin the operation-catalog-9
  refusal (document-templates, report-company-reader, billing-terms, request-runtime-view).
- Orchestrator ruling (build mode, 2026-11-28): the "preceding binary answers on, or compiles, the current base" halves
  of presentation-list, line-logical-fields, logical-fields, report-analysis-reader and planner-map are removed and
  listed in FIRST-TENANT-OWED; their refusal halves pin the operation-catalog-9 refusal.

## Rule 16 and 17

Most general form: "a confirmed hand-off of a staged header-with-lines document to a registered engine, which reads
the document by declared roles, refuses unless it is frozen in the state the person confirmed, and moves it to a
terminal state only it can reach." Used unchanged by: the ledger's manual and opening journals (any business keeping
books: rentals, distribution, clinics, field service), inventory's stock documents (INVENTORY-POST-BIND, queued:
removes its by-suffix field resolution) and customer invoices and vendor bills when they post (billing, rentals,
subscriptions). Narrower on purpose: one engine registered; roles take five value classes; the engine's definer, not
the block, owns conversion; one document makes one entry per ordinal.

## Owed and open

- Amendment 10 (refuse `recordTransitioned` on a machine a block names; list 0075 in WORKFLOW-3's state-writer
  census) cannot be built on main: owed at integration with WORKFLOW-3.
- FIRST-TENANT-OWED: the preceding-binary proof for rung 9; the declared company-ownership flag.
- Queued: DOCUMENT-MONEY (staged money field block), INVENTORY-POST-BIND, the platform-row account picker, a declared
  company-ownership key for first-party entities; amendment 11 (whether opening needs its own permission) before
  slice 2; number-at-issue for invoices when they adopt the block.
- 1a-ii review: R1 no change (the channel claim is existing gateway design); R3 engine grants stay add-only, owed to
  the future role-admin writer; R4 owner call pending (demo grants unchanged); R5 and R7 already corrected on main.
- The memo role is bound and read by no entry column (ADR-0093 has none); it stays the document's.
- Silent-harm review (Mythos, MERGE, `/home/rvham/2rain-missions/DOCUMENT-POSTING-s1-review.result.txt`): N1 applied
  before the full run (the preparation read answers null unless the caller holds journal_post for the draft's company,
  so it is no existence oracle, binding amendment 3); N2 is amendment 10 above; N3 (the trust metadata's company is
  the preparation read's; a company is immutable after create today) and N4 (a Customize patch may swap the debit and
  credit option bindings, a visible tenant edit) are recorded, not built.
