# ADR-0078. Governed documents, files, templates and signatures

Date: 2026-11-19

Status: Accepted with the orchestrator's 2026-11-19 rulings after Fable's independent read.

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
  actual bytes during transfer, before buffering the full body, and cap each API process at two byte reads and two byte writes in flight. Acquire a
  slot before buffering or loading bytes and hold it until completion or cancellation.
  Use a 30-second response deadline measured with a monotonic clock. Apply a 100 MiB
  stored-byte quota per tenant and environment across ownership scopes. Charge each
  distinct stored blob once per ownership scope, with a transactional quota check.
  Separately cap persisted staging at 40 MiB per tenant and environment. Refuse excess
  before publication. Backup and restore carry the full retained blob set, so capacity
  and recovery rehearsals include a tenant at quota. Check restored digests and quota
  totals before serving.
- The versioned platform enum `DocumentContentTypeV1` initially admits PDF, standard
  JPEG and PNG. Categories reference enum members. An allow-list change versions the
  platform enum without changing patch payload keys. Use the server-detected
  type from byte sniffing and bounded format validation. Refuse invalid, ambiguous or
  mismatched content, encrypted PDFs that cannot be inspected, active or embedded PDF
  content, and files outside the allow-list. Ignore the original filename as a path.
  Categories can narrow MIME types and size. The browser's file picker and camera use the
  same admission path.
- Stage bytes privately under a server-issued upload ID with a 24-hour expiry. A versioned
  malware and content-policy adapter scans the exact bytes and records a scoped verdict
  bound to their digest. Production uploads remain disabled until a real scanner that inspects bytes is bound.
  The explicitly enabled local demo uses a scanner labelled **Demo only — malware
  scanning disabled**. The demo adapter cannot authorize a production upload. Pending scans, timeouts and
  errors keep bytes unavailable, with retries against the same staged input. Rejected bytes
  never become readable or attachable. A missing or stale clean verdict refuses publication.
  Publication rechecks current policy and can be safely replayed. A later quarantine blocks
  access without changing version bytes or evidence. Attachment downloads use validated
  content type, attachment disposition, no sniffing and private, non-cacheable responses.
- Compute SHA-256 over the admitted bytes on the server. Deduplicate on digest within the
  same tenant, environment and stored ownership scope (shared or one company). Keep distinct
  document IDs, version IDs, metadata, retention and audit even when bytes match. A
  duplicate still goes through the same validation and scanning path. Serialize
  publication and purge by tenant, environment, ownership scope and digest, and count
  references inside that same scope. Return the same response shape and schedule the
  same visible admission phases for new and duplicate bytes, including matching
  quota refusals when a full upload would exceed the remaining quota. Do not expose a
  digest lookup or a timing shortcut for existing bytes. A digest is integrity evidence. Requests address a governed link and version by
  opaque ID.

## Record links, versions and retention

- Bind document operations to a compiler-declared record type, its exact read and ownership
  policy, and an optional field or category ID. Use the same binding for built-in and tenant
  types. The write transaction resolves and locks the actual stored record, verifies its
  revision where applicable, and checks tenant, environment and ownership from trusted
  context and stored rows. A company-owned document can link only to records in its own
  company. A tenant-shared document can link down to a company record as a secondary link.
  A company-owned document cannot link up to a shared record or across companies. Refuse a
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
  check and current policy epoch verification before the first response byte. Authorize the complete response once and finish
  within its bounded response deadline. Each subsequent request gets a new decision.
  [ADR-0071](ADR-0071-read-decisions-are-live-per-request-writes-per-call.md)
- A version is immutable upon publication and has its own ID, digest, creator and creation
  time. Replace and restore append versions with explicit predecessor or restoration
  references. Changing a field's selected version uses a governed operation with optimistic
  concurrency. The original signing scope stays fixed, including when a successor is issued.
  Archive records and links through lifecycle operations. Normal record reads respect
  archive state. A separately authorized archive view can still retrieve retained versions
  under the same ownership and access checks. On merge, retain the losing record as the archived governing identity. A
  governed merge may create a secondary link on the survivor under the same scope and
  dual-read checks. It never silently transfers ownership or broadens visibility.
  Through that link, the archived source must still pass its authorized archive read.
- Record a minimum retention rule per version and its signature evidence. Current retention
  policy may extend that minimum. With no applicable retention period, retain until an
  administrator assigns one. Active references, unexpired retention and legal holds block
  purge. Retaining a signing receipt also blocks purge of its signed bytes. An authorized retention administrator previews the exact candidates and reason,
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

