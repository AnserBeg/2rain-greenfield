# SALES-PARITY — review round 4 prompt (ONLINE confirm arm, user-run)

Repository `AnserBeg/2rain-greenfield`, branch `packet/SALES-PARITY`, frozen executable SHA `b829d633`.
Review the fix range `40ca820a..b829d633` (`a1a8a051` verification; `f98fb641` the scan and wording;
`b829d633` controls, evidence only). Read wider code as you need.

Round 3 (at `40ca820a`) confirmed round 2's two repairs and found one older production defect: release
verification treated a server-assigned document number as a caller input. Every entity with a
required numbered field and a search query (sales order, purchase order, shipment, invoice, payment,
credit) derived all of its scenarios as unconstructable, 125 of the release's 485; one without a search
query would have failed its uniqueness-fold probe.

The fix is provider-only. The compiler's plan is unchanged, because changing compiler output would
invalidate this branch's recorded lineage entries (ADR-0047). Verification now counts assigned fields as
constructible, reads each arranged record's assigned values back from its create, lets a search probe use
an assigned searchable field, and probes an assigned business key's uniqueness as a caller can observe
it: two creates store values that differ under the key's fold, and a create supplying the first value in
another case is refused as input, naming the field. Separately, the allocator's scan now reads the key's
stored folded companion instead of folding every row again.

Question: is the defect closed for every admitted declaration, is the evidence each executed probe
records true to what it tested, and did the fix introduce a new production defect? Try to break it.
Report production defects separately from evidence, wording and naming, which are filed, not fixed.

Where to look:
- `packages/postgres-provider/src/release-verification-service.ts`: `verificationConstructibilityFindings`,
  `#create`, `#uniquenessFold`, `#assignedUniqueness`, `#searchableExclusion`.
- `packages/postgres-provider/src/module-runtime-interpreter.ts`: `assignDocumentNumbers`, `foldedColumnSql`.
- `packages/compiler/src/projections.ts`: `operationInputContract`, `verificationPlanPayload` (unchanged).
- ADR-0033 (derivation reasons are closed), ADR-0043 and ADR-0047 (why the plan did not change).
- Tests: `test/postgres/document-numbering.test.ts` (reads the admitted release's evidence) and
  `test/postgres/composed-application.test.ts` (`assertExactPartitionEvidence`,
  `assertIndependentConstructibilityPartition`).
- Controls: `test/evidence/SALES-PARITY.expected-red.json` (`verification-*assigned*`, `numbering-*`).

Consider at least: whether the assigned-field probe tests something the name `uniquenessFold` promises,
or should have been a derivation; whether an assigned field can now be constructible when the create
cannot in fact supply it; whether a read-back can silently miss a value (selections, capability creates);
whether the companion scan and the key can disagree on any storage target, including legacy ones without
companions; and what executing those 125 scenarios costs activation.

Not the packet records. Say plainly if this prompt steers you.
