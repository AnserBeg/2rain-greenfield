# SALES-PARITY — Critical review prompt (ONLINE, one arm, user-run)

Repository `AnserBeg/2rain-greenfield`, branch `packet/SALES-PARITY`, frozen executable SHA `<HEAD>`
(stacked on `packet/RAIN-ORDER-ENTRY` `994a7dc9`; review only the SALES-PARITY diff `994a7dc9..<HEAD>`).

Question: is there a defect in production code under the claims below? Report production defects
separately from anything else (evidence, wording, naming), which is filed, not fixed.

Critical paths touched:
- `packages/postgres-provider/src/release-verification-service.ts`:
  - one constructor option, so verification's interpreter runs with `documentNumbers: 'verificationSentinel'`;
  - `#queryForEntity` skips a query that declares a read model.
- `packages/postgres-provider/src/module-storage-materializer.ts` (grant SQL):
  - the `addColumn` transition now grants UPDATE on a new mutable column of a company-scoped table;
  - `createManagedTable` now revokes table-level UPDATE only when one exists.

Claims (from `docs/execution/packets/SALES-PARITY.md`):
7. A numbered field leaves every writable input set; a typed number is refused and writes nothing.
8. `assignDocumentNumbers` allocates inside the create transaction under `pg_advisory_xact_lock` keyed
   by tenant, environment and sequence: one past the highest `PREFIX-digits` among all the tenant's rows
   (archived included, case-insensitive); the unique business key is the backstop; a replayed
   idempotency key never re-enters.
9. Release verification's arranged records take `V-` sentinel numbers and never consume the sequence.
10. A column a later release adds to a company-scoped (`legalEntity`, not fact or period-lock) table
    gets the same column UPDATE grant creation gives the entity's other mutable columns, and only then.
11. Tables are shared by tenants. Replaying a company-scoped table's creation for another tenant keeps
    the column grants that a later release added for a tenant already serving it. The table-level
    revoke runs only when a table-level grant exists. PostgreSQL's table revoke also drops column grants.
20. Verification reads its probe records through each entity's plain get (and search). A read-model
    query of the same type, such as `commercial_order_get` (an order with its totals, sorting before
    `sales_order_get`), is never chosen, because verification's gateway registers no read-model executor.

Probe in particular:
- Is the grant ever wider than `entityOwnedMutableColumnNames`? Can an immutable column (tenant,
  environment, legal entity, record id) become updatable?
- Can the revoke's skip leave a table-level UPDATE in place? Does catalog drift verification still
  refuse any grant outside the expected set?
- Can skipping read-model queries leave an entity with no verification read, or let a scenario
  that SHOULD read through a read model pass unread?
- Do the lock key and the numbering scan agree on scope? Can two concurrent creates read the same
  maximum? Can a sentinel collide with, or parse as, a business number? Can any business caller
  select the sentinel mode?

Reading list:
- `docs/architecture/posting-kernel-guarantees.md`.
- The diff to `release-verification-service.ts` and to `module-storage-materializer.ts` (`case 'addColumn'`,
  `createManagedTable`, `buildExpectedColumnGrants`).
- `module-runtime-interpreter.ts` (`assignDocumentNumbers`, its call in `#executeOperation`).
- Tests: `test/postgres/document-numbering.test.ts` and `test/postgres/fulfillment.test.ts`.
- `test/postgres/composed-application.test.ts` ("ADR-0047 §6 … rollback edge").
- `test/evidence/SALES-PARITY.expected-red.json` (four controls).

Not the packet records. Say plainly if this prompt steers you.
