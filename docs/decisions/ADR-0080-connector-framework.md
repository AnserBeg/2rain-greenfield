# ADR-0080. Company connectors for addresses, maps and email

Proposed on 2026-11-19 for the orchestrator's Fable read. Implementation starts after its ruling.

An office worker should be able to add a delivery address to a record type they created,
save it during a Maps outage, and email a particular document to a customer. These are the
first two uses of the Integration family. The company chooses the provider connection.
The record and the message remain ERP objects with their own permissions and history.
The owner's rentals survey (§D) supplied the use cases. The framework serves the N2 email
binding and leaves the broader N5 stage gate open.
[Plan §§12.2, 12.5, 12.8 and 12.12](../greenfield-north-star-erp-platform-plan.md#122-full-capability-families)

## What the host registers

A versioned connector SDK pairs a host-owned adapter with an immutable
`ConnectorDefinition`. The definition has a stable connector ID, contract version,
schema version and implementation digest. A release pins the exact registration and
mapping revision. A company installation binds that registration to a provider account
and named credential slots. This lets two companies use the same release with different
accounts and lets an existing delivery retain its original meaning after an upgrade.

| Member | Required contract |
| --- | --- |
| Outbound operation | Stable ID and version, read or effect, bounded input and output schemas, classifications and permitted fields, destination profile, key derivation and provider deduplication window, per-attempt deadline, retryable outcomes, backoff bounds, attempt and age limits, quota unit and rate/concurrency limits. Each operation specifies how to reconcile an uncertain result. |
| Inbound endpoint | Stable ID and version, bounded body and event schemas, provider verifier and signed fields, freshness rule, stable provider event ID, account binding, allowed event kinds, typed mapping to a named Semantic Operation and its narrow service grant. A connector with no callbacks declares an empty endpoint list. |
| Health check | Named, bounded, read-only probe with its own deadline, frequency and quota. Report installation status, last check and safe reason to authorized operators. Separate invalid credentials, rate limiting and temporary provider failure. A probe must never send a message or mutate a business record. |

For example, `places.suggest` takes bounded text, a locale and an opaque editing-session
handle and returns a bounded list of display labels and selection handles. Bind each handle
to that session, field and company. Read operations use a scoped request key and a short
deadline. `email.send` takes a confirmed message revision and exact document-version handles
and returns the provider message ID and acceptance time. The asynchronous delivery result
arrives through the inbound contract.

The compiler checks both ends of every mapping, including types, bounds, required values,
disclosure and company scope. The host validates requests and provider results. An unknown
version, undeclared target, invalid result or missing adapter gives a typed refusal.
Only the host connector runtime can reach provider networks. Each adapter owns fixed HTTPS
destinations, methods and paths. Forbid caller-supplied URLs, redirect following, raw headers
and executable mappings. Bound request/response bytes and elapsed time.

The browser and assistant invoke a release-declared Semantic Query for a lookup or a
Semantic Operation for an effect. The gateway checks the caller, record access and company
installation before disclosure. A later workflow host call must invoke the same wrapper,
journal its result and enforce the run's release, grant and confirmation rules. A replay
returns its recorded result, subject to data retention. Where the result cannot be durably
journaled, exclude the query from the workflow SDK. WORKFLOW-1 keeps its present call set.
[ADR-0073, external delivery](ADR-0073-workflow-isolate-and-authority.md#timers-signals-and-external-delivery)

## Who can connect a company

Real email and maps calls stay in explicitly enabled local demo mode until SIGNIN-1 slice 2
proves the decision and verification boundaries. In the pilot, connecting a provider and
confirming an outward send each require a consumed proof for the exact reviewed terms.
Connector consent, installation, delivery and document gates still apply.
[Staff decision authority](ADR-0081-staff-sign-in-and-decision-authority.md#human-decisions-and-activation-evidence)

An authorized administrator chooses a registered provider in company settings, binds the
required credential slots, checks the account identity and enables the approved operations.
Display the company, provider account, allowed purposes, status and last check. Enabling,
rotating, pausing and revoking are audited. The host derives tenant and environment from
trusted context and checks permission for the selected legal entity. For a company-owned
record it checks the stored owner. A tenant-shared record requires an explicitly authorized
acting company for egress. Keep that company's enrichment, deliveries and receipts scoped
to it. Without a usable installation the address still accepts text.

Store only opaque secret references in scoped installation state. Definitions and patches
declare slot names. The vault resolves a slot only for the matching tenant, environment,
company, installation, account and purpose. Resolve at use time so rotation can advance a
version atomically. Check account continuity on rotation. Changing provider accounts requires
a new installation and explicit approval of new work. Retire outbound credentials immediately
on revocation. Allow a time-bounded overlap of inbound verification keys during planned
rotation and record which version verified the event.

Scope storage keys, foreign keys and row-level access to the installation's tenant and
environment. Enforce company ownership on every lookup, claim, receipt, replay and admin
view. A service principal receives only its mapped queries and operations. Restoring a
backup requires reconciling potentially sent work against the provider before resuming.

For the local demo, `NORTH_STAR_CONNECTOR_KEY_FILE` names an owner-readable file outside
the checkout. The host reads only the scoped entries for the chosen installation, following
the agent's key-file pattern. A missing or unreadable entry marks that installation
unconfigured. Keep keys, OAuth tokens and signing secrets out of packages, patches, browser
responses, outbox payloads, logs, exceptions and assistant context. Diagnostics use allowed
codes and correlation IDs, including for provider errors and credential-bearing map URLs.
CI injects deterministic fake adapters in a network-disabled provider transport and never
resolves a real credential. [Agent key-file loader](../../packages/operations-agent/src/keys.ts)

## From a committed change to a provider receipt

1. The governed write commits the business change, audit and existing
   `platform.trust_outbox` row in one transaction. For each requested effect commit a
   scoped immutable intent linked to that row and effect slot. Capture the release ID/root
   and fence, actor, authorization or confirmation reference, installation/account, wrapper
   and mapping versions, destination and digest of the canonical request. Keep sensitive
   content in access-controlled versioned storage and refer to its exact version from the
   intent. Rollback produces no dispatchable work. A workflow's existing effect outbox
   invokes this wrapper once under its journaled occurrence key. One connector worker owns
   the external send. [Trust outbox](../../db/migrations/0006_trust_substrate.sql)
2. Give the occurrence a stable, opaque provider key unique to scope, installation,
   operation and occurrence. Bind it locally to the destination and request digest.
   Concurrent submissions of the same occurrence return the same receipt. A different
   digest under the same key is a conflict. An intentional second send needs a new confirmed
   occurrence. Retries retain the original key, payload, release and provider account.
3. A scoped worker claims a committed intent with a renewable lease and fencing token.
   Persist the attempt and earliest possible send time before network I/O. Recheck active
   release/fence, grants, installation, consent and referenced data access at dispatch.
   Hold stale or revoked work for review. An upgrade or rollback cannot reroute it or
   revive an old confirmation. Enforce quotas across workers per provider account and per
   installation/operation. Honor provider backoff, inject a monotonic clock for elapsed
   budgets and persist retry deadlines for restart.
4. Record a provider receipt and attempt outcome durably. Provider acceptance, delivery,
   bounce and permanent failure are distinct facts. After timeout, crash or lease loss,
   reconcile the original attempt before resending. Retry on proven non-acceptance or under
   a still-valid provider deduplication guarantee, allowing for in-flight attempts and the
   original window. A lease alone cannot prevent a duplicate external send. If acceptance
   is ambiguous and neither protection applies, park it for reconciliation.
5. Retry transient failures with bounded exponential backoff and jitter. Permanent or
   exhausted failures enter a company-scoped dead-letter queue with an inspectable reason.
   An authorized operator can look up the original receipt, record evidence, or replay
   under the same key and checks. Preserve attempt history. A periodic reconciler checks
   pending/uncertain deliveries against provider evidence and reports unresolved differences.

For inbound traffic the host resolves a registered route to an installation. Verify the
signature on the provider's prescribed raw bytes and signed metadata, freshness and provider
account before accepting an event. Scope a unique inbox entry by tenant, environment,
company, installation, endpoint and provider event ID. Record a payload digest, verifier key
version, timestamps and the initially resolved release/root, mapping and correlation.
An identical authenticated duplicate receives the existing acknowledgement. A changed body
under that ID is quarantined. Keep deduplication evidence through the provider's redelivery
and supported replay horizon. Refuse deliveries outside that horizon unless independently
reconciled. Acknowledge only after durable capture.

Dispatch the pinned mapping through the Semantic Operation gateway with that inbox identity
as its idempotency key and the scoped service principal. Resolve the business target from
the verified account and stored correspondence. The body cannot choose the tenant, company,
release, principal or operation. Link operation receipt and audit to the event. A crash
after commit recovers the receipt through the same key. Hold missing correlation, stale
bindings or an out-of-order event until reconciliation can determine the permitted state
transition. Record verified duplicates without repeating a business change.

## What a business owner publishes

In Customize, select any first-party or tenant-authored record type and add an **Address**
field, optionally showing its map in a Record section. Or add **Email this document** to
the Record command bar and choose a declared document relation and recipient source.
Use closed, add-only patch kinds `addAddressField` and `addDocumentEmailAction` with
stable target and binding IDs and a per-payload schema version. Both compile against the
pinned base. Refuse incompatible
types, duplicate IDs, missing consumers and classifications that forbid the transfer.
The builder and assistant show the same diff, verify with fakes, obtain approval and
activate by compare-and-swap. Provider account selection and credentials stay in company
settings. Publishing a field cannot enable egress for another company.

Admit optional v6 declarations only with exact byte/root reproduction for existing
first-party and tenant-patched releases when absent. Emit a versioned connector projection
only when used. Verify the declaration, projection and required query, operation and surface
bindings in both directions. The serving surface reader on main at `6b2d28da` implements
through 26. Assign Address the **next implemented rung** on the mandatory surface manifest
when its code merges. For example, if Workflow and file fields land first at 27 and 28,
Address takes 29. Allocate the email action its own rung when it lands. Each reader must
implement all preceding rungs, and each release takes the maximum required by its features.
Fetch main, assign the next free rung, regenerate the affected artifacts and tests and run
CI. Fetch immediately before pushing and repeat if another implementation landed. An actual older
reader must refuse before serving, and a parser missing a patch kind must refuse replay.
Reproduce original roots before upgrade replay and retain the serving release on refusal.
Deploy only binaries supporting the newest patch parser and surface reader any tenant has
used. Release rollback hides retired fields/actions, preserves authorized history and
suspends pending work. A canonical change that cannot satisfy absence parity returns for a
language ruling. [ADR-0074](ADR-0074-formula-rule-and-workflow-projection-admission.md#decision)
· [DOCS-1, ADR-0078](ADR-0078-governed-documents-files-templates-and-signatures.md)

## The first two slices after approval

**1. Address and Maps.** The field stores the user's text and a field revision. An
authorized, rate-limited Places autocomplete query returns a bounded list of suggestions
for the current input. Discard late responses. The worker can select an offered address or
keep typing and save. Saving commits locally even if Google times out. With enrichment
enabled, queue geocoding for that revision. On completion a governed operation checks the
record, field revision, installation and release before attaching the latitude/longitude
pair and its source, precision and expiry. Validate coordinate ranges and display a pin
only for a current, usable result. A late reply for an edited address cannot move the pin.
Use scoped enrichment storage with expiry for provider-derived data. Preserve the worker's
text when enrichment expires. Show “Address saved · locating” while queued and “Address
saved · map unavailable” on failure. A retry operates on the current revision.

Serve an optional attributed Google Static Maps image through a scoped host query. Give
the image a text equivalent and allow ordinary text entry without scripts. Keep suggestions
and map images transient. Keep the user's input distinct from Google content. Apply the
installation's applicable regional attribution and retention rules to results, including
whether a selected address can be retained and how long geocodes may be cached. Disable
unsupported retention or display modes. The CI fake supplies known suggestions and
coordinates, delayed/out-of-order results, quota exhaustion and outages. On an office
record and a custom record, observe the saved text, the eventual correct pin and isolation
between companies. [Places policies](https://developers.google.com/maps/documentation/places/web-service/policies)
· [Maps service-specific terms](https://cloud.google.com/maps-platform/terms/maps-service-terms)

**2. Email.** Use a provider API with a send key and signed delivery events, initially
Resend. Its 24-hour key lifetime gives the worker a bounded interval for safe retries.
Expose provider-neutral send and status contracts. The Communication capability owns
thread, participant, message revision, verified sender, recipient, consent, delivery state,
retention and inbound correlation (N2-03). The Document action selects a readable, clean
immutable version through DOCS-1. Confirm the company, sender, recipients, message and
exact attachment version/digest before queuing. Read its bytes only through Documents at
dispatch. Revoked access, an unavailable version or a changed recipient holds the send.
The record shows queued, accepted, delivered, bounced or needs attention from governed
receipts. Correlate verified callbacks to the stored company, provider message ID and
recipient. A late acceptance cannot clear a bounce. [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys)
· [Webhook verification](https://resend.com/docs/webhooks/verify-webhooks-requests)

The N2-04 proof uses a deterministic fake mail service with an acceptance ledger. Crash
after acceptance and before the local receipt, then count exactly one accepted message
after recovery. Exercise duplicate callbacks, bounce, expired keys, credential rotation
and operator replay. Check that an unknown outcome beyond the provider window stays held
and a revoked document or consent yields zero new sends. Release the document action when
the DOCS-1 version/read contract and N2-03 message and consent contracts are available.

## Later connectors

| Connector | Framework support its own vertical needs |
| --- | --- |
| Stripe | Bind the merchant account and payment/refund occurrence. Use hosted payment references, scoped idempotency, signed events and settlement reconciliation. Money changes enter their own confirmed Semantic Operations. |
| QuickBooks | Bind the OAuth grant to one company and realm. Serialize token refresh and rotate scoped references atomically. Version account/tax mappings, persist backfill and incremental cursors, reconcile remote IDs and revisions, and surface conflicts before posting. |
| SMS | Bind a verified company number, consent and opt-outs per recipient. Enforce throughput limits, correlate signed inbound messages and delivery receipts, and recheck suppression before a queued send. |
