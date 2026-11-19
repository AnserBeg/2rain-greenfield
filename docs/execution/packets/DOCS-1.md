# DOCS-1 — documents, files, templates and signatures

Slice 0 and the binding Fable amendment are docs-only. Slice 1a is authorized.

## Claims

1. Documents store immutable scoped versions and inherit live permission from an actual record.
2. Customize adds file fields through an approved release.
3. A signing receipt attests to an exact version and protects its bytes while retained.

## Decisions

- [ADR-0078](../../decisions/ADR-0078-governed-documents-files-templates-and-signatures.md) sets the design after the 2026-11-19 Fable read.
- PostgreSQL stores bounded blobs. Production upload waits for a scanner. The local demo uses a labelled pass-through.
- The first Documents slice takes the next free surface reader rung at integration. Templates and signatures each get their own rung.
- Tenant-shared documents can link down to company records under live read checks on both targets.
- Templates render with pinned PDFKit in an OS sandbox. Signing waits for sign-in.

## Slices

0. Design and Fable amendments.
1a. Internal attachments and file fields.
1b. Customer upload requests, following the external-identity ruling.
2. Templates and PDF.
3. Signatures, following sign-in.

## Gates

Run `scripts/check-records.sh` for the docs-only amendment. No runtime guarantee is claimed by this checkpoint.

## Test it yourself

Read ADR-0078 and confirm that production uploads wait for scanning, a shared document can
link to a company without exposing the governing record, and signing waits for sign-in.
