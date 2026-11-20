# DOCS-1 — governed files and generated PDFs

Slice 2 implements document templates and PDF generation from [ADR-0078](../../decisions/ADR-0078-governed-documents-files-templates-and-signatures.md). Slice 1a attached internal files to first-party and tenant records. Fable closed the design read before implementation. The Critical candidate uses migration 0052 and Surface reader 31 after Billing. Recheck both at integration. The branch waits for the targeted follow-up.

## Claims

1. Customize approves the exact template revision and selects it by a release pointer. Retirement ends issuance and preserves retained PDFs.
2. Each render uses declared header fields and bounded parent-scoped line queries. Scoped database functions resolve the live governing record and check query authority. Publication locks the parent and compares the full live child set and revisions. List and byte reads enforce the saved source restrictions.
3. PDFKit runs inside QuickJS with no host I/O. Its fixed metadata and pinned revision formats produce identical bytes for identical inputs.
4. Generation applies the document content gate and publishes the version, source evidence and audit together. A committed retry requires view, upload and attach authority and returns the generated version after reauthorizing its source, even after template retirement. The HTTP timer waits for a publication commit already in flight.

## Decisions

- Template sources are direct Q0 record reads and scoped child lists. Money uses the currency declared by its field type. Module reads return stored dates as civil text. Record pages and PDFs use the same calendar day. Layout uses the built-in Latin-script PDF fonts.
- The company-brand resolver uses the company record name and the Ledger print palette without a logo. Shared records use the Ledger name. Each issued PDF saves brand revision `platform-default`.
- Local demo issuance uses the demo scanner. SQL requires the governing Record grants, including mandatory child queries. PO approval settings may be withheld. SQL checks exact file categories and takes write limits and retention from the release. The scanner refuses verdict access after a policy change or release switch. Customer upload requests and signatures remain gated.

## Test it yourself

1. Start `NORTH_STAR_DEV_DATABASE_CONTAINER=dev-composed-app-postgres-docs-1 NORTH_STAR_DATABASE_PORT=55444 PORT=4175 NORTH_STAR_DOCUMENT_DEMO_SCANNER=1 corepack pnpm dev`.
2. Open **Customize → Document templates → Purchase order**. Create a template, choose the purchase order number as the issued number and enter a heading. Read the diff, approve and activate.
3. Open a saved purchase order and expand **Files**. Preview the template, then select **Generate PDF**. Download the attached version and check its number and branding.
4. Draft, approve and activate retirement in Customize. Open the same purchase order. The issued PDF is still available in **Files**.

## Gates and controls

Hosted CI exercises the compiled app, SQL authority, the preceding reader and persisted file-only parity. Local proofs cover actual issuance, exact digest, elapsed COMMIT and isolated mutations. The PDF integration test exercises the renderer’s network boundary and output limits. Expected-red controls cover query and company-brand read revocation, parser and subprocess limits, SQL pagination, the API scanner guard and the HTTP commit outcome.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1", "packet": "DOCS-1",
  "base": "08edc207bcd5be1982c9c0bcf1723172df9cb7ad", "head": "60d424377f890042992514a60251fc36a3df8823",
  "changedPaths": [
    ".github/workflows/ci.yml", ".github/workflows/evidence.yml", "apps/web/src/component-registry.ts", "apps/web/src/customize-screen.ts",
    "apps/web/src/document-http.ts", "apps/web/src/document-template-form.ts", "apps/web/src/surface-client.ts", "apps/web/src/surface-composition.ts",
    "db/migrations/0052_generated_document_sources.sql", "db/schema.snapshot.json", "packages/canonical-model/src/document-template-schema.ts", "packages/canonical-model/src/documents.ts",
    "packages/canonical-model/src/index.ts", "packages/canonical-model/src/normalize.ts", "packages/canonical-model/src/schemas.ts", "packages/compiler/src/compiler.ts",
    "packages/compiler/src/document-templates.ts", "packages/compiler/src/documents.ts", "packages/compiler/src/projections.ts", "packages/customization/src/apply.ts",
    "packages/customization/src/patch.ts", "packages/customization/src/render.ts", "packages/customization/src/targets.ts", "packages/postgres-provider/package.json",
    "packages/postgres-provider/src/customization-service.ts", "packages/postgres-provider/src/document-attachments.ts", "packages/postgres-provider/src/document-company-brand.ts", "packages/postgres-provider/src/document-content.ts",
    "packages/postgres-provider/src/document-pdf-worker.ts", "packages/postgres-provider/src/document-pdf.ts", "packages/postgres-provider/src/document-publication.ts", "packages/postgres-provider/src/document-template-sources.ts",
    "packages/postgres-provider/src/module-runtime-interpreter.ts", "packages/postgres-provider/src/request-context.ts", "packages/postgres-provider/src/request-runtime-view-service.ts", "packages/postgres-provider/src/serving-gateways.ts",
    "packages/runtime/src/civil-date.ts", "packages/runtime/src/document-gateway.ts", "packages/runtime/src/request-runtime-view.ts", "packages/runtime/src/semantic-operation-gateway.ts",
    "packages/runtime/src/semantic-query-gateway.ts", "pnpm-lock.yaml", "test/architecture/release-persistence-boundary.test.ts", "test/architecture/repository-hygiene.test.ts",
    "test/evidence/DOCS-1.expected-red.json", "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/helpers/archived-customization-runtime.ts", "test/helpers/document-pdf-text.ts",
    "test/integration/document-http.test.ts", "test/integration/document-pdf.test.ts", "test/postgres/document-attachments.test.ts", "test/postgres/document-templates.test.ts",
    "test/postgres/inventory-storage.test.ts", "test/postgres/migrations.test.ts", "test/postgres/module-storage-transition.test.ts", "test/postgres/request-runtime-view.test.ts",
    "test/postgres/trust-substrate.test.ts", "test/unit/customize-screen.test.ts"
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
