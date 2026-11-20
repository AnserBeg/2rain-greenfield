# CRITFIX-H — attachment publication and read authority

Critical migration and grants. The packet is open pending the item 8 completion declaration.

1. Runtime reads require live document, record and company grants. Only the scanner can attest a staged digest. Publication commits the blob, version, audit and stage retirement together. Statement triggers protect published versions and audit.
2. The active release supplies the field IDs for the governing entity on each list and byte read.
3. Each published version consumes its full length. Both new and matching content write the payload. Physical deduplication stays within the ownership scope.
4. A monotonic request budget bounds database statements and is checked immediately before committing publication.
5. Concurrent scans lock one stage. A matching negative verdict survives retries. A stale or absent clean verdict refuses publication.
6. The PDF parser bounds object count, nesting and page-tree traversal in a child process with OS address-space and CPU limits and a host deadline.
7. The Files panel requests bounded cursor pages and offers the next page.
8. ADR-0078 assigns required fields to a declared completion. DOCS-1 slice 1a has no such operation. The next declared completion belongs to slice 1b.
9. Enabling the demo scanner requires a dedicated database marked by its owner. The dev launcher verifies the local container before marking it.
## Test it yourself

Run `node --import tsx --test test/integration/document-http.test.ts` and `node --import tsx --test test/postgres/document-attachments.test.ts` with Docker available.
## Gates

Eight regression controls failed against unchanged main code at 552b13d8. [Baseline run](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44685966955). [Packet CI](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44692069750) covers the combined migrations. Integration awaits the item 8 ruling.
```record-claim
{
  "schemaVersion":"northstar.record-claim/v1",
  "packet":"CRITFIX-H",
  "base":"4ed523e803b9a0eb12c7bffe9dc4a85ce231c428",
  "head":"d07403c748ac732ab0147941a1ac8ce283dca017",
  "changedPaths":["apps/api/src/main.ts","apps/web/src/component-registry.ts","apps/web/src/document-http.ts","apps/web/src/surface-client.ts","db/migrations/0047_document_attachment_authority.sql","db/schema.snapshot.json","packages/postgres-provider/package.json","packages/postgres-provider/src/composed-application-runtime.ts","packages/postgres-provider/src/document-attachments.ts","packages/postgres-provider/src/document-content.ts","packages/postgres-provider/src/document-pdf-worker.mjs","packages/postgres-provider/src/request-context.ts","packages/postgres-provider/src/serving-gateways.ts","packages/runtime/src/document-gateway.ts","packages/runtime/src/request-deadline.ts","test/architecture/release-persistence-boundary.test.ts","test/evidence/DOCS-1.expected-red.json","test/integration/document-http.test.ts","test/postgres/document-attachments.test.ts","test/postgres/inventory-storage.test.ts","test/postgres/migrations.test.ts","test/postgres/module-storage-transition.test.ts","test/postgres/trust-substrate.test.ts"],
  "symbols":[{"path":"packages/postgres-provider/src/document-attachments.ts","name":"PostgresDocumentGateway"},{"path":"apps/web/src/document-http.ts","name":"mountDocumentHttp"}]
}
```
