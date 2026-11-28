# DOCUMENT-POSTING: the general document-posting binding (design note)

2026-11-28, design only. `main` 32139da; `s1a-ii:` = `packet/ACCOUNTING-1-s1a-ii` 9b3d3db (unmerged). **No STOP**; gates
G1, G2 below. The trust path is only on s1a-ii, so slice 1 starts after it merges (never stacked, AGENTS.md §3).

## 1. Where the envelope lives (precedent: the operation-level `booking` block)
- Booking is the exact shape: a zod union (`canonical-model/src/booking.ts:65-74`), an optional v6 operation key
  (`schemas.ts:3008-3015`), copied into the catalog (`compiler/src/projections.ts:1095-1096`), admitted by the gateway's
  exact-key parser (`runtime/src/semantic-operation-gateway.ts:1490`, `:1532-1547`) and type (`:108-119`), checked at
  compile (`compiler.ts:2438`) and release load (`release-repository.ts:974`), resolved in SQL by operation ID from the
  fenced release's catalog chunk (`db/migrations/0050_booking_commitments.sql:203-212`, `:417-420`).
- New generic `canonical-model/src/document-posting.ts` (names no engine), per operation: `documentPosting:
  { bindingVersion: 'documentPosting/v1', engine, header: { entity }, lines: { relation }, state: { field, from, to },
  roles: { <roleKey>: <fieldId> }, options: { <roleKey>: <optionId> } }`, strict keys, canonical IDs
  (`semantic-operation-gateway.ts:61-62`). `options` binds choice roles (debit/credit, manual/opening) so no engine
  reads an option's name, as inventory does (`inventory-posting-capability-executor.ts:755-757`). It is one sibling map
  beyond the ruled role-to-field map; decided here, not stopped (not product-visible).
- Engine declaration: `{ capabilityId, roles: { key: { scope: header|line, valueClass, required, options? } } }`.
  Value classes: `exactNumber` (exactDecimalFieldType precision 18 scale 4, stored `numeric(p,s)`, `storage.ts:2971-2974`),
  `calendarDate`, `text`, `integer`, `choice` (enum; every declared option role bound). The ledger's declaration sits in
  a file on the `ledger` row of `engines.manifest.json:130-140` (PRESS014: only an engine's files use its names,
  `module-press-law.ts:1441`). UNVERIFIED that an importing aggregator passes; else the composition root passes the registry.
- Ledger (`northstar.ledger:capability.general_ledger`, manifest `:131`): header `kind` (choice manual|opening), `currency`,
  `date`, `memo` (optional); line `number`, `account` (code, unique per company, `0071_ledger_journal_core.sql:110`), `side`
  (choice debit|credit), `amount` (exactNumber): s1a-ii's declared names (`ACCOUNTING-1.md`, "Names"); none built yet.

## 2. Compiler: `documentPostingDeclarationProblem(pkg, engines)`, `COMPILER_DOCUMENT_POSTING_INVALID`
Called beside `bookingDeclarationProblem` (`compiler.ts:2438`, `release-repository.ts:974`). Refuses unless:
1. Effect `registeredCapabilityEffect`, capability = registered `engine`, required; `humanRequired`; o1; v6.
2. Role keys = the engine's set; fields active, of the value class, required where the role is; options distinct, own.
3. Lines relation: `parentScopedChild` (`schemas.ts:683`), `required: true` (storage `nullable: false`, `storage.ts:567-572`),
   target = header != source, and `resolveLegalEntityRelationSemantics` = `sameEntity` (`conformance.ts:1043-1072`), so
   the FK carries `legal_entity_id` (`storage.ts:1254-1262`): a line's company is its header's by construction.
4. State: the header's active machine (`schemas.ts:723-733`), its state field; `to` terminal; a transition enters `from`.
5. Posted protection: no transition into or out of `to`; no create/update input contract on the header admits the state
   field; no resolved effect names `to` (`projections.ts:1010-1030`). Only the engine's definer reaches `to`.
