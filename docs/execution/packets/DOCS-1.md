# DOCS-1 — governed files and generated PDFs

Slice 2 implements document templates and PDF generation from [ADR-0078](../../decisions/ADR-0078-governed-documents-files-templates-and-signatures.md). Slice 1a attached internal files to first-party and tenant records. Fable closed the design read before implementation. Integrated over main `0a9f7ca5` with migration 0059, Surface reader 38 and query-catalog reader 5 (main supports query-catalog 4). The preceding-reader test pins `f3d0dcd4`, the last executable main (0a9f7ca5 added only docs), as the preceding serving binary. The record claim and CI tier line are rebound to the integration range and its full run after merge.

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44819597278

## Claims

1. Customize approves the exact template revision and selects it by a release pointer. Retirement ends issuance and preserves retained PDFs.
2. Each render uses declared header fields and bounded parent-scoped line queries. Scoped database functions resolve the live governing record and check query authority. Publication locks the parent and compares the full live child set and revisions. List and byte reads enforce the saved source restrictions.
3. PDFKit runs inside QuickJS with no host I/O. Its fixed metadata and pinned revision formats produce identical bytes for identical inputs.
4. Generation applies the document content gate and publishes the version, source evidence and audit together. A committed retry requires view, upload and attach authority and returns the generated version after reauthorizing its source, even after template retirement. The HTTP timer waits for a publication commit already in flight.

## Decisions

- Template sources are direct Q0 record reads and scoped child lists. Money uses the currency declared by its field type. Module reads return stored dates as civil text. Record pages and PDFs use the same calendar day. Layout uses the built-in Latin-script PDF fonts.
- The company-brand resolver uses the company record name and the Ledger print palette without a logo. Shared records use the Ledger name. Each issued PDF saves brand revision `platform-default`.
- Local demo issuance uses the demo scanner. SQL requires the governing Record grants and every read-model dependency whose compiled declaration does not say `required: false`; an absent flag is mandatory and fails closed. The PO read model declares its purchasing-settings and approval reads `required: false`, because its provider leaves the approval figures empty when either read is withheld; a test withholds each and the Record and its attachment stay readable. That flag changes the first-party PO release bytes; at integration it appends one entry to the first-party release lineage, leaving the earlier entries and their storage history unchanged. Releases whose dependencies omit it compile byte-identically, which the archived-compiler comparison proves. SQL checks exact file categories and takes write limits and retention from the release. The scanner refuses verdict access after a policy change or release switch. Customer upload requests and signatures remain gated.
- Named asymmetry: the PO provider also tolerates a withheld `received`, `bills` or `billLines` read, but those dependencies stay mandatory for attachments (orchestrator ruling). A person who can open the PO without vendor-bill or received-quantity read sees the Record and not its files; this fails closed.
- Accepted debt: the company-brand resolver in the generic document SQL names `northstar.app:query.legal_entity_get`, `northstar.app:field.legal_entity_name` and `northstar.app:entity.legal_entity`. The branding slice removes them.
- The generated-receipt function applies no file-category policy: a generated version has no field or category and `generated_source` is its authority. The former clause could not be killed by any test, so it was removed.
- Reader contract (orchestrator ruling, 2026-11-20): a catalog that declares any optional read-model dependency requires query-catalog reader 5 (`OPTIONAL_DEPENDENCY_QUERY_READER`). The preceding binary can meet such a release after boot (the active pointer moves, served without a restart), and its request view loader then refuses by name with UNSUPPORTED_RUNTIME_CAPABILITY before it decodes the catalog. The rung-4 exact-equality checks became feature-presence checks: the floor is the highest catalog feature present, and above rung 4 the formula projection's own declaration says whether calculated displays are consumed.
- Accepted boot behaviour: an already-built preceding binary that BOOTS on a flagged active release stops before it listens, in `releasePolicyBindings` with CANON_SCHEMA_INVALID, because boot strict-parses the stored definition before the request view service exists. Nothing ruled now can change that binary; failing before listen meets ADR-0085's intent.
- Boot-path check, measured for an earlier rung: a Board release (surface rung 33, built by 576bb781) passed to `releasePolicyBindings` in the rung-32 binary 47594bc6 fails with CANON_SCHEMA_INVALID and CANON_SURFACE_ARCHETYPE_UNSUPPORTED, while the same definition without the Board parses. Earlier "older readers refuse" proofs therefore covered only the request path.
- Separate Critical packet, gated before the first tenant: a boot-path capability check, so a booting binary refuses an unsupported active release by name before it parses the stored definition.
- Rule 12 exception (2026-11-20, DOCS-1 slice 2): `addDocumentTemplateRevision` and `retireDocumentTemplate` ship without in-app AI drafting support or eval cases. AI-BUILD-1 adds the drafter coverage test and the cases.
- Rule 10: a template revision persists its author's choices by stable ID (template, revision, header query, identity and bound fields) and is never re-derived and digest-compared on normalization. Only the active revision is validated; retired revisions are kept as evidence. A unit test proves that adding a field and arranging the list on the template's record type compile with the template active and after retirement, and the replay cases prove a label-only base change replays clean.
- Upgrade replay admits both template kinds. Its declaration keys now include `documentTemplatePointers` and `documentTemplateRevisions`, so a template absent on the destination is classified RETIRED_TARGET instead of an unclassified whole-package failure. A definition without those collections declares exactly what it did before, so every other replay is unchanged. Measured by hashing every replay's inputs and result across the whole upgrade suite, with and without the two keys: all 42 replays whose inputs are deterministic are byte-identical. The only changed result is the retired-template conflict, now RETIRED_TARGET. The Board and layout replays draw fresh random IDs on each run, so their inputs never match between runs; the first-party base they start from declares no templates.

