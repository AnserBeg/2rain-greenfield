# TAX-EVIDENCE-1-s1 — the tax catalog: jurisdictions, codes with append-only dated versions, company registrations, a Canadian starter as data

Status: built on packet/TAX-EVIDENCE-1-s1 (base main 8014e43f1). Tier: **Critical** (money, migration, grant SQL; rule 18). Stops: none.
Design: CALENDAR-TAX design note part B s1 plus the Fable design read's binding amendments T1-T7. Migration `0071_tax_catalog.sql` is provisional; the integrator renumbers.
CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/45841982614

## Claims
1. Codes are tenant-shared. A rate change is a new version whose `effective_from` is strictly after the latest (setter), one per code per day (UNIQUE), never updated or deleted (trigger) (T4). No future-only rule.
2. Rates and recoverable shares are exact `numeric(9,6)` held to 0..100 by CHECKs. A code may have zero components (T6). No rounding, inclusive-price or rate-freeze column.
3. A registration is (company, jurisdiction, number, [from, to)). An exclusion constraint refuses overlaps per company and jurisdiction; `to > from`; both dates are finite ISO strings. A new registration's company must be a live legal entity: an unarchived, active row of the entity the active release marks `legalEntityMaster` (ADR-0015), read from the storage-target chunk by a tax-owned reader, checked at review and share-locked in the setter after the pointer, epoch and review locks (T5; Fable fix round).
4. Every principal write is confirmation-class. `platform.tax_review` checks the live write grant, caps the proposal at 16 KiB, and records it with its digest, principal, release and fence. `platform.tax_confirm` locks the pointer FOR SHARE, the policy epoch, then the unused review; it re-checks the digest, the reviewing principal and the live write grant, writes a receipt and calls the internal setter. A read grant never writes. A release switch and back voids a review. A grant revoked after the review refuses.
5. A shared code needs a tenant-wide membership holding the write grant on that same membership (T2). A registration needs a membership covering the company. A registration named by ID takes its company from the stored row, never from the proposal.
6. Reads are tenant-scoped. `tax_read_codes(day)` offers active codes with the version in force that day. `tax_read_code(id, day)` refuses an inactive code, or a day before the first version, by name. `tax_read_registrations(company)` refuses, rather than answering empty, a company the membership does not cover. A member without the read grant is refused all three reads.
7. The Canadian starter lives in global migration-only tables. `platform.tax_provision_starter(t, e, jurisdictions)` applies it per tenant through `tax_put_code`, with a system-principal receipt per version. It skips any code the tenant already has: a re-apply changes nothing, and an edited code is never overwritten. Component IDs are fixed text, identical in every tenant (ledger qualifiers): `ca.gst`, `ca-bc.pst`, `ca-sk.pst`, `ca-mb.rst` (T3).
8. No runtime role holds a table privilege, and tenant tables force RLS. Only `north_star_runtime` executes the five platform functions. No role executes the setters or the provisioning function. Writers refuse outside READ COMMITTED.

## Starter rates (each row `pendingOwner`; a later migration records the owner's verification)
- GST 5% from 2008-01-01: Excise Tax Act, R.S.C. 1985, c. E-15, s. 165(1) (S.C. 2007, c. 35, s. 184). Recoverable 100.
- BC PST 7% from 2013-04-01: Provincial Sales Tax Act, S.B.C. 2012, c. 35, s. 34(1) (rate), s. 37(1) (charge). Recoverable 0.
- SK PST 6% from 2017-03-23: The Provincial Sales Tax Act, R.S.S. 1978, c. P-34.1, s. 5 (2017-18 budget). Recoverable 0.
- MB RST 7% after 2019-06-30: The Retail Sales Tax Act, C.C.S.M. c. R130, s. 1(1) "general sales tax rate" (c), s. 2(1). Recoverable 0.
- Codes: GST (ca), GST-PST-BC (ca-bc), GST-PST-SK (ca-sk), GST-RST-MB (ca-mb); each combined code starts on its provincial date. Sources: official consolidations, read 2026-11-26.

## Decisions
- T1, pickers CUT. A picker cannot target platform tax rows:
  - A read-model query first runs the generic executor over its declared `sourceEntity`, and only post-processes those rows (semantic-query-gateway.ts, the `definition.readModel` branch after `executor.execute`).
  - A picker's list and exact get must read one declared entity (surface-workspace.ts `selects` and `reads`), and platform tax rows are not a declared entity.
  - No first-party field is rewired; the declared `tax_code` record stays the only code that affects documents.
