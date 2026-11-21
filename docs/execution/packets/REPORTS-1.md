# REPORTS-1 · Build and run a report on a company’s own record type

**Slice 0 · Design accepted after the 2026-11-20 Fable re-read; slice 1 may start.** The owner chartered the reusable capability and a design read before code. This docs-only packet touches no Critical path. Fable’s read of [ADR-0089](../../decisions/ADR-0089-declared-reports.md) (accept with amendments) is applied; the narrow re-read of B1/B2 closed with the edits applied.

**Slice 1 · BUILD checkpoint, 2026-11-21.** Invoice reports use the stored sales currency. CAD, USD and EUR have independent partitions. A missing amount contributes to coverage. A present amount without a recognized currency contributes to **No currency**. The canonical money profile is unchanged.

The Invoice date query uses `nsm_i_kyu3zu6vouaduhmjm5lbunvswejls2t4ls5svgycueyib3fqieka`. The provider probe, row policy, group ceiling, unavailable index, and pre-key byte identity have focused PostgreSQL/compiler witnesses. The published Invoice page and CSV [passed the PostgreSQL case](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44959811505/job/137016081557). The [Inspection browser case](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44959811505/job/137016081496) exercised rename, retirement and rollback. A failed audit append withholds the download. [Regression controls](../../../test/evidence/REPORTS-1-s1.expected-red.json)

Preview and activation use CUSTOMIZE-5’s pooled-table probe from migration 0061. The approved attempt checks the ceiling under the table lock. The predecessor at `6a991b21` supports surface rung 39. The optional company access key requires 40, the Invoice source binding 41 and grouped reports 42. The historical fixtures issue a governed query through that predecessor.

Grouped table and CSV output, scoped index admission and revision replay serve distribution (Invoices), field service (Inspections) and clinics (visits). Each business selects its record type, operands and labels in the declaration.

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44963499226

## Slice plan

| Slice | What the business user can do | Gate before claiming the slice |
| --- | --- | --- |
| 1 · Group and export | In Customize, name a single-type report, apply typed filters, group, count or sum, then publish a table with totals and audited CSV. Edit, retire and roll back the same ID. | First-party Invoices and tenant-built Inspections through the same path. If slice 1 ships a date filter on Invoices, declaring the Invoice date fields' temporal basis (R1) is part of the same first-party authored change as the reportable marking and the amount/currency binding. Prove company isolation, field narrowing, currency totals, read and export grants, bounded inputs, groups, keyset pages, persisted omission and historical serving refusal. |
| 2 · Dates, links and measures | Report by day, week, month or age. Choose a declared to-one link or a line grain, trial and approve a named measure, select min, max, average or distinct count. | Prove age boundaries, company business dates through DST, empty/absent cases, exact weighted totals, reused identities, and refusal of fan-out and unauthorized joined dependencies. |
| 3 · Present and share | Save a preset, choose a bar, line or stacked bar, print a customer statement, pin a report measure to Today and drill into the same report. | Author receivables aging, a customer account view and a printable per-customer statement as data over the serving Receivables contract. Table, CSV, chart, print and card agree at the same horizon and grant. |
| 4 · Ask | Ask how much was rented last month. The assistant discovers and invokes a released report with typed parameters. | Trace the actual registered query invocation and reconcile period, basis, company, currency totals and evidence link. Repeat with a narrowed role and with no eligible measure. |

## Test it yourself

**Slice 1 · Try it in Customize.** Open Add report from the source list, choose a group and measure, enable CSV, then approve and activate. Use the two fixtures below to check the result.

| Slice | Try it after the slice ships | Expected observation |
| --- | --- | --- |
| 1 | In one tenant/environment seed North invoices for the same customer at CAD 10.25, CAD 1.75 and USD 4.00, and South at CAD 90.00. In North with a North-only grant, publish **Balance by customer**, summing stored balances. Export it. | North shows CAD 12.00 and USD 4.00, on screen and in CSV. The CSV receipt identifies North, the report revision and the emitted bytes. Open South’s explicit scope as that person and observe refusal. Hide Balance for the role and repeat from a saved link. The dependent report is unavailable. |
| 1 | On a North-owned tenant Inspection type, add a report counting by Outcome on two Pass and one Fail. Rename the report, retire it, then approve compatible rollback. | Counts are 2 and 1. The renamed report retains its ID. Retirement removes discovery and closes the old link. Rollback restores the earlier revision and counts under the current grant. |
| 2 | For an aging run dated 2026-11-20 use due dates 2026-11-21, 2026-11-20, 2026-10-21, 2026-10-20, 2026-09-21, 2026-09-20, 2026-08-22 and 2026-08-21. Add two lines against one invoice and try summing its header balance at line grain. | The age bands count 1 future, 2 in 0–30, 2 in 31–60, 2 in 61–90 and 1 in 91+. Line count gives 2 and distinct invoice count gives 1. Summing that header at line grain refuses in preview. |
| 3 | Save North’s customer as a preset, chart the aging balances, print the customer statement and pin the CAD total to Today. Open the card. | Chart and statement keep CAD and USD separate. Detail explains the totals. The card reads CAD 12.00 and opens the same company, period and customer. With export authority revoked, issuing a statement or CSV refuses. |
| 4 | With a declared **Invoiced rental amount** report and November business date, ask “How much did we rent last month?” Open the answer’s evidence. | For that basis the window is Oct 1 inclusive through Nov 1 exclusive. Currency-labelled totals agree with the filtered report. Multiple plausible bases prompt clarification. An unavailable report gives a capability gap. |

