# RETURNABLE-ASSETS — review round 2 prompt (ONLINE arm, user-run)

Repository `AnserBeg/2rain-greenfield`, branch `packet/RETURNABLE-ASSETS` (draft PR #27), frozen SHA `FROZEN_SHA`.
Round 1 reviewed `96ac2341..2a9db6d4`. This round: `git diff 2a9db6d4..FROZEN_SHA` (the whole packet:
`96ac2341..FROZEN_SHA`). No Critical-set path (AGENTS.md §4) is changed; trust code is untouched.

What changed since round 1, by function:
- Language: an optional v6 field key `maintainedBy` (a capability reference). `packages/canonical-model/src/schemas.ts`
  (`FieldMaintenanceSchema`), `field-maintenance.ts` (`validateFieldMaintenance`, called from `normalize.ts`), and
  `packages/compiler/src/projections.ts` (`operationInputContract` leaves a maintained field out of a generic create's
  and update's `fields` and `writableFieldIds`). Language coverage decisions re-derived
  (`test/fixtures/g2/language-conformance/coverage-decisions.json`).
- Returnables metadata (`packages/domain/src/party/returnables.ts`, `workspace.ts`): the ten custody figures and an
  event's `recorded_by` declare `maintainedBy` the returnables capability; a new reference relation
  `returnable_custody_asset_type` (restrict) from custody to type, with its legal-entity rule in
  `packages/compiler/src/conformance.ts` and `packages/domain/src/inventory/contracts.ts`; the party page's Issue
  returnables binds it; the custody page labels the type through it.
- Capability (`packages/postgres-provider/src/returnables-capability-executor.ts`): refuses a custody whose type link
  and type field differ.
- Shared web runtime: `apps/web/src/surface-runtime.ts` (`loadWorkspaceContextBar`, a branch for a tenant-level record
  page whose workspace enters a company); `apps/web/src/surface-composition.ts` (a child status `unscoped`;
  `applicable` withholds a Task that binds the generated company on a page with none; `present` reads "—" for a
  child row's label whose record is withheld or not found).
- Release entry 6 rebuilt from the base's five; tests (unit, integration, PostgreSQL, browser) and a controls
  manifest `test/evidence/RETURNABLE-ASSETS.expected-red.json`.

Claims (the writer's, reworded since round 1):
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
5. The custody page offers Issue always (it records more; it is not a preview), and Return, Forfeit and Refund
   deposit only where its figures admit each. An event's reference is optional.
6. A tenant-level record page whose workspace enters a company (the party page) enters one as a List does, shows it
   in the Company bar under the entry's parameter with each choice keeping the record, and, entered in none, displays
   no company-owned children ("Legal entity required") and offers no Task that writes in a company. Entry still reads
   the authorization List in each candidate company.
7. A child row's label that its record cannot give reads "—" in that cell; the section keeps its rows.
8. `position:relative` applies to every `.data-table-wrap`, which becomes the containing block of its absolutely
   positioned descendants.

Round 1's F4 (generic edits not bound to the URL's company, inherited shared runtime) is handled separately by the
COMPANY-BOUND-WRITES packet and is not changed here; an integration test here records today's behaviour.

Questions. Answer each from the code; report production defects separately from evidence, wording and naming:
1. Can any path other than the capability put a value in a custody figure or an event's `recorded_by`: a generic
   create, update, archive or restore, a composition Task, a document editor, an agent call?
2. Does `maintainedBy` change what any other entity's operations accept, what release verification arranges or
   derives, or any recorded lineage entry?
3. For the party page with no company, one company, a saved company, and an explicit company the caller may not
   enter: what does the Company bar show and link to, what does the page read, and which Tasks does it offer? Does the
   change alter the bar or the Tasks of any other surface?
4. Do claims 4 and 3's link check hold on every path that archives or restores a type or a custody, and when an
   archive and a create race?
5. Can the "—" label change show something a reader should not see, or hide a failure that should show?
6. Do the PostgreSQL tests establish the overlap they assert (two first Issues of different records for one key; two
   refunds of one custody)?
7. Did anything else break?
8. Is there any other production defect under these claims?

Tests: `test/unit/returnables.test.ts`, `test/integration/surface-data-binding.test.ts` (the two RETURNABLE-ASSETS
tests), `test/postgres/returnables.test.ts`, `apps/web/test/browser/receivables-returnables.spec.ts`.

Not the packet records. Say plainly if this prompt steers you.