## Test it yourself

1. Start `NORTH_STAR_DEV_DATABASE_CONTAINER=dev-composed-app-postgres-docs-1 NORTH_STAR_DATABASE_PORT=55444 PORT=4175 NORTH_STAR_DOCUMENT_DEMO_SCANNER=1 corepack pnpm dev`.
2. Open **Customize → Document templates → Purchase order**. Create a template, choose the purchase order number as the issued number and enter a heading. Read the diff, approve and activate.
3. Open a saved purchase order and expand **Files**. Preview the template, then select **Generate PDF**. Download the attached version and check its number and branding.
4. Draft, approve and activate retirement in Customize. Open the same purchase order. The issued PDF is still available in **Files**.

## Gates and controls

Hosted CI exercises the compiled app, SQL authority, the preceding reader and persisted file-only parity. Local proofs cover actual issuance, exact digest, elapsed COMMIT and isolated mutations. The PDF integration test exercises the renderer’s network boundary and output limits. Expected-red controls cover query and company-brand read revocation, the optional dependency flag in both directions, parser and subprocess limits, SQL pagination, the API scanner guard and the HTTP commit outcome.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1", "packet": "DOCS-1",
  "base": "fff2166fa326f871c11a34d4da623707878e7636", "head": "daef377d2ab0ea5a22e351bc7fba3870b494cf57",
  "changedPaths": [
    ".github/workflows/ci.yml", ".github/workflows/evidence.yml", "apps/web/release/app.authored.json", "apps/web/release/app.compiled.json",
    "apps/web/src/component-registry.ts", "apps/web/src/customize-screen.ts", "apps/web/src/document-http.ts", "apps/web/src/document-template-form.ts",
    "apps/web/src/surface-client.ts", "apps/web/src/surface-composition.ts", "db/migrations/0056_generated_document_sources.sql", "db/schema.snapshot.json",
    "packages/canonical-model/src/document-template-schema.ts", "packages/canonical-model/src/documents.ts", "packages/canonical-model/src/index.ts", "packages/canonical-model/src/normalize.ts",
    "packages/canonical-model/src/schemas.ts", "packages/compiler/src/compiler.ts", "packages/compiler/src/document-templates.ts", "packages/compiler/src/documents.ts",
    "packages/compiler/src/projections.ts", "packages/customization/src/apply.ts", "packages/customization/src/patch.ts", "packages/customization/src/render.ts",
    "packages/customization/src/targets.ts", "packages/customization/src/upgrade-diagnostics.ts", "packages/customization/src/upgrade-replay.ts", "packages/domain/src/purchasing/approval-workspace.ts",
    "packages/postgres-provider/package.json", "packages/postgres-provider/src/customization-service.ts", "packages/postgres-provider/src/document-attachments.ts", "packages/postgres-provider/src/document-company-brand.ts",
    "packages/postgres-provider/src/document-content.ts", "packages/postgres-provider/src/document-pdf-worker.ts", "packages/postgres-provider/src/document-pdf.ts", "packages/postgres-provider/src/document-publication.ts",
    "packages/postgres-provider/src/document-template-sources.ts", "packages/postgres-provider/src/module-runtime-interpreter.ts", "packages/postgres-provider/src/request-context.ts", "packages/postgres-provider/src/request-runtime-view-service.ts",
    "packages/postgres-provider/src/serving-gateways.ts", "packages/runtime/src/civil-date.ts", "packages/runtime/src/document-gateway.ts", "packages/runtime/src/request-runtime-view.ts",
    "packages/runtime/src/semantic-operation-gateway.ts", "packages/runtime/src/semantic-query-gateway.ts", "pnpm-lock.yaml", "test/architecture/release-persistence-boundary.test.ts",
    "test/architecture/repository-hygiene.test.ts", "test/evidence/DOCS-1.expected-red.json", "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/helpers/archived-customization-runtime.ts",
    "test/helpers/document-pdf-text.ts", "test/integration/document-http.test.ts", "test/integration/document-pdf.test.ts", "test/postgres/document-attachments.test.ts",
    "test/postgres/document-templates.test.ts", "test/postgres/inventory-storage.test.ts", "test/postgres/migrations.test.ts", "test/postgres/module-storage-transition.test.ts",
    "test/postgres/request-runtime-view.test.ts", "test/postgres/trust-substrate.test.ts", "test/unit/customization-upgrade.test.ts", "test/unit/customize-screen.test.ts"
  ],
  "symbols": [
    {"path": "packages/compiler/src/document-templates.ts", "name": "compileDocumentTemplates"},
    {"path": "packages/postgres-provider/src/document-company-brand.ts", "name": "LedgerDocumentBrandResolver"},
    {"path": "packages/postgres-provider/src/document-attachments.ts", "name": "PostgresDocumentGateway"},
    {"path": "packages/postgres-provider/src/document-pdf.ts", "name": "renderDocumentPdf"},
    {"path": "apps/web/src/document-template-form.ts", "name": "templatePatchFromForm"}
  ]
}
```