## Discriminating proofs for executable slices

- Commit the implementation before mutation. In PostgreSQL use two companies in the **same** tenant/environment, valid stored owner IDs, one company-scoped principal and equal group keys. A legitimate North query must exclude the South amount. Remove **only the provider company predicate** and observe South’s sentinel in the North aggregate. Restore it and repeat. Retain a second tenant fixture and a company-denial case as separate tests.
- Drop only the currency partition on the mixed-currency fixture. Compare the actual group rows, full totals and CSV cells. Remove a required hidden-field dependency check and require denial before totals or labels escape. Withhold the export audit write and require zero bytes issued. Confirm a successful export against the stored receipt and actual file digest.
- Probe the provider cap at the limit and at limit+1, independently from the API page-size guard. Include sparse residual matches, group cap+1, a DB timeout and a byte cap. Each over-budget read returns **Narrow the filter**, identically whether the over-budget rows are readable or hidden. A missing index is refused at preview and activation with the named keys; at run time an index that has become invalid is a typed unavailable. Each fixture names the actual index it uses. On an existing table, prove the ceiling-bounded locking build (probe to ceiling plus one under the build lock) and the named refusal above the ceiling.
- Amount/currency (B1): on the mixed fixture add an invoice with no amount and one with an amount but no currency. Require the visible `N records without <measure>` figure on table, CSV, print and card, and a separate labelled **No currency** partition. Neither refuses the run. Adding the binding to first-party Sales: sources that do not declare the binding stay byte-identical; the tenant's own patch bytes and historical roots are preserved through the replay, with its own reader-rung witness. Add a hidden no-amount row to the hidden-versus-readable proof: the coverage figure and the No-currency partition are computed after row policy, so the hidden row changes neither. Walk keyset pages with tied sort values, change a source value and observe an explicit restart. Assert complete totals on every page.
- Index byte-identity (B2): a customized lineage containing a company-owned tenant type created BEFORE the access-index key recompiles to identical bytes, root and floor, and plans zero `createIndex` elements.
- Slice 1 checks: (a) whether the new index needs a new `indexKind` literal in the storage target (a widening under ADR-0047 section 3; rule it the same way as ADR-0087's window index); (b) whether the `addRecordType` member needs a version bump for the optional key (if so, R5's bumped member version plus its own rung applies), and whether `addRecordType` replay admission (UPGRADE-2 slice 1) has merged.
- Compare persisted first-party and genuinely customized no-report revisions, release payload bytes, roots and floors before and after registration. Run the archived preceding loader against the stored featureless control and report release. It serves the former and refuses the latter before any request. Removing its production floor check must red that witness. Include a release mixing reports with another floor-bearing feature.
- Exercise an ordered create/edit/retire chain, compatible upgrade and a real removed operand or changed scope per new patch kind. Remove its independent allowlist entry and require the vocabulary test to name it. A stale approval after switch-away/switch-back refuses. A conflicting replay keeps the verified source serving.
- Register the compiler, PostgreSQL, archived-loader, browser and agent witnesses with their CI-2 producers. The hosted run must credit each test file in one attempt. Record the expected-red evidence for silent-harm claims when the corresponding slice exists. [CI-2](CI-2.md)

## Slice 1 drafting evaluation

2026-11-21 · Rule 12 exception, REPORTS-1 BUILD lane. The in-app drafter derives the report member from its schema. Its Invoice case in `test/unit/customization-ai-draft.test.ts` also exercises refusal of an unavailable operand source. The live module-building runner is in AI-BUILD-1 slice 2 and is absent from the fetched main (`6a991b21`). At integration with that runner, register these cases under the report member.