6. Freeze: every active `updateRecordEffect` precondition on a parent guards child writes (`semantic-operation-gateway.ts:1355-1372`;
   enforced at `postgres-provider/src/module-runtime-interpreter.ts:2500-2505`, parent `FOR SHARE` at `:2477-2482`); at
   least one header update must pin the state field to the initial state, so lines freeze at `from`.
7. Permission `transition` on the header (`booking.ts:216-224`). 8. Catalog carries the block byte-equal (`compiler.ts:2438-2450`).

## 3. The rung: every composed release moves
`DOCUMENT_POSTING_OPERATION_READER = 8`, above the template reader 7 (`canonical-model/src/record-template.ts:6`), tops
each floor ladder (`projections.ts:354-365`, `compiler.ts:2401-2408`, `release-repository.ts:1284-1286`,
`request-runtime-view-service.ts:1064-1071`) and the maximum (`runtime/src/request-runtime-view.ts:190-193`); the parser
key list gains `documentPosting` (`semantic-operation-gateway.ts:1482-1492`). Books is composed into the first-party app
(`s1a-ii:packages/domain/src/app/builder.ts:135-139`), so the first bound post lifts every composed release to 8 and a
reader-7 binary refuses it by name. The reader ships one deploy ahead (ADR-0093 §5); rule 21(c) skipped, as s1a-ii.

## 4. SQL: `platform.ledger_apply_document_post`, books start's 8 arguments (`s1a-ii:0074_ledger_books_by_hand.sql:428-429`)
1. `ledger_require_writer()`: READ COMMITTED (`0071:234-237`). 2. Consume as `general_ledger` (`s1a-ii:0074:321-343`).
3. Pointer (`released`, fence) FOR SHARE and epoch lock (`s1a-ii:0074:401-412`); the access function takes the permission
   as an argument (fixed to books_configure at `:413`), and the post checks `journal_post`.
4. Binding: a ledger-owned `ledger_release_projection(released, family)` (shape of `0050:203-212`; s1a-ii's reader follows
   the active pointer, `s1a-ii:0074:346-357`) selects STRICT the one catalog operation with `operationId = operation`,
   capability = the constant and a block for that engine (else `ledger.bindingUnavailable`). Entity, relation and columns
   resolve from that release's storage by `entityId`, `relationId`, `canonicalFieldId`: no caller name, no suffix.
5. Header `... WHERE record_id = $1 AND archived_at IS NULL FOR NO KEY UPDATE`; it conflicts with line writers' parent
   FOR SHARE (§2.6), so the line set is fixed to commit. Then permission and the master row FOR SHARE on the header's
   company (`s1a-ii:0074:365-378`): "the record" before the master row, ADR-0093 §6's position; the 0074 order comment
   (`:177-180`) gains it. UNVERIFIED: no writer takes the master row before a draft header.
6. One read, a second statement (READ COMMITTED snapshots it after the lock; a one-statement read keeps the pre-wait
   snapshot): revision, state, kind, currency, date, memo and `jsonb_agg` of live lines by `number`. Refuse unless state =
   `from` (`ledger.notReady`), revision = `expectedRevision` (`ledger.staleRevision`; the post pins the ready revision).
7. Convert: code to account ID by (company, code); side option to `D`/`C`; amount by the one function
   `north_star_internal.ledger_minor_units(amount numeric, exponent smallint) RETURNS bigint`, exponent from
   `ledger_currencies.minor_unit` (0..4, `0071:23-29`), refusing `amount <= 0` (`ledger.amountNotPositive`), amount !=
   `trunc(amount, exponent)` (`ledger.unrepresentableAmount`, ADR §4) and bigint overflow.
8. `ledger_write_entry(company, kind, {"civil": date}, currency, lines, provenance)` (`s1a-ii:0074:40-42`; civil dates for
   manual and opening, `:68-70`); provenance: invocation as `operationReceiptId`, `entryOrdinal` 1, header entity as
   `sourceTypeId`, draft as `recordId`, pinned `sourceHeaderRevision` (allowed by `0071:140-146`). Slice 1 refuses
   `opening` (`ledger.openingNotYet`).
