# ADR-0078. Governed documents, files, templates and signatures

Date: 2026-11-19

Status: Proposed for the orchestrator's read. Implementation requires its ruling.

## Context

N2-02 needs one Documents capability for first-party and tenant-authored records. An office
worker can attach a file, request named items from a customer, generate a branded quote,
purchase order or invoice from saved data, and ask someone to sign a specific version. A
business owner can configure the same actions for a new record type in Customize. The
rentals survey (§B–C) supplied the use cases for labeled upload slots, mobile photo capture,
branded printouts and in-place signing. The implementation follows the
[plan (§12.5)](../greenfield-north-star-erp-platform-plan.md#125-n2---workflow-documents-and-communication-substrate).

## Storage and content policy

- Store immutable bytes in a dedicated PostgreSQL `bytea` table behind a provider interface
  with scoped put, read and retention operations. Store version metadata and links
  separately so record queries can read filenames and status without loading bytes. The
  initial size limit makes ordinary TOAST-backed rows practical, and bytes, references and
  audit commit or restore together. Large objects introduce a separate permission and
  cleanup lifecycle. An object-store provider would need measured justification and
  equivalent commit, recovery and purge guarantees.
  [PostgreSQL 16 TOAST](https://www.postgresql.org/docs/16/storage-toast.html)
- Limit each upload or generated PDF to 20 MiB, with a lower category limit allowed. Bound
  actual bytes during transfer, before buffering the full body, and bound concurrent staging
  and bytes per scope. Initially allow PDF, standard JPEG and PNG. Use the server-detected
  type from byte sniffing and bounded format validation. Refuse invalid, ambiguous or
  mismatched content, encrypted PDFs that cannot be inspected, active or embedded PDF
  content, and files outside the allow-list. Ignore the original filename as a path.
  Categories can narrow MIME types and size. The browser's file picker and camera use the
  same admission path.
- Stage bytes privately under a server-issued upload ID with a 24-hour expiry. A versioned
  malware and content-policy adapter scans the exact bytes and records a scoped verdict
  bound to their digest. The production adapter must scan bytes. Pending scans, timeouts and
  errors keep bytes unavailable, with retries against the same staged input. Rejected bytes
  never become readable or attachable. A missing or stale clean verdict refuses publication.
  Publication rechecks current policy and can be safely replayed. A later quarantine blocks
  access without changing version bytes or evidence. Attachment downloads use validated
  content type, attachment disposition, no sniffing and private, non-cacheable responses.
- Compute SHA-256 over the admitted bytes on the server. Deduplicate on digest within the
  same tenant, environment and stored ownership scope (shared or one company). Keep distinct
  document IDs, version IDs, metadata, retention and audit even when bytes match. A
  duplicate still goes through content and access policy, and its response reveals no other
  reference. A digest is integrity evidence. Requests address a governed link and version by
  opaque ID.

## Record links, versions and retention

- Bind document operations to a compiler-declared record type, its exact read and ownership
  policy, and an optional field or category ID. Use the same binding for built-in and tenant
  types. The write transaction resolves and locks the actual stored record, verifies its
  revision where applicable, and checks tenant, environment and ownership from trusted
  context and stored rows. A company-owned document can link only to records in its own
  company. A tenant-shared document can link only to tenant-shared records. Refuse a
  missing, archived or out-of-scope attachment target. Store scope-qualified references and
  enforce row-level security and least-privilege grants on the document tables as a second
  boundary behind the Semantic gateways.
- Each document has one immutable governing record. Secondary links are explicit and pin an
  exact version. To read through a secondary link, the actor must be able to read the
  governing record and the secondary target. Linking requires read and attach authority on
  both and cannot change a version's source restrictions. Listing, version history, preview
  and download all recheck current record, field and document policy. A direct ID,
  previously issued download URL or role change confers no continuing authority. Internal
  uploaders need their record's attach operation and document upload grant. Readers need the
  record's read permission and applicable document permission. Downloads add a byte-read
  check and current policy epoch verification before the first response byte.
  [ADR-0071](ADR-0071-read-decisions-are-live-per-request-writes-per-call.md)
- A version is immutable upon publication and has its own ID, digest, creator and creation
  time. Replace and restore append versions with explicit predecessor or restoration
  references. Changing a field's selected version uses a governed operation with optimistic
  concurrency. The original signing scope stays fixed, including when a successor is issued.
  Archive records and links through lifecycle operations. Normal record reads respect
  archive state. A separately authorized archive view can still retrieve retained versions
  under the same ownership and access checks.
- Record a minimum retention rule per version and its signature evidence. Current retention
  policy may extend that minimum. With no applicable retention period, retain until an
  administrator assigns one. Active references, unexpired retention and legal holds block
  purge. An authorized retention administrator previews the exact candidates and reason,
  then a distinct authorized approver confirms that manifest. Use the same blob lock for
  publication and purge. Recheck all references under that lock before execution. Remove a
  version's byte reference only after approval. Physically remove bytes only when all
  references in that scope are eligible and cleared. Retain version and link tombstones,
  digest, and the approval and purge audit.
  Ordinary UI, assistants and workflows have no physical purge operation. Reapply the purge
  ledger before restored data can be served, and verify that retained references still
  resolve to their original digests.
  [Plan §§7.4–7.5](../greenfield-north-star-erp-platform-plan.md#74-lifecycle-doctrine) ·
  [ADR-0019](ADR-0019-tenant-completeness-and-single-tenant-recovery.md)

## Customize and surface admission

- Admit optional `files` and `signature` fields on any record type with a supported
  ownership and read binding. A `files` field is a governed collection of exact-version
  links, with maximum cardinality one for single-file use. A `signature` field is a slot
  bound to the document version to be signed and stores a reference to the signing evidence.
  These are typed references through the Documents capability. File bytes, digests supplied
  by callers, and signature evidence are outside generic field-write input.
- Reuse the Record section for attachments, the Task flow for requests and signing, and
  Customize for document field, category and template changes. The shared attachment control
  operates on saved records, including types with no configured upload categories. Audit
  events appear in the record's existing activity view.
- Add an **Upload categories** list to Customize. A category has a stable ID, label, owning
  record type and file field, type and size restrictions, a count limit, and whether that
  item is required to complete the request. Categories appear as separately labeled controls
  on a customer request. An authorized employee issues a request against an existing record,
  with exact categories, a named customer contact associated with that record, expiry and
  revocation. Redemption requires an authenticated principal verified as that contact.
  The scoped grant permits submission to those slots and a receipt for their submissions.
  It cannot enumerate records, read other files, or grant itself more scope. Stage and publish both
  recheck that the grant and categories remain active. The form evaluates required items on
  completion using published clean versions. Adding a category leaves existing records
  valid.
- Use additive, closed patch kinds `addDocumentField`, `addUploadCategory`, and
  `addDocumentTemplateRevision`. Carry stable IDs for the record type, field, category,
  template, and template revision wherever applicable. Compile references against the pinned
  base and refuse collisions, unsupported type or scope changes, and missing targets.
  Templates evolve by adding a revision under the same template ID. Immutable revisions and
  published IDs remain available to historical readers. Show the same plain diff, verify,
  approve and activate for visual and assistant drafts. Rollback restores the prior
  definitions and stops issuing requests for retired slots. It retains stored versions and
  signing evidence with their original restrictions. Unavailable bindings fail closed, with
  retained data accessible through the governed archive path once authorized.
- Follow ADR-0047 §7 and the absence-parity and reader rules in ADR-0074. Admit the optional
  v6 declarations only behind exact before/after normalized and compiled byte and root
  parity for a first-party release and a real tenant-runner release without Documents. Emit
  a dedicated versioned Documents projection for declared fields, categories and templates
  and resolve its bindings into the mandatory surface, query and operation catalogs and
  agent discovery. Refuse missing, unknown or inconsistent declarations and projections in
  both directions. The first Documents release raises the mandatory surface reader to
  **floor 28**, following the workflow floor of 27. Require a compatible patch parser and
  consumer readers before serving. Demonstrate refusal with the actual older reader and
  prove exact original-root reproduction before admitting each new kind to upgrade replay.
  Each later slice verifies its own older-reader refusal and adds a floor when its contracts
  require one. Keep deployed code at or above the newest patch-parser and surface-reader
  floors any tenant has used. A required key, materialized default or changed meaning of an
  existing v6 node returns for a canonical-language ruling.
  [ADR-0047](ADR-0047-the-compiler-semantic-profile-is-the-projection-evolution-axis.md) ·
  [ADR-0073](ADR-0073-workflow-isolate-and-authority.md#release-admission-and-verifier-scope)
  · [ADR-0074](ADR-0074-formula-rule-and-workflow-projection-admission.md#decision)

## Templates and PDF

- `DocumentTemplateDefinition` is a versioned object with a stable template ID, an admitted
  record type, page layout, typed bindings, and branding. The first layout supports
  headings, text, line tables, page numbers, colors and a scoped logo asset. Use predefined
  fonts and sanitized PNG/JPEG asset bytes. A compiler resolves named bindings only to
  declared Semantic Queries and typed result fields. Bound cardinality and permitlist the
  output positions. The template has no expressions, scripts, raw HTML, paths or URLs. The
  published query supplies money, totals and other business facts. Missing, hidden or
  truncated required values refuse rendering.
- A preview or generate call resolves the target and executes all bindings under one pinned
  release and a governed read snapshot. The runtime checks classification for output and
  records the resolved source dependencies as a read restriction on the artifact. A later
  read must satisfy the governing record and the recorded source access requirements,
  including field restrictions. Unresolvable authorization dependencies refuse access.
  A customer-facing signing request gives the named contact read access to the exact version
  only when current record policy and the classification of every rendered field permit
  that disclosure. A template approval or signer grant alone cannot release restricted data.
  Tenant template approval binds the exact revision and shows the target type, visible
  content and branding, and bound query fields before activation.
- Render server-side with pinned PDFKit in a resource-bounded worker sandbox. PDFKit draws
  text, tables and images directly to a PDF stream without a browser or an HTML engine. The
  sandbox has no network or credentials and reads only its packaged runtime. Pass typed
  values, bundled font bytes and checked image bytes into the worker. Bound input rows and
  image expansion and cap runtime, memory, pages and output bytes. Before publishing, apply
  the file content gate and recheck the pinned release, recorded source revisions, current
  grants and target state. Store the resulting bytes as a normal version, together with
  template revision, source query and record revisions, release root and renderer version.
  Retry by idempotency key and input digest. A later render creates a new version.
  [PDFKit stream API](https://pdfkit.org/docs/getting_started.html) ·
  [PDFKit images](https://pdfkit.org/docs/images.html)

## Signing and attribution

- Show the exact admitted PDF to the signer before capture. Offer a drawn mark or typed name
  with an explicit **Sign** action and consent text. Bind signing to an authenticated human
  principal, either an authorized user or a verified customer contact holding a grant to
  that exact record, slot and version. The mark and typed name are evidence of intent. The
  server supplies the signer identity, actor scope and UTC capture timestamp from the
  trusted request and service clock. The signer cannot submit another actor ID or a
  timestamp.
- Issue a short-lived, single-purpose signing challenge bound to the signer, record, slot,
  version ID, SHA-256 of the exact PDF bytes and consent text digest. At commit, lock the
  signing slot and version and check the challenge, current authority, publication and
  consent. Refuse a stale, revoked, changed or consumed challenge. An identical idempotent
  retry returns the existing receipt under current policy. Store the receipt and audit
  atomically. The canonical receipt binds purpose, scope, record and version IDs, file
  digest, consent digest, capture digest, signer and signing instant. An isolated platform
  signing key signs the receipt and records its key ID. Retain the corresponding
  verification keys across rotation. An authorized verifier checks both the receipt
  signature and the digest of the stored PDF. Return the signed receipt alongside the
  unchanged PDF. Corrections or replacements use a new version and a new signing action
  while preserving the original record.

## Assistant and workflow access

Expose authorized document metadata, status, versions and scoped handles through Semantic
Queries. Initial agent and workflow contracts expose metadata only. They can request a
generated document or attach an already admitted version through declared Semantic
Operations when current permissions, the exact target scope and applicable confirmations
allow. Signing is reserved to the human principal. Upload ingress only transfers staged
bytes against a scoped operation grant. Publishing, linking, generating, requesting
signatures, signing, archiving and administrative purge are Semantic Operations with
transactional audit and idempotency. Connector delivery follows the outbox. Workflow actors
and resumed runs retain ADR-0073's pinned release, live grant checks, confirmation on Tier B
dependencies and exact replay. Document fields cannot supply posting inputs under this
admission. [ADR-0073](ADR-0073-workflow-isolate-and-authority.md#authority-boundaries)

## Slices after approval

1. **Storage and upload fields.** Add the scoped provider, content gate, versions, record
   attachment controls, customer categories and governed upload on one first-party record
   and one tenant-authored record. Prove scope and revocation refusals, content refusal and
   retry, dedupe without access leakage, rollback, and restore with retention and purge.
   Exercise camera capture on an image-capable mobile device.
2. **Templates and PDF.** Activate a branded template through Customize and produce an
   authorized PDF for an existing commercial record and a tenant-authored record. Use the
   same contract for quotes, purchase orders and invoices as each gains an eligible query.
   Prove older-reader refusal, absence parity, source restrictions, network isolation and
   bounded failure. Retry must return the same stored version.
3. **Signatures.** Activate a signature field and collect a human signature on a specific
   PDF. Prove concurrent or stale signing refusal, immutable content after a new version,
   evidence verification after key rotation, tamper detection and retention on restore.

Each slice proves its silent-harm claims against stored bytes, links, policy decisions and
audit rows. Amend the design after the orchestrator's read before starting any
implementation.