- Admit `files` and `signature` fields on any record type with a supported
  ownership and read binding. A `files` field is a governed collection of exact-version
  links. The `addDocumentField` payload carries `maxCount` (1–20, with 1 for a single
  file), `required` and `allowedCategoryIds` (an empty list permits uncategorized uploads).
  A dedicated versioned widening patch may raise `maxCount` or add allowed categories.
  Narrowing is refused because published links and replay keep their original meaning.
  Requiredness is checked on completion of a declared document task. Saved records may
  exist before attachments are supplied. A `signature` slot binds an exact document
  version, supplied by a declared template or upload category. Its payload specifies
  ordered signer roles and capacities and the consent text ID and version. The slot
  stores signing evidence references.
  These are typed references through the Documents capability. File bytes, digests supplied
  by callers, and signature evidence are outside generic field-write input. The compiler refuses document fields
  as inputs to a Tier B capability or its dependency set.
- Reuse the Record section for attachments, the Task flow for requests and signing, and
  Customize for document field, category and template changes. The shared attachment control
  operates on saved records, including types with no configured upload categories. Audit
  events appear in the record's existing activity view.
- Add an **Upload categories** list to Customize. A category has a stable ID, label, owning
  record type and file field, type and size restrictions, a count limit, and whether that
  item is required to complete the request. It also carries a retention class, visibility
  (`internal` or `customer`) and an optional document expiry date. That date describes
  the document's validity and does not schedule purge. Categories appear as separately labeled controls
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
  template, and template revision wherever applicable. Every kind carries a required
  per-payload `schemaVersion`. A later key on a closed payload requires a new parser
  version. In the initial vocabulary, rollback is the only way to remove a field or
  category declaration from the active release. Relabeling and reordering wait for
  explicit versioned operations. Original IDs and saved links are preserved. Compile references against the pinned
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
  both directions. Assign each new mandatory surface-reader rung at merge from the highest rung on
  `origin/main`. There are no reservations. A reader that claims a rung must
  implement every rung below it. File fields, templates and signatures each get
  their own rung when they land. Regenerate affected artifacts and tests, rerun CI
  and fetch again before pushing. Renumber if another capability landed first. Require a compatible patch parser and
  consumer readers before serving. Demonstrate refusal with the actual older reader and
  prove exact original-root reproduction before admitting each new kind to upgrade replay.
  Each slice verifies its own older-reader refusal. Keep deployed code at or above the newest patch-parser and surface-reader
  floors any tenant has used. A required key, materialized default or changed meaning of an
  existing v6 node returns for a canonical-language ruling.
  [ADR-0047](ADR-0047-the-compiler-semantic-profile-is-the-projection-evolution-axis.md) ·
  [ADR-0073](ADR-0073-workflow-isolate-and-authority.md#release-admission-and-verifier-scope)
  · [ADR-0074](ADR-0074-formula-rule-and-workflow-projection-admission.md#decision)

## Templates and PDF

- `DocumentTemplateDefinition` is a versioned object with a stable template ID, an admitted
  record type, document kind (quote, purchase order, invoice, work order or contract), page layout,
  and typed data bindings. Each revision pins locale, time zone, currency, date and
  number formats, and page size. The issued identity comes from the governed source
  operation or query and is stored with the version. Preview has no issued identity.
  A release selects one active revision per template with an explicit pointer.
  Activation may advance or retire that pointer through a versioned patch. Retirement
  ends new generation while retained versions keep their original revision. The first layout supports
  headings, text, line tables and page numbers. Use predefined
  fonts and sanitized PNG/JPEG bytes for company logo assets. A compiler resolves named bindings only to
  declared Semantic Queries and typed result fields. Bound cardinality and permitlist the
  output positions. The template has no expressions, scripts, raw HTML, paths or URLs. The
  published query supplies money, totals and other business facts. Missing, hidden or
  truncated required values refuse rendering.
- A preview or generate call resolves the target and executes all bindings under one pinned
  release and a governed read snapshot. The runtime checks classification for output and
  records the resolved source dependencies as a read restriction on the artifact. A later
  read must satisfy the governing record and the recorded source access requirements,
  including field restrictions. Reclassification can therefore withdraw access to a
  previously issued customer copy. Unresolvable authorization dependencies refuse access.
  A customer-facing signing request gives the named contact read access to the exact version
  only when current record policy and the classification of every rendered field permit
  that disclosure. A template approval or signer grant alone cannot release restricted data.
  Tenant template approval binds the exact revision and shows the target type, visible
  content and bound query fields before activation.
- Render server-side with pinned PDFKit in the ADR-0073 QuickJS WebAssembly isolate or in
  a separate unprivileged Linux process. The isolate supplies no host I/O or callbacks and
  enforces heap, CPU and wall-time limits. A separate process requires a fresh network
  namespace with no network interfaces attached, seccomp denial of socket creation, a
  read-only packaged runtime, pipe-only input and output, and OS memory and CPU limits.
  Refuse rendering if the chosen boundary is unavailable. The isolated renderer receives
  only formatted values, predefined fonts and checked image bytes. Bound input rows,
  image expansion, runtime, memory, pages and output bytes.
  Before publishing, apply
  the file content gate and recheck the pinned release, recorded source revisions, current
  grants and target state. Store the resulting bytes as a normal version, together with
  template revision, source query and record revisions, release root and renderer version.
  DOCS-1 ships with a company-brand resolver using the company record name, the Ledger print palette and no logo. Shared records use the Ledger name. Each issued PDF stores `platform-default` as its brand revision until UI-COMPOSE-1 supplies approved company revisions.
  Retry by idempotency key and input digest. A later render creates a new version.
  [PDFKit stream API](https://pdfkit.org/docs/getting_started.html) ·
  [PDFKit images](https://pdfkit.org/docs/images.html) ·
  [Linux network namespaces](https://man7.org/linux/man-pages/man7/network_namespaces.7.html)

## Signing and attribution

- Gate signature capture on the sign-in packet. External signers also require the
  external-identity ruling. This design supplies attribution and tamper evidence.
  It makes no claim of legal sufficiency.
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
  digest, template revision and release root when applicable, consent text version and
  digest, capture digest, signer, signer role and capacity, sequence and signing instant,
  authentication method and assurance level, and outcome. Decline and void are separately
  audited outcomes with their own receipts. Earlier receipts remain verifiable. Do
  not retain IP addresses or user-agent strings for signature evidence. An isolated platform
  signing key signs the receipt and records its key ID. Retain the corresponding
  verification keys across rotation. An authorized verifier checks both the receipt
  signature and the digest of the stored PDF. Return the signed receipt alongside the
  unchanged PDF. Corrections or replacements use a new version and a new signing action
  while preserving the original record.

## Assistant and workflow access

Expose authorized document metadata, status, versions and scoped handles through Semantic
Queries. Initial agent and workflow contracts expose metadata only. Filenames and
category labels are untrusted data in discovery, presented to the model as values.
Sending to a customer is an outward-disclosure confirmation-class operation, which
requires an explicit yes to the exact recipient and document version. They can request a
generated document or attach an already admitted version through declared Semantic
Operations when current permissions, the exact target scope and applicable confirmations
allow. Signing is reserved to the human principal. Upload ingress only transfers staged
bytes against a scoped operation grant. Publishing, linking, generating, requesting
signatures, signing, archiving and administrative purge are Semantic Operations with
transactional audit and idempotency. Connector delivery follows the outbox. Workflow actors
and resumed runs retain ADR-0073's pinned release, live grant checks, confirmation on Tier B
dependencies and exact replay. Document fields cannot supply posting inputs under this
admission. [ADR-0073](ADR-0073-workflow-isolate-and-authority.md#authority-boundaries)

## Delivery slices

1a. **Internal attachments and file fields.** Upload, list, preview and download on
saved first-party and tenant-authored records. Add file fields through Customize.
Prove live access, scope and content refusals, demo scanner gating, dedupe, quotas,
bounds and rollback. Check image capture on an image-capable mobile device.

1b. **Customer upload requests.** Wait for the external-identity ruling. Add upload
categories, named customer requests and scoped submissions, with required-item
completion, expiry and revocation.

2. **Templates and PDF.** Activate a branded template through Customize for a
   commercial record and a tenant-authored record. Prove older-reader refusal,
   absence parity, source restrictions, network isolation and bounded failures.
   A retry returns the same stored version.
3. **Signatures.** Wait for sign-in. Activate a signature field and sign a specific
   PDF. Prove concurrent and stale signing refusal, tamper detection, verification
   after key rotation, and retention on restore.

Each slice proves its silent-harm claims against stored bytes, links, policy
decisions and audit rows.
