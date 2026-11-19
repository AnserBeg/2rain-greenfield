# DOCS-1 — documents, files, templates and signatures

Slice 0 is a docs-only proposal for plan N2-02. Implementation stops pending the
orchestrator's Fable ruling. No Critical path touched.

## Claims for the design read

1. The Documents capability stores scoped immutable versions and governs access through an
   actual business record.
2. Business owners can add file and signature fields, upload categories and PDF templates
   through the approved customization path.
3. A signature attests to one exact PDF version. Retention and recovery preserve its
   evidence or enforce an approved purge.

## Decisions

- [ADR-0078](../../decisions/ADR-0078-governed-documents-files-templates-and-signatures.md)
  proposes bounded PostgreSQL `bytea` storage and a content gate before any link publishes.
- Templates use pinned Semantic Queries and sandboxed PDFKit. Document writes use Semantic
  Operations.
- The first feature-bearing release proposes surface floor 28 and must reproduce existing
  releases with Documents absent.
- The charter named ADR-0075. Main already owns ADR-0075 and ADR-0076, and CUSTOMIZE-3
  claims ADR-0077 in [PR #115](https://github.com/AnserBeg/2rain-greenfield/pull/115).

## Slices

0. Design and orchestrator read. See the check below.
1. Storage, file fields and customer upload categories.
2. Custom templates and server-rendered PDF.
3. Signature fields, capture and verification.

## Gates

- Run `scripts/check-records.sh` for the docs-only change. Hosted CI runs on the integrated
  SHA.
- The Fable read is the implementation gate. This slice makes no runtime claims.

## Test it yourself

Run `scripts/check-records.sh` from the repository root. Expect exit status zero. Open
[the proposal](../../decisions/ADR-0078-governed-documents-files-templates-and-signatures.md)
and trace three cases. An upload must remain private until its scan passes. A user from a
second company must be refused an existing version link. A signature must still verify
against the original PDF after a successor is issued.