9. Set state `to`, revision + 1; evidence as books start (`s1a-ii:ledger-capability-executor.ts:328-361`): state, entryNumber.
10. Backstop: unique index `ledger_entries_document_key (tenant_id, environment_id, company_id, source_type_id, record_id)
   WHERE entry_kind IN ('manual','opening') AND record_id IS NOT NULL`; `unique_violation` -> `ledger.documentPosted`.
   ADR-0093 §4 (`:119-120`) says record ID is null for those kinds; the ruling overrides it; the ADR owes a dated line.
- G1, UNVERIFIED: the definer's owner may UPDATE module tables (s1a-ii only SELECTs, `:372`); else the materializer grants.

## 5. Executor
A `DOCUMENT_POST` action beside `BOOKS_START` (`s1a-ii:ledger-capability-executor.ts:72-98`) whose target is the draft
(the company is hard-wired as `recordId` at `:137`, `:170`, `:249`, `:271`). Preparation reads the draft's company through
a read definer for the policy scope; the apply re-derives it under the lock (`ledger.unavailable` on mismatch). The
receipt check already binds the change document to `input.recordId` (`s1a-ii:0074:296`). `engineGrants` gains
`LEDGER_JOURNAL_POST_GRANT` (born with the post, `:39-48`); readBack is the draft's get. G2, UNVERIFIED: how a new
first-party entity is classified `entityOwned` for §2.3 (pinned families, `conformance.ts:1063-1072`).

## 6. Inventory adoption later (INVENTORY-POST-BIND)
Today: entities and fields by ID suffix (`inventory-posting-capability-executor.ts:821-887`, `:902-935`), types by option
suffix (`:755-757`), grandfathered at `test/architecture/first-party-names.baseline.json:839`. Later: inventory's post
carries a block; its engine declares header roles (type, options adjustment|transfer; effectiveAt, reasonCode,
reasonNarrative, sourceId, sourceType) and line roles (number, item, fromLocation, toLocation, unit, quantity as
`exactNumber`); `inventoryDraftBinding` resolves by canonical ID and the baseline row falls (PRESS015). Its kernel stays
TypeScript (SQL resolution once it moves); stock counts (`:132`) are out of scope.

## 7. Rule-8 reds (one control and one killing test each)
Compiler: unregistered engine; engine != effect capability; missing role; extra role; amount as text or numeric(18,2);
unbound option; relation `reference`, not required, not `sameEntity`, or target != header; foreign state field;
transition into or out of `to`; `to` not terminal; update input admits the state field; no initial-state header guard;
`confirmation: 'none'`. Runtime: block on a record effect refused by the parser; reader-7 refusal by name. SQL: a books-start grant refused in the post; replayed grant `ledger.approvalSpent`; another release `ledger.staleRelease`;
draft state `ledger.notReady`; stale revision; REPEATABLE READ `ledger.requiresReadCommitted`; header lock removed (reopen
and line edit commit between read and write); read merged into the lock statement (a line commit during the wait missed);
state flip removed (second post hits `ledger.documentPosted`); amounts 0, -1.00, 0.001 CAD; unknown, inactive and control
accounts; no `journal_post` grant `ledger.unavailable`; a catalog test that no operation names `to`.

## 8. Thin slice 1 (after s1a-ii; the reader merge first)
1. Reader merge (schema key, parser, validator, reader 8, registry; unused). 2. Books: draft and draft-line entities, relation, fields, machine draft/ready/posted with only ready and reopen
   transitions; create/update draft, line create/update/archive, ready, reopen, post (bound); get, list, line list.
3. Migration (function, reader, apply, index, permission argument, grants), executor action. Opening: slice 2, same block.
4. Test it yourself: books start, Canadian chart, CAD draft (cash Dr 100.00, owner equity Cr 100.00), Ready, Post: one
   manual entry, draft posted; Post again and edit a line: both refused.
