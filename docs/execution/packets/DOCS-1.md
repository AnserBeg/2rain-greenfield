# DOCS-1 — governed files and generated PDFs

Slice 2 implements document templates and PDF generation from [ADR-0078](../../decisions/ADR-0078-governed-documents-files-templates-and-signatures.md). Slice 1a attached internal files to first-party and tenant records. Fable closed the design read before implementation. The source evidence migration is Critical.

## Claims

1. Customize approves the exact template revision and selects it by a release pointer. Retirement ends issuance and preserves retained PDFs.
2. Each render uses declared header fields and bounded parent-scoped line queries. The provider checks their classification, live grants, company and source revisions before publication. List and byte reads recheck the stored restrictions.
3. PDFKit runs inside QuickJS with no host I/O. Its fixed metadata and pinned revision formats produce identical bytes for identical inputs.
4. Generation applies the document content gate and publishes the version, source evidence and audit together. The same retry key and input return the same version.

## Decisions

- Template sources are direct Q0 record reads and scoped child lists. All selected fields are required and money also needs the selected currency field. Layout uses the built-in Latin-script PDF fonts.
- The company-brand resolver uses the company record name and the Ledger print palette without a logo. Shared records use the Ledger name. Each issued PDF saves brand revision `platform-default`.
- Local demo issuance uses the demo scanner. Company scope and source access are checked before a retained PDF is served. Customer upload requests and signatures remain gated.

## Test it yourself

1. Start `NORTH_STAR_DEV_DATABASE_CONTAINER=dev-composed-app-postgres-docs-1 NORTH_STAR_DATABASE_PORT=55444 PORT=4175 NORTH_STAR_DOCUMENT_DEMO_SCANNER=1 corepack pnpm dev`.
2. Open **Customize → Document templates → Purchase order**. Create a template, choose the purchase order number as the issued number and enter a heading. Read the diff, approve and activate.
3. Open a saved purchase order and expand **Files**. Preview the template, then select **Generate PDF**. Download the attached version and check its number and branding.
4. Draft, approve and activate retirement in Customize. Open the same purchase order. The issued PDF is still available in **Files**.

## Gates and controls

Hosted CI covers PostgreSQL issuance, stored brand provenance, live source restrictions, lossless retry, the preceding reader and tenant release parity. The PDF integration test exercises the renderer’s network boundary and output limits. The expected-red controls exercise both query and company-brand read revocation.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1", "packet": "DOCS-1",
  "base": "4ed523e803b9a0eb12c7bffe9dc4a85ce231c428", "head": "e17ec0012acb029913a013673ff1a600a501e95c",
  "changedPaths": [
    ".github/workflows/evidence.yml", "apps/web/src/component-registry.ts", "apps/web/src/customize-screen.ts",
    "apps/web/src/document-http.ts", "apps/web/src/document-template-form.ts", "apps/web/src/surface-client.ts",
    "db/migrations/0047_generated_document_sources.sql", "db/schema.snapshot.json", "packages/canonical-model/src/document-template-schema.ts",
    "packages/canonical-model/src/documents.ts", "packages/canonical-model/src/index.ts", "packages/canonical-model/src/normalize.ts",
    "packages/canonical-model/src/schemas.ts", "packages/compiler/src/document-templates.ts", "packages/compiler/src/documents.ts",
    "packages/compiler/src/projections.ts", "packages/customization/src/apply.ts", "packages/customization/src/patch.ts",
    "packages/customization/src/render.ts", "packages/customization/src/targets.ts", "packages/postgres-provider/package.json",
    "packages/postgres-provider/src/customization-service.ts", "packages/postgres-provider/src/document-attachments.ts", "packages/postgres-provider/src/document-company-brand.ts",
    "packages/postgres-provider/src/document-pdf-worker.ts", "packages/postgres-provider/src/document-pdf.ts", "packages/postgres-provider/src/document-publication.ts",
    "packages/postgres-provider/src/document-template-sources.ts", "packages/postgres-provider/src/request-runtime-view-service.ts", "packages/postgres-provider/src/serving-gateways.ts",
    "packages/runtime/src/document-gateway.ts", "packages/runtime/src/request-runtime-view.ts", "packages/runtime/src/semantic-operation-gateway.ts",
    "packages/runtime/src/semantic-query-gateway.ts", "pnpm-lock.yaml", "test/architecture/release-persistence-boundary.test.ts",
    "test/evidence/DOCS-1.expected-red.json", "test/integration/document-pdf.test.ts", "test/postgres/document-templates.test.ts",
    "test/postgres/inventory-storage.test.ts", "test/postgres/migrations.test.ts", "test/postgres/module-storage-transition.test.ts",
    "test/postgres/request-runtime-view.test.ts", "test/postgres/trust-substrate.test.ts"
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
