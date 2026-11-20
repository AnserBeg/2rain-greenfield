# DOCS-1 — internal files on saved records

Slice 1a implements [ADR-0078](../../decisions/ADR-0078-governed-documents-files-templates-and-signatures.md). Critical path is the forward migration and its grants. Fable's design read is closed.

## Claims

1. Standard and tenant records use the same attachment control and the same live record, company and document permissions for list, preview and download. Scanned uploads publish through the Semantic Operation gateway.
2. Customize drafts, approves and activates files fields with explicit count, requiredness and allowed internal categories. Rollback retains existing versions and hides retired fields from ordinary reads.
3. The provider publishes immutable bytes, versions and audit together. Tenant and environment quotas serialize publication. Staging retirement clears bytes and retains the upload identity. Dedupe also keys on stored company ownership.
4. Byte reads and writes each have two process slots and a 30-second response deadline. The local demo scanner is opt-in. Serving without a real or explicitly enabled local scanner refuses uploads.

## Decisions

- File-field requiredness applies to document task completion. Slice 1a allows attachments after saving and stores the flag for the later task.
- Internal categories can accompany a field draft. Customer upload requests still require the external-identity ruling.
- The server derives a scoped upload ID from the authenticated principal and the browser retry key.
- Files and calculated displays share field-ID and label checks on the same record type.
- The PDF content gate admits single-revision PDFs with a classic cross-reference table. PNG admission uses the single-image noninterlaced profile.

## Evidence

PostgreSQL tests cover byte reads, grants, company refusal, audit, quota, count, scanner gating and rollback. The HTTP test holds two slots of each kind and observes the third refusal. Hosted CI runs the archived floor-26 reader against the new release. Negative controls cover revocation, ownership, audit and stored-byte quota. The record-page test checks the mobile camera input. Physical-device capture is unverified.

## Test it yourself

1. Start the local demo with `NORTH_STAR_DEV_DATABASE_CONTAINER=dev-composed-app-postgres-docs-1 NORTH_STAR_DATABASE_PORT=55444 PORT=4175 NORTH_STAR_DOCUMENT_DEMO_SCANNER=1 corepack pnpm dev`.
2. Open a saved Item and expand **Files**. Observe the demo scanner label. Attach a PNG, preview it, and download the same file. On a supported phone, attach a photo from the camera.
3. In **Customize**, draft a files field on Item or a tenant record with Maximum files set to 1. Approve and activate it. Attach one file in the new field, then try a second. Check the refusal and roll back the field.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1", "packet": "DOCS-1",
  "base": "759938e7056eca4a094ff3077f9abb81ebb495fd", "head": "5df0e60dc530b6a61b7bd094c72dbbe9dbd57d80",
  "changedPaths": [
    "apps/api/src/composition-root.ts", "apps/api/src/main.ts", "apps/web/src/app-server.ts",
    "apps/web/src/component-registry.ts", "apps/web/src/customize-screen.ts", "apps/web/src/document-http.ts",
    "apps/web/src/surface-client.ts", "apps/web/src/surface-runtime.ts", "db/migrations/0044_document_attachments.sql",
    "db/schema.snapshot.json", "packages/canonical-model/src/documents.ts", "packages/canonical-model/src/normalize.ts",
    "packages/canonical-model/src/schemas.ts", "packages/compiler/src/compiler.ts", "packages/compiler/src/diff.ts",
    "packages/compiler/src/documents.ts", "packages/compiler/src/projections.ts", "packages/compiler/src/protocol.ts",
    "packages/customization/src/apply.ts", "packages/customization/src/patch.ts", "packages/customization/src/render.ts",
    "packages/customization/src/targets.ts", "packages/postgres-provider/package.json", "packages/postgres-provider/src/composed-application-runtime.ts",
    "packages/postgres-provider/src/customization-service.ts", "packages/postgres-provider/src/document-attachments.ts", "packages/postgres-provider/src/document-content.ts",
    "packages/postgres-provider/src/document-publication.ts", "packages/postgres-provider/src/request-runtime-view-service.ts", "packages/runtime/src/document-gateway.ts",
    "packages/runtime/src/request-runtime-view.ts", "packages/runtime/src/semantic-operation-gateway.ts", "packages/runtime/src/semantic-query-gateway.ts",
    "pnpm-lock.yaml", "test/architecture/release-persistence-boundary.test.ts", "test/architecture/repository-hygiene.test.ts",
    "test/architecture/tenant-completeness.manifest.json", "test/architecture/tenant-completeness.test.ts", "test/evidence/DOCS-1.expected-red.json",
    "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/integration/document-http.test.ts", "test/postgres/document-attachments.test.ts",
    "test/postgres/inventory-storage.test.ts", "test/postgres/migrations.test.ts", "test/postgres/module-storage-transition.test.ts",
    "test/postgres/request-runtime-view.test.ts", "test/postgres/trust-substrate.test.ts"
  ],
  "symbols": [
    {"path": "packages/postgres-provider/src/document-attachments.ts", "name": "PostgresDocumentGateway"},
    {"path": "packages/compiler/src/documents.ts", "name": "compileDocuments"},
    {"path": "packages/postgres-provider/src/document-publication.ts", "name": "PostgresDocumentPublication"},
    {"path": "apps/web/src/document-http.ts", "name": "mountDocumentHttp"}
  ]
}
```