| User request | Required grading observation |
| --- | --- |
| “Show Invoice balances by customer with a CSV, keeping currencies separate.” | The proposed revision selects the Invoice collection, customer dimension, stored balance sum, table and CSV. Currency comes from the source binding. |
| “Count Inspections by Outcome. Let me download the table.” | On a created Inspection type with an Outcome choice, the revision selects that tenant's collection and stable Outcome field, counts records and enables CSV. |
| “Use a hidden Invoice balance for the report.” | A role without Balance receives no report proposal exposing that field. |

## Design decisions and gate

Use the existing List and Home grammar. A group has typed keys, currency and measures. A report's stable ID survives renaming. The proposed 91+ label puts day 90 in one band. The reader enforces the ADR’s limits. The slice 1 PostgreSQL and browser cases exercise published reports and their authorized readers.

Resolved by the design read and orchestrator rulings: a report’s index on an existing table uses the ceiling-bounded locking build (ADR-0087 A4, PR-6c path), initially 10,000 rows, and refuses by name above it. Every new company-owned record type declares a same-plan company-leading index (optional key; absent on all earlier types). Amendments B1, B2, R1–R9 and N1–N5 are in [ADR-0089](../../decisions/ADR-0089-declared-reports.md#amendments-from-the-design-read). B1 and B2 were re-read and closed (2026-11-20).

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1", "packet": "REPORTS-1",
  "base": "6a991b21f6faa7df9833a8e27cee5aac5c0d7bf9", "head": "9cec1e717ff08b9504da2f0072130e8290715410",
  "changedPaths": [
    "apps/web/release/app.authored.json", "apps/web/release/app.compiled.json", "apps/web/src/component-registry.ts", "apps/web/src/customize-report.ts", "apps/web/src/customize-screen.ts", "apps/web/src/grouped-report.ts", "apps/web/src/ledger-styles.ts", "apps/web/src/surface-contract.ts", "apps/web/src/surface-runtime.ts",
    "apps/web/test/browser/customize-inspection.composed-application.spec.ts", "apps/web/test/browser/customize.composed-application.spec.ts", "package.json", "packages/canonical-model/src/constants.ts", "packages/canonical-model/src/declared-report.ts", "packages/canonical-model/src/grouped-aggregate.ts", "packages/canonical-model/src/index.ts", "packages/canonical-model/src/normalize.ts", "packages/canonical-model/src/schemas.ts",
    "packages/compiler/src/declared-reports.ts", "packages/compiler/src/projections.ts", "packages/compiler/src/storage.ts", "packages/customization/src/ai-draft.ts", "packages/customization/src/apply.ts", "packages/customization/src/index.ts", "packages/customization/src/patch.ts", "packages/customization/src/render.ts", "packages/customization/src/report-revision.ts",
    "packages/customization/src/targets.ts", "packages/customization/src/upgrade-diagnostics.ts", "packages/customization/src/upgrade-replay.ts", "packages/domain/src/sales/definition.ts", "packages/postgres-provider/src/customization-service.ts", "packages/postgres-provider/src/grouped-report.ts", "packages/postgres-provider/src/module-runtime-interpreter.ts", "packages/postgres-provider/src/module-storage-materializer.ts", "packages/postgres-provider/src/release-repository.ts",
    "packages/postgres-provider/src/report-index-build.ts", "packages/postgres-provider/src/serving-gateways.ts", "packages/runtime/src/declared-report.ts", "packages/runtime/src/request-runtime-view.ts", "packages/runtime/src/semantic-query-gateway.ts", "test/architecture/repository-hygiene.test.ts", "test/architecture/surface-grammar-conformance.test.ts", "test/compiler/report-company-access.test.ts", "test/evidence/REPORTS-1-s1.expected-red.json",
    "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/helpers/application-before-stock-count-workflow.ts", "test/helpers/archived-runtime-process.ts", "test/helpers/reachability-producers.ts", "test/helpers/reports-preceding-release.ts", "test/postgres/booking-serving.test.ts", "test/postgres/customization-inspection.test.ts", "test/postgres/date-time-field.test.ts", "test/postgres/document-attachments.test.ts",
    "test/postgres/releases.test.ts", "test/postgres/report-company-reader.test.ts", "test/postgres/report-reader-bounds.test.ts", "test/postgres/request-runtime-view.test.ts", "test/unit/customization-ai-draft.test.ts", "test/unit/customization-board.test.ts", "test/unit/customization-upgrade.test.ts", "test/unit/date-time-field.test.ts"
  ],
  "symbols": [{"path":"packages/compiler/src/declared-reports.ts","name":"lowerDeclaredReports"},{"path":"packages/postgres-provider/src/grouped-report.ts","name":"readGroupedSnapshot"},{"path":"packages/runtime/src/declared-report.ts","name":"reportCsv"}]
}
```
