# ADR-0094: Derived stored decimals, declared create-only fields and the F5-a line rollup

Date: 2026-11-26
Status: RATIFIED 2026-11-26 (orchestrator + Fable ratification read, ADR-0094-ratification.result.txt); number assigned at
merge; plan §5.12 text edit awaits the owner (Q5)
Tier: Critical (money amounts and rounding; the interpreter's write path and lock order; release verification).
Amends: plan §5.12 F5 by contract (§5.11 step 3) and F6 by position (storage). The plan text itself is NOT edited: Q5
(provisional) keeps the plan edit for the owner. Related: ADR-0022 (sum semantics), ADR-0074 (formula-family admission
governs every new key here: a conformance-ledger obligation per key, positive v6 fixtures, a raised floor on a mandatory
family and an ACTUAL older binary refusing a declaring release), ADR-0077 (decimal typing), ADR-0093 (posting reads
stored values; the line-set version). F5-a admits a MONEY sum, which ADR-0022's query-aggregate profile excludes
(ADR-0022:84). It does not amend ADR-0022: that profile governs query-level aggregates, and this is a declared rollup
field.

Labels: **RULING** = an orchestrator ruling or a binding design-read amendment. **PROPOSED** = a phase-0 proposal that
ratification may change (names, error codes, enforcement sites).

## Context

The plan names F5 (bounded aggregation over a declared to-many relation) a candidate that is "not available to depend
on" until its §5.11 contract settles nine obligations (plan §5.12, the F5 contract). Line totals need two things the
language cannot express today:

1. **A stored amount derived on write.** F6 admits exact add, subtract and multiply, and sends any rounding policy
   through §5.11 as its own design (plan §5.12 F6). ADR-0077 keeps F6 out of storage, posting and tax, and allows one
   operator over two operands. Posting legs read only stored values, never a calculated one (ADR-0093 §2, :51). So a line
   amount is F6 in a storage position plus a new step: quantize to the target's scale by a declared mode.
2. **A sum over a document's lines.** The general form is a parent field that sums one stored child field over one
   declared parent-scoped relation. In s3 it becomes the plan's "platform-accumulated field" (plan §5.12, the F5
   contract's competing answer), stored and maintained in the line transaction.

Users served unchanged (rule 16): rental contracts (days x rate), field-service work orders (hours x rate; parts x
price less discount), distribution sales and purchase orders, clinic invoices, quotes, timesheets (a quantity rollup with
no currency), and TAX s2's evidence table (tax total = a rollup over it).

Owner questions, taken provisionally on the recommendations (standing instruction; to report): Q1 round each line, then
sum. Q2 discounts are percent 0-100 only, enforced by declared validations. Q3 the default line maximum is 1,000.
Q4 a total over lines the reader cannot see is withheld. Q5 this stays an ADR until the owner approves the plan edit.

## Decision

### Contract 1: the derived stored decimal (`derivedDecimals`, optional v6 key)

The general name is a derived stored decimal with an optional currency and an optional unit (design read L6). It is not
a "money amount": a timesheet's hours x factor carries a unit and no currency.

- **Declaration (key and member names PROPOSED).** `{ fieldId, expression, rounding: 'halfAwayFromZero', absentAs? }`.
  `fieldId` names an ordinary stored decimal, money or quantity field of the same entity. `expression` is a tree of
  `add`, `subtract` and `multiply` over same-row fields and decimal literals, depth at most 4. There is no division, no
  cross-row operand and no read through a relation. `absentAs` (PROPOSED; amendment 10 allows it or a required operand
  with a default) maps a named operand to a literal when it is absent (the blank discount; design read L7), and is the
  only absence default.
- **No chaining (RULING).** An operand may not be another derived target or a rollup field. The compiler refuses it in
  v1: there is no evaluation order and no cycle check. s4's "net + charges + tax" needs its own amendment.
- **Typing (ADR-0077's shipped rules, with currency by binding).** Add and subtract need the same currency and the same
  unit. Multiply refuses currency x currency and unit x unit; it ALLOWS currency x unit, which gives the currency and
  drops the unit (calculated-display.ts:28-33), so quantity-with-a-unit x price is admitted (every order line). A
  neutral factor keeps the other factor's currency or unit. A money operand's currency is its BINDING: the field it
  reads, reached through a named relation (the header currency field through the line's parent relation). Two
  operands share a currency only when they resolve to the same field on the same record through the same relation, not
  when their declarations look equal. The expression's currency binding and unit must equal the target's.
  Intermediate results are exact (ADR-0077's 76 digits, scale 36 bound). ADR-0077 is NOT amended: its display profile
  stays out of storage, and this is a separate storage-position contract that reuses its typing.
- **Rounding (RULING).** One mode in v1: **half away from zero**, to the target field's declared scale.
  `1.5 x 0.33 = 0.495` stores `0.50`; `-0.125` stores `-0.13`. The evaluator is the only rounding site. Its output is an
  exact value already at the target scale, in canonical spelling, so PostgreSQL never rounds on assignment. A value whose
  integer part does not fit the target precision refuses by name (amendment 3; the code name
  `MODULE_DERIVED_VALUE_OVERFLOW` is PROPOSED), never as SQLSTATE 22003.
- **Absence (RULING).** An absent operand (after `absentAs`) makes the derived value absent, so the target must be
  optional and the compiler refuses a required one. A required target with no input would make release verification
  derive away every scenario of the line entity without running it (release-verification-service.ts:903-1004).
- **Write (RULING, amendment 2).** The value is derived on create, on every update of the row, and on both template line
  inserts. It is derived before write invariants run, so they see it. On update it is derived from ONE locked prior-row
  read merged with the patch, and written in the same UPDATE with one revision bump. The update's write set (and so its
  change document) includes the derived target when its value changes. PROPOSED: an overflow is held and raised after
  validations pass, so a validation refusal is never masked by an overflow from the same bad input (verification's
  negative probes expect the validation's refusal code).
- **No validation watches a derived target (RULING).** ADR-0074 requires satisfying and violating witnesses built from
  input values for watched fields (formula-validation-examples.ts:126-141, :176-183). A derived target is not an input,
  so the verifier would send a field the contract refuses. The compiler refuses a validation whose watched fields
  include a derived target in v1. Validate the operands instead, as the s1 fixture does. Write invariants still see the
  derived value.
- **Contracts (RULING, amendment 1; key name PROPOSED).** The target leaves every input contract (`fields`,
  `writableFieldIds`) on create and update, as a numbered field does today. The create and update input contracts carry
  a separate optional key `derivedFields` naming the targets. `assignedFields` is untouched, because five readers assume
  it holds a document number. A caller-sent value refuses as an unknown field. The editor lists the target and shows it
  read-only from the compiled contract.

### Contract 2: the F5-a rollup (`rollups`, optional v6 key)

`{ fieldId, relationId, operator: 'sum', aggregandFieldId, maximumLines, materialize: 'onRead' | 'stored' }` (names
PROPOSED). s1 admits `onRead` only; `materialize: 'stored'` refuses in s1 with a named not-yet diagnostic (§5.11 step 4)
and is s3.

PROPOSED: in s1 the rollup's `fieldId` is a NON-STORED declared field ID of the header, as a calculated display field is
under ADR-0077. It has no storage mapping, no column and no mutation contract; the header GET selects it through the
rollup binding. A change from `onRead` to `stored` is a change to an existing declaration. Under gap c it is refused
while the header table holds rows, so s3 must bring a derived backfill and its own ruling before it can apply to
headers that already have lines.

The nine obligations of plan §5.12, the F5 contract:

1. **Declared cardinality and resource admission.** `maximumLines` (default 1,000, Q3) is a hard maximum, enforced by
   the write. Line create, line restore and template create count the parent's LIVE lines under the parent lock (9) and
   refuse line N+1 by name. A template with more lines than the maximum refuses at compile. Evolution follows gap c: in
   v1 the maximum does not change while rows exist, in either direction. This replaces the design note's "raising is a
   release change; lowering is refused while any parent is over".
2. **Empty-collection semantics.** `sum` over no live lines is a typed zero (ADR-0022). `count`, `min` and `max` are not
   admitted.
3. **Absent-element semantics (the F1 cross-term).** The aggregand is a derived decimal or a required stored decimal.
   One absent live element (an unpriced line) makes the total ABSENT, never a partial sum. The SQL form is
   `CASE WHEN count(*) = count(x) THEN coalesce(sum(x), 0) END`, not List figures' `coalesce(sum, 0)`, which skips nulls.
4. **Visibility, lifecycle and snapshot.** The total sums live (non-archived) lines only, in the header's tenant,
   environment and company, under the request's verified company read scope. It is computed in the same SQL statement
   as the header row, so it reads one snapshot. It is withheld, and the header is still answered, when the reader is
   not allowed the line read query or when any policy narrowing applies to it (Q4). A record therefore has three
   states for the total: a value, absent, and withheld; the read contract names the withheld state distinctly.
   The dependent read (RULING, amendment 9): the GET's total is authorized by ONE dependent-read function that List
   figures also call. It RETURNS its decision: figures throw on deny, while the rollup withholds. selectSql's
   extraColumns are quoted identifiers (module-runtime-interpreter.ts:7064-7094), so s1 adds an expression slot. The
   line entity joins the GET's verified read-entity list (module-runtime-interpreter.ts:2918).
5. **Types, units and error behaviour.** The aggregand's currency binding, reached through the rollup's own relation,
   must resolve to the rollup's header currency field (the same field on the same record). Units must be equal. The
   result scale is the aggregand's scale. The result precision is the aggregand's precision plus the digits of
   `maximumLines`, at most 38. Overflow refuses by name at read.
6. **Aggregate shape.** One stored aggregand field over one `parentScopedChild` relation. No expression aggregand, no
   filter, no junction, no nesting, no correlated aggregate. The compiler refuses a rollup whose header and lines differ
   in company ownership.
7. **Trigger topology.** s1: computed on read only, never stored, and no header write. s3: a maintained invariant,
   written in the same transaction as every line create, update, archive and restore. s3 needs its own amendment before
   it is built, because PROGRESS-QTY's shared accumulator needs a filter and a reference relation, and bullet 6
   forbids both.
8. **Position admission and read staleness.** Admitted positions: storage (the derived decimal); the record GET (s1);
   list, sort, filter and report reads (s3, stored). There is no staleness in either mode: on read it is computed in
   the snapshot, and stored it is transactional. For the ROLLUP, guards, validations and posting legs are NOT admitted
   (the LIFECYCLE-GUARDS count and the OPEN-ITEM credit guard need their own amendment). A stored derived decimal is
   exactly what an ADR-0093 leg reads, and is not barred. The operation read-back includes the stored derived value and
   omits an on-read total.
9. **Write-time concurrency protocol.** Every line write on a totalled relation takes the header row `FOR NO KEY UPDATE`
   once per transaction, before any path read. Later `FOR SHARE` requests for the same header in that transaction are
   granted by the lock already held. The isolation level is READ COMMITTED. The global lock order is: **existing line
   row, then the company master row, then the header row, then new line rows.** No writer takes a header and then an
   existing line row. Two placements are required:
   (1) the header lock is taken after the company lock and dateTime resolution, immediately before mutation
   preparation, on create, update and both template inserts;
   (2) archive and restore of a line on a SHARED entity lock the line before the header, with its own no-40P01 red (a
   shared update versus an archive of one line).
   KNOWN EXCEPTION, pre-existing and not caused here: a shared record with a dateTime field takes its own row and then
   the company (INT:2264-2278). Spun off to DATETIME-LOCK-ORDER (Critical). The s1 fixture declares no dateTime field.
   Until that packet merges the declared order is not global for such entities.

### Contract 3: the declared create-only field (optional v6 key, name PROPOSED)

RULING E(i). Any stored field type may be declared create-only.

- **Create.** Offered and written as today. An optional create-only field left blank on create stays blank.
- **Update.** The field leaves `fields` and `writableFieldIds`. A caller-sent value refuses as an unknown field, by name.
- **Marker.** The UPDATE input contract carries an optional key naming the create-only field IDs, `createOnlyFieldIds`
  (name accepted), emitted only when declared. It lives in the operation catalog, so it rides the operation floor; the
  surface manifest and its floor do not move (surface-contract.ts:1538-1555 builds editor inputs from the operation
  contract). Precedent: systemInput.immutableAfterCreate (projections.ts:2713).
- **Editor.** On a saved row a field named by the marker renders read-only, is omitted from the patch, and is exempt from
  the "Editor field unavailable" throw (document-editor.ts:3449) and the unchanged check (document-editor.ts:3512). A
  field missing from the update contract WITHOUT the marker still throws: the fail-closed guard stays, with a rule 8
  red.
- **Compiler refusals.** A derived decimal or rollup whose bound header currency field is not declared create-only AND
  required. Create-only on a numbered field, a derived target or a rollup field. Removing the marker from a field a
  declaration binds is a gap-c change. Adding it to an existing field needs no backfill.
- **Projections.** The agent sees the field writable on create and read-only on update; recovery restores it as written;
  templates set it (a create). ADR-0074: its own conformance-ledger obligation and positive v6 fixture.
- Create-only freezes the currency even on a document with no lines. That is stricter than gap a needs and is accepted
  for v1.

### Validation: money against zero (RULING, amendment 10)

A validation may compare a money field whose currency is a stored binding against the literal ZERO only, with the four
ordered operators. Any non-zero literal and any field-to-field comparison on such a field still refuse
(formula-validation-bindings.ts:228-231, :374-376). Absence gives `unknown` (ADR-0074). ADR-0074 obligations: a
conformance-ledger obligation, v6 accept and refuse fixtures, compiled satisfying and violating witnesses, and the
operation-catalog floor raised by ANY release that uses it, even one with no derived decimal. No v7: it admits a shape
every earlier compiler refused, so no existing node changes meaning.

### Gaps the design read found (RULINGS; the enforcement sites are PROPOSED)

- **a. A header currency change after lines exist.** The currency field that a rollup or derived decimal binds must be
  declared create-only and required (Contract 3). It therefore leaves the header's UPDATE input contract, create keeps
  it, and the editor freezes it on a saved document.
- **b. Rows that exist before the declaration.** A derived-decimal or rollup declaration on a table that already has rows
  is REFUSED in s1 and s2. Pre-tenant there are no tenant rows. s5 (first-party adoption) revisits it with a derived
  backfill. s1 carries no compile check for gap b: the compiler receives only the previous storage target
  (compiler.ts:566-586) and cannot tell an added declaration from a carried one. Gap b stands on the same footing as gap
  c: no production path declares until s2.
- **c. A later formula, scale or maximum change.** REFUSED in v1 while rows exist. The compiler cannot see a previous
  DECLARATION: the expected active release carries the storage target bytes and digests only (compiler.ts:566-586). In
  s1 no production path can declare or change a declaration (there is no Customize member until s2; first-party
  adoption is s5).
- **Enforcement of b and c.** Both are enforced at the s2 customization admission site, which holds the parent and
  candidate releases with database access (postgres-provider/src/customization-service.ts:2081-2093), before the s2
  member ships. s2 does not start until that site is verified. It must not become materializer or activation work. If
  s2's member is ever reordered ahead of the admission check, that is a STOP.
- **d. The template path.** The derive, the maximum and the lock all cover both template line inserts.
- **Line moved or company crossed.** An update writes patch fields only, never a relation column. Company equality is a
  composite key when header and lines are company-owned; addLineTable copies the header's ownership; bullet 6 refuses
  mixed ownership.

### Stored totals (s3): no revision bump

A stored total is written WITHOUT bumping the header's revision. The revision is the header's edit token. A bump on every
line save would refuse a second user's header edit, and ACCOUNTING's ready state (D5) relies on line writes not moving
it. Line-set freshness already has its own counter, the line-set version (ADR-0093 §5). s3 STOP checks: list every reader
keyed on the header revision (report index, change documents) before building; and confirm that the stored-total header
write, which fires ADR-0093's source-version trigger, records a line-set change, not a header revision.

### OPEN, BLOCKING s3: Q4 for stored totals

Q4 (withhold a total over lines the reader cannot see) holds for the on-read total by construction (bullet 4). A stored
total is an ordinary header column that any header reader can read, sort and filter. Before s3 starts, either a
field-level read rule withholds a stored total from a reader who is not allowed the line query, or the owner reverses Q4
for stored totals. s3 does not start until this is settled.

## Consequences

- A release that omits every key here compiles byte-identically. Every emission (`derivedFields`, `createOnlyFieldIds`,
  the GET's rollup binding, the floors) is conditional on a declaration.
- Floors, per family, assigned at merge (expected numbers): operation catalog 7 -> 8, query catalog 6 -> 7; the surface
  floor does not move. A derived decimal, a create-only field and the zero comparison raise the operation floor. A
  rollup raises BOTH, because the line maximum and the header lock are write behaviour an older binary would skip. An
  older serving binary refuses a declaring release by name before boot (ADR-0090), and still answers queries on releases
  it can read.
- §5.11 step 5 projections: the agent sees the derived decimal read-only and the total as a read value; the on-read
  total is not reportable until s3; the read-back includes the stored derived value and omits the on-read total;
  recovery restores stored derived values as written. Derived values are recomputed only by a later write of the row.
- Release verification must choose operands that fit the derived target (amendment 4). Its generic decimals carry up to
  nine integer digits, so two unconstrained factors overflow a scale-2, precision-18 target in about 94% of
  arrangements.
- Writers outside the interpreter (hand-built executors) bypass the derive. None touches a tenant line table today. s5
  enumerates them before first-party adoption.
- Narrower on purpose (rule 17c): sum only; one relation; one rounding mode; no chaining; no header discount, division,
  count, min or max. Each waits for a named second user.

## Evidence

At b6668f05 (paths under packages/): release verification arranges line records
(compiler/src/projections.ts:2629-2660; postgres-provider/src/release-verification-service.ts:2197-2224, :2332-2369) with
nine-digit decimals (:3443-3471). The input contract strips numbered fields (compiler/src/projections.ts:2685-2707) and
the gateway parses its keys exactly (runtime/src/semantic-operation-gateway.ts:1886-1897). The write path is in
postgres-provider/src/module-runtime-interpreter.ts: :902 and :7707-7751 (company lock on create), :911 (numbering),
:980 (prepareMutation), :1050-1063 and :1106-1120 (template lines), :1264 and :1489-1500 (record company lock),
:2264-2278 (dateTime prior read, then company), :2467-2484 (parent `FOR SHARE`), :2509-2548 (update writes the patch
only), :2597-2636 (archive lock). The get carries one verified company read scope (:2918-2931, :7995-8058,
:8095-8110). List figures' dependent-read authorization is runtime/src/semantic-query-gateway.ts:1361-1478. The document
editor's update save is apps/web/src/document-editor.ts:3445-3451. The phase-0 STOP checks
(LINE-TOTALS-s1-phase0.result.txt) and the ratification read (ADR-0094-ratification.result.txt) give the traces.

## Enforcement

- Compiler refusals: currency x currency; unit x unit; mixed currency or unit bindings; an expression currency binding
  or unit that differs from the target's; a binding that does not resolve to the rollup's header field through its
  relation; a required derived target; depth over 4; an intermediate result over 76 digits or scale 36; chaining (an
  operand that is a derived target or a rollup field); a validation whose watched fields include a derived target; a
  rollup whose header and lines differ in ownership; a rollup or derived decimal whose bound header currency is not
  create-only and required; create-only on a numbered field, a derived target or a rollup field; a template larger than
  `maximumLines`; result precision over 38; `materialize: 'stored'` in s1 (named not-yet diagnostic); a writable input
  that offers a derived target; a money-with-stored-currency comparison against a non-zero literal or another field.
- Compiler refusal (s1 review fix): a rollup with no UNFILTERED list query of its lines that selects the aggregand. The
  total sums every live line, so the query that authorizes it must show every live line; a filtered query never
  authorizes it, even when it comes first (Q4).
- Runtime: the derive, overflow and maximum refusals by name; rollup overflow refuses by name at read; the header lock
  and the lock order; the withheld state; the create-only refusal on update.
- s2 admission site: gaps b and c, verified before s2 starts.
- ADR-0074: a conformance-ledger obligation for each key (derived decimals, rollups, create-only, the zero comparison),
  re-derived coverage, and positive v6 fixtures.
- Tests: the s1 reds (rule 8) listed in the s1 build plan, each failing when its check is removed. That includes
  `-0.125 -> -0.13`, a declaring release with unconstrained operands passing verification, the editor's fail-closed
  throw for an unmarked missing field, and the preceding serving binary refusing a declaring release by name while
  answering a query.