- Rule 13, NO rung. Nothing compiled or stored changes; `check:app-release` passes with no release diff.
  - The permissions are fixed platform IDs on `northstar.tax:capability.tax_catalog`. Unlike the address connector, they have no `CurrentPolicyPermissionBinding` or TS caller yet, so no real tenant can hold them (fail-closed); s2 adds both and re-asks the rung question.
  - The operations are SQL review and confirm, so no parsed chunk gains a key. The design read's rung assumed declared operations.
- The confirmation shape follows migration 0069's review-then-confirm, so ledger 1a-ii can reuse it or say why not.
- GUARD-WIDEN was not run. A token scan of the migration against the 723 names in app.authored.json finds only the ordinary words catalog and sales (statute text). Table names avoid `tax_code` by design.
- T7: the `engines.manifest.json` tax row waits for GUARD-WIDEN; if this packet merges first, the row rides along with that train.
- Gap: nothing calls `tax_provision_starter` yet. There is no tenant-provisioning flow beyond the local demo; wiring it in is the first follow-up.
- Narrower: the code read is unbounded (an admin-curated catalog). Review ride-alongs b-h are s2's first task.

## Rules 16, 17, 19, 20
(a) The block is a dated catalog of named rate sets per jurisdiction, plus per-scope registrations. (b) It serves these businesses unchanged; any new jurisdiction is a migration row:
- rentals: GST plus PST on a damage waiver;
- distribution: goods and freight in BC, SK and MB;
- clinics: an exempt, zero-component code;
- field service: separate labour and parts codes.
(c) Narrower: Canada only, no compounding, no determination rules (TAX-DETERMINATION-1). There are no module names in generic code and no custom code; tax attaches by declaration in s2.

## Controls (rule 8; test/evidence/TAX-EVIDENCE-1-s1.expected-red.json, 38 entries, one mutation each)
- Starter and reads: starter-pinned, starter-never-overwrites, read-codes-at-date, read-code-at-date, read-codes-inactive, read-code-inactive, read-codes-tenant, read-registrations-tenant, read-codes-grant, read-code-grant, read-registrations-grant.
- Storage: version-strictly-increasing, version-one-per-day, version-append-only, rate-range, recoverable-range, registration-no-overlap, registration-range, registration-finite, registration-date-iso.
- Privileges: no-table-grant, forced-rls, function-execute.
- Review and confirm: release-fence, review-single-use, review-digest, review-principal, review-size, confirm-live-grant, code-write-grant, registration-write-grant.
- Authority: shared-code-tenant-wide (T2), company-scope (two companies in one tenant; 4 kills), registration-company-stored, company-live-review, company-live-confirm, writer-read-committed (2 kills), registration-ends-once.
- Evidence: all 38 killed as declared and restored green at 145af7926 (https://github.com/AnserBeg/2rain-greenfield/actions/runs/45834386448).

## Rules 10, 12
No Customize member in s1; s4 adds `declareTaxableAmount`.

## Test it yourself
With Docker: `node --import tsx --test test/postgres/tax-catalog.test.ts`. Expect 43 passing subtests: the pinned starter, provisioning and re-apply, reads on a day, the refusals, and company A against company B in one tenant.

## Review focus
1. No rung: is fixed platform permissions plus SQL review and confirm acceptable for s1, instead of declared operations (which need a read-back on a declared entity)?
2. Lock order in `tax_confirm`: pointer, epoch, review, registration row. Also `tax_put_code`'s insert-then-lock on the code row.
3. T2 and isolation in `tax_granted`: the grant and the scope must be on the same membership.
4. The starter skip rule (a code already present is skipped whole) as "idempotent and never overwrites".
5. The starter statutes and dates still need the owner's verification.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "TAX-EVIDENCE-1-s1",
  "base": "8014e43f1524ad834afd9235203227a9c9b19140",
  "head": "f800e65cb90f2db46ca646b44a50442de6afedd3",
  "changedPaths": ["db/migrations/0071_tax_catalog.sql", "db/schema.snapshot.json", "packages/dev-tooling/src/tenant-completeness.ts", "test/architecture/release-persistence-boundary.test.ts", "test/architecture/repository-hygiene.test.ts", "test/architecture/tenant-completeness.manifest.json", "test/architecture/tenant-completeness.test.ts", "test/evidence/TAX-EVIDENCE-1-s1.expected-red.json", "test/postgres/inventory-storage.test.ts", "test/postgres/migrations.test.ts", "test/postgres/module-storage-transition.test.ts", "test/postgres/tax-catalog.test.ts", "test/postgres/trust-substrate.test.ts"],
  "symbols": [{"path": "packages/dev-tooling/src/tenant-completeness.ts", "name": "tenantIndependentV1TableAuthorities"}]
}
```
