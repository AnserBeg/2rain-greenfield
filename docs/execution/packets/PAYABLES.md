# PAYABLES — vendor bills, vendor payments and vendor credits, mirroring receivables

Status: increments 1 (one settlement executor; two receivables fixes) and 2 (bills, vendor payments, vendor credits) executable; draft PR on `packet/ORDER-PARITY`; increment 3 (the three-way match status and refusing Cancel while a bill exists) chartered; no merge, no deployment. Sole LOCAL BUILD under the owner's standing instruction (2026-09-30).
Tier: outside the Critical set — a Purchasing capability (`northstar.purchasing:capability.payables`, `recordMutation`) with existing company-scoped grants; no posting-kernel, verification, trust, migration or RLS change.
Base: `packet/ORDER-PARITY` at `4616e7d2` (stacked on draft PR #10 <- #8 <- #7). Reference: PaneFlow `d057daff`; design `design-payables.md`; `PURCHASING-PARITY-inventory.md` P21.

## Owner rulings (2026-09-30, the recommended choice taken)

- PY-A: SALES-PARITY's ruling C extends to payables: internal bill documents, no ledger, no provider.
- PY-B: a bill never exceeds what was received. PY-C: a bill line takes the purchase order line's frozen cost, discount and tax rate; the PO's freight and other fee go on its first live bill; no tax is entered on a bill.
- PY-D: the bill date is the posting moment; due = bill date + the PO's payment terms (a supplier invoice date is a later follow-up).
- PY-E: numbers `BILL-`, `VPAY-`, `VCM-`. PY-F: an optional supplier invoice number, unique among the supplier's live bills in the company, ignoring case and spacing.
- PY-G: the three-way match is shown, never enforced (increment 3). PY-H: a purchase order's Cancel is refused while a live bill exists (increment 3). PY-I: one bill per payment or credit.

## Claims

1. One settlement executor, driven by a document spec, serves receivables and payables; the receivables spec keeps its codes, messages, event schema and refusal reason (`RECEIVABLES_CAPABILITY_EXECUTOR_FACTORY` unchanged).
2. Posting an invoice reads only its order's shipped rows, not every shipped row of the company; "to invoice" counts each line's own positive part, as posting does, so a correction on one line no longer hides another line's uninvoiced quantity (two latent SALES-PARITY findings, fixed here).
3. "Bill received quantities" on a released or closed purchase order bills each line's received-not-yet-billed quantity at its frozen figures under the order's row lock (which every receipt posting, lifecycle change and amendment takes first), and is offered only while the read model states a positive `order_to_bill`; a user who may not read bills or receipts sees no offer rather than a failed page.
4. Vendor payments and credits post in whole cents up to the bill's balance under the bill's row lock; a bill is void only while nothing is settled; bill states draft, open, partially paid, paid, void; duplicate supplier invoice numbers are refused.
5. Metadata: a Bills List (views by state, CSV), bill, payment and credit pages, the purchase order page's Bills section and "Open bill", and a Billing step in the order's progression (attention while anything received is unbilled, also on a closed order); commands are offered only where their state preconditions hold.

## Decisions

- Bills live in the Purchasing module behind a `payables` option only the product application passes (it requires `commercialTerms`); modules never import each other, so the bill page is a copy of the invoice page and the Bills List shares `settlementList` with Invoices (Invoices' output unchanged, pinned).
- A bill line's unit comes from the receipt (purchase order lines have none); the bill date is stamped at posting even when a draft carries another date (receivables still reads its draft's date).
- The PO progression keeps its title "Purchase to receipt" although it now runs through Billing.

## Gates

- Increments 1-2 (agent, `7ac8d176`, `6aa2908c`), merged onto ORDER-PARITY (`388dddb0`, `e6d6b894`, `46ae90e5`, then increment B at `89bd5384`): full tsc clean; unit 74/74 then 65/65; `g2-module-conformance` 78/78; web contract 33/33; integration (payables, ORDER-PARITY, receive-offer) 4/4, then the payables case with B's progression 5/5; architecture (grammar, purity, hygiene, reachability) 52/52; eslint clean; `check-records` and static `check-expected-red` OK (154).
- Release entry 4 (18.7 MB) `--check` PASS; coverage 2654 obligations, 811 observed, PASS. Pins from a compile: 101 surfaces, 16 navigation surfaces, 573 verification scenarios (496 executed, 77 derived), vendor bill/line/payment/credit 23/17/17/15.
- Full-replay schema snapshot regenerated (`d6fccd6d`): only the four new tables (72 columns, 18 constraints, 20 indexes, 16 policies and their privileges) — generated with the harness readiness wait raised for that local run only (this host needs ~106 s to start PostgreSQL), restored from git.
- Not run locally (host memory): PostgreSQL `payables` (new), `receivables` (new case), composed-application, module-storage-transition; browser `payables` (new). CI on the PR is their first run.

## Test it yourself

`PAYABLES-test-it-yourself.md`.

## Filed

- B's related-record link could let a bill link back to its purchase order the way an invoice links to its order; not added.
- The PO progression's title reads "Purchase to receipt" while it ends at Billing and Closed.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "PAYABLES",
  "base": "4616e7d2230c320ec915dac9039c6c7283dc6c3c",
  "head": "89bd53847fd389da1a55b5dd9174e6be627308ee",
  "changedPaths": [
    "apps/api/src/composition-root.ts", "apps/web/release/app.authored.json", "apps/web/release/app.compiled.json",
    "apps/web/release/current-policy-bindings.json", "apps/web/test/browser/payables.spec.ts", "apps/web/test/surface-runtime-contract.test.ts",
    "packages/compiler/src/conformance.ts", "packages/domain/src/app/builder.ts", "packages/domain/src/app/list-declarations.ts",
    "packages/domain/src/app/order-entry.ts", "packages/domain/src/inventory/contracts.ts", "packages/domain/src/purchasing/definition.ts",
    "packages/domain/src/purchasing/index.ts", "packages/domain/src/purchasing/workspace.ts", "packages/domain/src/sales/workspace.ts",
    "packages/postgres-provider/package.json", "packages/postgres-provider/src/commercial-read-model.ts", "packages/postgres-provider/src/inventory-posting-error.ts",
    "packages/postgres-provider/src/payables-capability-executor.ts", "packages/postgres-provider/src/receivables-capability-executor.ts", "packages/postgres-provider/src/settlement-capability-executor.ts",
    "test/architecture/module-press-law.test.ts", "test/architecture/repository-hygiene.test.ts", "test/architecture/surface-grammar-conformance.test.ts",
    "test/compiler/inventory-contract.release.golden.json", "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/helpers/generate-fresh-tenant-full-replay-schema.ts",
    "test/helpers/order-entry-fixture.ts", "test/integration/surface-data-binding.test.ts", "test/postgres/composed-application.test.ts",
    "test/postgres/fresh-tenant-full-replay-schema.snapshot.json", "test/postgres/module-storage-transition.test.ts", "test/postgres/payables.test.ts",
    "test/postgres/receivables.test.ts", "test/unit/canonical-model/field-numbering.test.ts", "test/unit/canonical-model/surface-composition.test.ts",
    "test/unit/canonical-model/surface-list.test.ts", "test/unit/purchasing-definition.test.ts", "test/unit/workspace-contract.test.ts"
  ],
  "symbols": [
    {"path": "packages/postgres-provider/src/settlement-capability-executor.ts", "name": "settlementCapabilityExecutorFactory"},
    {"path": "packages/postgres-provider/src/payables-capability-executor.ts", "name": "PAYABLES_SETTLEMENT_SPEC"},
    {"path": "packages/postgres-provider/src/payables-capability-executor.ts", "name": "PAYABLES_CAPABILITY_EXECUTOR_FACTORY"}
  ]
}
```

Review: not owed — outside the Critical set.
