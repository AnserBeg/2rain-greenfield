# RETURNABLE-ASSETS — review round 2 prompt (ONLINE arm, user-run)

Repository `AnserBeg/2rain-greenfield`, branch `packet/RETURNABLE-ASSETS` (draft PR #27, base `packet/PAYABLES`),
frozen SHA `c74484f6da626130ed2072b3ca8fc290e6297fd1`. Round 1 reviewed `96ac2341..2a9db6d4`. This round reviews
`git diff 2a9db6d4..c74484f6` (the whole packet is `96ac2341..c74484f6`). Later commits on the branch change only the
packet's record, this prompt and its test-it-yourself. No Critical-set path (AGENTS.md §4) is changed.

What changed since round 1, by function:
- Language: an optional v6 field key `maintainedBy` (a capability reference). `packages/canonical-model/src/schemas.ts`
  (`FieldMaintenanceSchema`); `field-maintenance.ts` (`validateFieldMaintenance`, called from `normalize.ts`: the
  capability must be one the package requires with `recordMutation`; the field optional, not a business key, not
  numbered; no document-editor field or composition binding may write it). `packages/compiler/src/projections.ts`:
  `operationInputContract` leaves a maintained field out of every generic create's and update's `fields` and
  `writableFieldIds`; `verificationPlanPayload` plans no search-exclusion or enum probe for it (those probes populate
  their field through the entity's generic create), the same exclusion a state machine's state field already had.
  Language coverage decisions re-derived (`test/fixtures/g2/language-conformance/coverage-decisions.json`).
- Returnables metadata (`packages/domain/src/party/returnables.ts`, `workspace.ts`): the ten custody figures and an
  event's `recorded_by` declare `maintainedBy` the returnables capability; a new required reference relation
  `returnable_custody_asset_type` (archive `restrict`) from custody to type, with its legal-entity rule in
  `packages/compiler/src/conformance.ts` and `packages/domain/src/inventory/contracts.ts`; the party page's Issue
  returnables binds it; the custody page's type column reads through it.
- Capability (`packages/postgres-provider/src/returnables-capability-executor.ts`): refuses a custody whose type link
  and type field differ (`RETURNABLES_CUSTODY_INVALID`).
- Shared web runtime: `apps/web/src/surface-runtime.ts` (`loadWorkspaceContextBar`: a branch for a tenant-level record
  page whose workspace declares a company entry); `apps/web/src/surface-composition.ts` (a child status `unscoped`
  and its message; `applicable` withholds a Task that binds the generated company on a page entered in none;
  `present` reads "—" for a child row's reference label whose record is withheld or not found; print treats
  `unscoped` as incomplete).
- Release entry 6 rebuilt from the base's five (`apps/web/release/`). Tests: `test/unit/returnables.test.ts`,
  `test/integration/surface-data-binding.test.ts` (two RETURNABLE-ASSETS tests), `test/postgres/returnables.test.ts`,
  `apps/web/test/browser/receivables-returnables.spec.ts`; composed-suite pins and the full-replay schema snapshot
  (`test/postgres/composed-application.test.ts`, `fresh-tenant-full-replay-schema.snapshot.json`, +56 lines); a
  controls manifest `test/evidence/RETURNABLE-ASSETS.expected-red.json` (13 one-property mutations).

The writer's claims:
1. Over the posted events of a custody: return plus forfeit never exceeds what was issued; a refund never exceeds the
   deposit on what came back less what was refunded; quantities are whole assets, amounts whole cents.
2. The unit deposit freezes at the first Issue in the custody's currency (unstated is refused, 0 is free); a deposit
   taken or refunded names its method; one activated custody (first Issue posted) per company, party, type, direction
   and currency, under a transaction lock on that key (several New records may exist; a Closed one still blocks);
   Issue out needs an active customer role, held an active supplier role.
3. The custody figures and an event's attribution are written only by the capability: no generic create or update
   names them, so a New custody stores state New and no figure until a posted event restates them. Generic writes
   change a custody only while New and an event only while a draft.
4. A type is not archived while a live custody names it, and an archived type starts no custody.
5. The custody page offers Issue always, and Return, Forfeit and Refund deposit only where its figures admit each.
6. A tenant-level record page whose workspace enters a company (the party page) enters one as a List does, shows it
   in the Company bar under the entry's parameter with each choice keeping the record, and, entered in none, displays
   no company-owned children ("Legal entity required") and offers no Task that writes in a company. Entry still reads
   the authorization List in each candidate company.
7. A child row's reference label that its record cannot give reads "—" in that cell; the section keeps its rows.
8. `position:relative` applies to every `.data-table-wrap`.

Round 1's F4 (generic update, archive and restore through a company-owned surface are not bound to the URL's company;
inherited shared runtime) is handled by PR #32 (COMPANY-BOUND-WRITES, base `packet/INTEGRATION`) and is not changed
here. An integration test here records today's behaviour.

Questions. Answer each from the code at the frozen SHA; report production defects separately from evidence, wording
and naming:
1. Which of round 1's F1, F2 and F3 does the code at the frozen SHA still exhibit, fully or in part?
2. Can any path other than the capability put a value in a custody figure or an event's `recorded_by`: a generic
   create, update, archive or restore, a composition Task, a document editor, an agent call, a release-verification
   arrangement?
3. What does `maintainedBy` change in what other entities' operations accept, in the scenarios release verification
   plans, executes or derives, and in recorded lineage? Is anything those removed probes checked now unchecked?
4. For the party page with no company, one company, a saved company, and an explicit company the caller may not
   enter: what does the Company bar show and link to, what does the page read, and which Tasks does it offer? Does the
   change alter the bar, the Tasks or the print output of any other surface?
5. Do claims 3 and 4 and the type-link check hold on every path that archives or restores a type or a custody, and
   when an archive and a create overlap?
6. Can the "—" label change show something a reader should not see, or hide a failure that should show?
7. Do the PostgreSQL tests establish the overlap they assert (two first Issues of different records for one key; two
   refunds of one custody)? Does each control's mutation fail the test it names for the reason it declares?
8. Did anything else break?
9. Is there any other production defect under these claims?

Not the packet records. Say plainly if this prompt steers you.
