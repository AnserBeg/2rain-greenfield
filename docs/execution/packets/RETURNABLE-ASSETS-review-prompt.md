# RETURNABLE-ASSETS — review round 1 prompt (ONLINE arm, user-run)

Repository `AnserBeg/2rain-greenfield`, branch `packet/RETURNABLE-ASSETS` (draft PR #27), frozen executable SHA
`59e16ff5`, base `packet/PAYABLES` at `96ac2341`. Diff: `git diff 96ac2341..59e16ff5`. No Critical-set path
(AGENTS.md §4) is changed.

What was built, by area:
- Custody records and events: Party declares, behind a `returnables` option only the product application passes,
  `returnable_asset_type` (tenant-level; a deposit per CAD, USD, EUR), `returnable_custody` (company-owned, numbered
  `RTN-`; party, direction out with a customer or held from a supplier, type, currency, frozen unit deposit, figures)
  and `returnable_event` (Issue, Return, Forfeit, Deposit refund). `packages/domain/src/party/returnables.ts`,
  `workspace.ts`, `definition.ts`; `packages/domain/src/app/{builder,order-entry,list-declarations}.ts`.
- The bounds: `returnable_event_post` posts a draft event once, under the custody's row lock, and restates the
  custody's figures from its posted events (`applyReturnableEvent`, `custodyStatement`, the executor in
  `packages/postgres-provider/src/returnables-capability-executor.ts`; codes in `inventory-posting-error.ts`).
- Deposits: taken on an Issue at the unit deposit frozen at the custody's first Issue, kept on a Forfeit, paid back
  by a Refund; each in the custody's currency, with a hand-entered method (cash, cheque, bank transfer) and reference.
  No PAY-/VPAY- row, ledger or provider.
- Shared runtime: a tenant-level record page whose workspace entry names a company-owned authorization List (the
  party page) now enters a company for its company-owned children as a List does, and reads none with no company.
  `apps/web/src/workspace-entry.ts` (`workspaceEntryParameter`, `resolveWorkspaceEntry`), `surface-composition.ts`
  (`loadSurfaceComposition`, `submitCompositionAction`), `surface-runtime.ts`. Also in `surface-runtime.ts`'s
  stylesheet: `.data-table-wrap` gains `position:relative` (`59e16ff5`).

Claims (the writer's):
1. Return plus forfeit never exceeds what was issued; a refund never exceeds the deposit on what came back less what
   was refunded; quantities are whole assets, amounts whole cents.
2. The unit deposit freezes at the first Issue in the custody's currency (unstated is refused, 0 is free); a deposit
   taken or refunded names its method; one custody per party, type, direction and currency (a second's first Issue
   is refused under a transaction lock); Issue out needs an active customer role, held an active supplier role.
3. Generic writes change a custody only while New and an event only while a draft, so only the capability moves a
   figure. The custody page offers Issue, Return, Forfeit and Refund deposit only where its figures admit each.
4. A tenant-level record page whose workspace declares a company entry (the party page) enters a company for its
   company-owned children as a List does: the URL's choice validated against the caller's authorized companies,
   else the only or preferred one pinned by redirect; with no company it reads none, and its own tasks still serve.
5. A List table wider than its panel scrolls inside its wrapper, which is now the containing block of its hidden
   header hints, so no List widens the page.

Questions. Answer each from the code; report production defects separately from evidence, wording and naming:
1. Do claims 1 and 2 hold when events on the same custody, or first Issues on different custody records for the same
   party, type, direction and currency, post concurrently?
2. Is every read and write of custody records and events confined to the company it was entered in, from the party
   page, the custody page and the Lists?
3. Is every deposit, kept amount and refund stated in the custody's currency at its frozen unit deposit, and can any
   path change either after the first Issue?
4. How are `RTN-` numbers assigned (scope, uniqueness, behaviour of a refused or abandoned record)?
5. Does the shared runtime change alter what any other surface reads, redirects to or acts in: the party page's
   Roles and Addresses sections, other tenant-level record pages, Lists, or company-owned record pages? Does the
   stylesheet change alter the layout of any other table or page?
6. Is there any other production defect under these claims?

Tests: `test/unit/returnables.test.ts`, `test/postgres/returnables.test.ts`, `test/integration/surface-data-binding.test.ts`
(the RETURNABLE-ASSETS test), `apps/web/test/browser/receivables-returnables.spec.ts`.

Not the packet records. Say plainly if this prompt steers you.
