# ADR-0080. Company connectors for addresses, maps and email

Accepted with changes on 2026-11-19 after Fable’s independent read and the orchestrator’s sign-in ruling.

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
schemaVersion and a closed list of member kinds. A future schemaVersion may add a scheduled
pull with a sync cursor or a host-owned token refresh. Readers refuse unknown kinds.
A release pins the contract and mapping versions. Each attempt and receipt records the
digest of the adapter that actually ran. A compatible adapter fix can serve the same release. A company installation binds that registration to a provider account
and named credential slots. This lets two companies use the same release with different
accounts and lets an existing delivery retain its original meaning after an upgrade.

| Member | Required contract |
| --- | --- |
| Outbound operation | Stable ID and version, read or effect, bounded input and output schemas, classifications and permitted fields, destination profile, key derivation and provider deduplication window, per-attempt deadline, retryable outcomes, backoff bounds, attempt and age limits, quota unit and rate/concurrency limits. Each operation specifies how to reconcile an uncertain result. |
| Inbound endpoint | Stable ID and version, bounded body and event schemas, provider verifier and signed fields, freshness rule, stable provider event ID, account binding, allowed event kinds, typed mapping to a named Semantic Operation and its narrow service grant. A connector with no callbacks declares an empty endpoint list. |
| Health check | Named, bounded, read-only probe with its own deadline, frequency and quota. Report installation status, last check and safe reason to authorized operators. Separate invalid credentials, rate limiting and temporary provider failure. A probe must never send a message or mutate a business record. |

For example, `address.suggest` takes bounded text, a locale and an opaque editing-session
handle and returns a bounded list of display labels and selection handles. Bind each handle
to that session, field and company. Read operations use a scoped request key and a short
deadline. `email.send` takes a confirmed message revision and exact document-version handles
and returns the provider message ID and acceptance time. The asynchronous delivery result
arrives through the inbound contract.

A billable interactive read requires an individual request from an authorized editor and the
field’s classification must allow that provider and purpose. Keep it out of workflow SDKs,
bulk iteration and autonomous assistant loops. Before I/O, atomically reserve both volume
and maximum cost against the installation’s limits for the accounting period. Charge unknown
outcomes conservatively. Never log or audit per-keystroke text, including in traces and URLs.
Every effect that discloses data outside the company or sends to a third party requires a
confirmation bound to the exact recipients, content version and provider account. Unattended
sends require an N5 autonomy grant. Interactive address lookup instead uses the classified
read and company enablement checks. A future provider-hosted checkout may redirect the
browser on explicit navigation after confirmation. It grants no scripts or provider API access.

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

Until sign-in packet item 1 closes, connecting, enabling and rotating providers and **every
real-provider call** (including health and interactive reads) require the explicitly enabled,
labelled local demo. The connector worker defaults to off. CI and all other environments
bind only network-free fakes. The runtime can currently assert another principal. Its ability
to fabricate connection authority or a confirmation is filed under [sign-in item 1](../execution/current-plan-archive.md#filed-during-the-freeze).

SIGNIN-1 slice 2 must prove the decision and verification boundaries before the pilot can
make real email or maps calls. Connecting an account and confirming an outward send in
the pilot each consume a proof for the exact reviewed terms. Connector consent, installation,
delivery and document gates still apply.
[Staff decision authority](ADR-0081-staff-sign-in-and-decision-authority.md#human-decisions-and-activation-evidence)

In the demo an authorized administrator chooses a registered provider in company settings, binds the
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

Outside the demo no vault is bound. Real installations report unconfigured until a vault is
chosen. Only the demo operator may provision/rotate a slot in its host-owned file. A future
vault permits a scoped credential administrator to bind/rotate a slot and the host’s token
refresh service alone to replace an OAuth token for its already-bound installation and account.

For the local demo, `NORTH_STAR_CONNECTOR_KEY_FILE` names an owner-readable file outside
the checkout. The connector loader reads the named file only. There is no environment-key
fallback. The host resolves only scoped entries for the chosen installation. A missing or unreadable entry marks that installation
unconfigured. Keep keys, OAuth tokens and signing secrets out of packages, patches, browser
responses, outbox payloads, logs, exceptions and assistant context. Diagnostics use allowed
codes and correlation IDs, including for provider errors and credential-bearing map URLs.
CI injects deterministic fake adapters in a network-disabled provider transport and never
resolves a real credential. Test the assistant’s actual tool result and the served map URL
with a synthetic canary key and require both to be key-free. [Agent key-file loader](../../packages/operations-agent/src/keys.ts)

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

Charter scope (2026-11-20): “any record type” means any ADR-0079-eligible record type. Protected-record annotations await a separate design ruling.

In Customize, add an Address field to an eligible first-party or tenant-authored record. The closed,
versioned `addAddressField` patch binds a stable field ID to a record type. Independently,
`addMapPlacement` binds a stable placement ID, Address field, Record surface and section ID.
Preview, approve and activate the pinned diff through the existing compare-and-swap flow.
The company installation owns provider selection, enrichment switches, effective rate and
spend limits and timeouts, bounded by the host contract. None of these are patch operands.

`addDocumentEmailAction` binds a stable action ID to the Record command bar. It carries
ordered `to` and `cc` source lists. A source is a closed union of an authorized email field
on the record or a declared relation and target email field. No address is ever supplied by
the person at confirmation (ADR-0088, 2026-11-20 amendment). Bind zero or more document
selectors, a required approved email template reference, the source query, purpose and
channel (a versioned discriminated union, initially email) and an explicit attach or link
mode. Every payload, binding, source and reference carries a
schemaVersion. Resolve exact recipients, versions and link access before confirmation.
Reject duplicate IDs, unresolved consumers, incompatible types and disallowed disclosures.

Admit optional v6 declarations only with exact byte/root reproduction for existing
first-party and tenant-patched releases when absent. Emit a versioned connector projection
only when used. Verify the declaration, projection and required query, operation and surface
bindings in both directions. ADR-0078 governs the scalar surface floor. ADR-0074’s
reservation of 27 for workflows is void. Assign each new incompatible capability its own
next free rung as its implementation merges, including a separate map placement when
an older Address reader cannot render it. Each reader must
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

## Absence probe

At `5a2c283a`, compile the checked-in authored application from a fresh bootstrap.
Against that parent apply the existing Party “Dispatch note” text-field patch with
`compileInSandbox`, default limits and tenant provenance. Repeat both runs after a
disposable compiler registers the optional v6 connector bindings, a conditional connector
projection and the v6 `addressFieldType` alternative. Both inputs omit the additions.
Byte comparisons passed for the full first-party lineage and both canonical release
envelopes, including normalized bytes, artifacts and manifest. The roots below identify
the release envelopes before and after registration.

| Input | Bytes in each envelope | Root in both runs | SHA-256 of both envelopes |
| --- | ---: | --- | --- |
| First-party | 6,667,374 | `e3b735d0518b207161951b723f11986e2295cecad6789bd49a4f02b3acd40648` | `bd6f119023e7115e27b0a3108d6592bce57f35dd88642d23fdd3c7ef5d6b6590` |
| Tenant runner | 6,422,554 | `263ff01792ecd29088e34f944565c3cd648e3cab4c0d3574b6ec6cfaf2026613` | `73fd3311ee8006a7250e8613faa3d591f71902b4a4db0b79e45b1368b30fdf66` |

## The first two slices after approval

**1. Address and Maps.** Address is a versioned compound field. Its durable user value
contains typed text, structured lines, city, region, postal code and country, an optional
namespaced place reference and a revision. Coordinates form a discriminated union. A
user-placed pin is independently entered, correctable user content with no provider expiry.
Provider coordinates live in a company-scoped enrichment with source, precision, expiry
and the input revision. Accept only finite latitude in [−90, 90] and longitude in [−180, 180].
The read gives a user pin precedence. A change to the address or manual pin advances the
revision. A late geocode must match the exact record, revision, release and installation.
A selected suggestion or copied geocode cannot be relabelled as user content to evade expiry.

**2026-11-20 storage amendment.** One stable Address field ID owns scalar columns for typed text, components, revision, source digest, status and an optional user pin in `numeric(11,8)`. A record write replaces them atomically. Provider pins and delivery status belong to the matching company installation and source revision.

A null or omitted value is absent. Require nonblank typed text in any present value.
A required Address therefore needs text alone, including during an outage. Adding a required
field must pass the existing storage admission rules for populated record types. A malformed
value refuses. The ADR-0074 presence check applies to the whole Address. Whole-address
ordering, arithmetic and Tier B inputs refuse. List and ordinary record reads show the typed
text. Search uses authorized user text/components. Exports use labelled user address and
component columns. Transient suggestions and provider enrichment stay out of search and exports.

`address.suggest`, `address.geocode` and `address.staticMap` are provider-neutral contracts.
Discard suggestions for an earlier edit. Saving typed text always commits locally without a
provider call. When enabled, the outbox schedules geocoding. Show “Address saved · locating”
while pending and “Address saved · map unavailable” on failure. The optional placement
displays the current pin with a text equivalent. Ordinary entry, correction and save work
with a keyboard and without browser scripts. Exercise delayed/reordered replies, quota,
outage and company isolation with a deterministic fake on office and tenant-created records.

For a supported non-EEA Google demo installation, retain place IDs, expire provider
coordinates within 30 consecutive days, and keep predictions transient. The narrow
autocomplete street-address exception covers only the user’s own selected address for their
specific transaction. Shared master data keeps independently supplied text/components.
Display Google Maps attribution with suggestions and required third-party credits.
Google Places and Geocoding results cannot be plotted on a non-Google map under these terms.
Disable Google for regions/terms not covered by the adapter.
[Service-specific terms §§1, 6, 14](https://cloud.google.com/maps-platform/terms/maps-service-terms) ·
[Places policies](https://developers.google.com/maps/documentation/places/web-service/policies)

Google requires it to serve Static Maps images directly to browser pages. Its web-service
proxy guidance does not authorize re-serving those images. A direct keyed URL conflicts
with the host-only network contract. Keep Google static imagery disabled, show attributed
coordinate text and the unavailable state, and exercise the placement with fake imagery.
[Maps FAQ on image serving](https://developers.google.com/maps/faq#tos_staticmaps_reuse) ·
[Google Maps security guidance](https://developers.google.com/maps/api-security-best-practices#protect-static)

**2. Email.** Use a provider API with a send key and signed delivery events, initially
Resend. Its 24-hour key lifetime gives the worker a bounded interval for safe retries.
The compiler refuses an effect whose attempt timeouts, backoff, maximum age and safety margin
cannot fit inside its provider deduplication window. Expose provider-neutral send and status contracts. The Communication capability owns
thread, participant, message revision, verified sender, recipient, consent, delivery state,
retention and inbound correlation (N2-03). The Document action selects a readable, clean
immutable version through DOCS-1. Confirm the company, sender, recipients, message and
exact attachment version/digest before queuing. Read its bytes only through Documents at
dispatch. Revoked access, an unavailable version or a changed recipient holds the send.
The record shows queued, accepted, delivered, bounced or needs attention from governed
receipts. Correlate verified callbacks to the stored company, provider message ID and
recipient. A late acceptance cannot clear a bounce. [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys)
· [Webhook verification](https://resend.com/docs/webhooks/verify-webhooks-requests)

Stamp the occurrence correlation in provider metadata and verify the account, event and tag
before closing an unknown attempt from a callback. Resend’s documented lookup needs its
message ID. If it was lost, use the verified correlation or retry within the original safe
window, then park. In a local demo without reachable webhooks poll the declared status
contract for known IDs or show fake delivery states. Personal senders are deferred.
[Resend lookup](https://resend.com/docs/api-reference/emails/retrieve-email)

The N2-04 proof uses a deterministic fake mail service with an acceptance ledger. Crash
after acceptance and before the local receipt, then count exactly one accepted message
after recovery. Exercise duplicate callbacks, bounce, expired keys, credential rotation
and operator replay. Check that an unknown outcome beyond the provider window stays held
and a revoked document or consent yields zero new sends. Release the document action when
DOCS-1 supplies a governed immutable version/read contract and N2-03 supplies at minimum
the linked thread, participants, exact message revision, verified company sender, per-recipient
consent, delivery state and inbound correlation. ADR-0088 assigns the canonical message revision to CONNECT-1, so slice 2 does not wait on N2-03 for it. The email action patch member is CONNECT-1 slice 2's first deliverable. Slice 2 is jointly gated on DOCS-1 version handles and on [SIGNIN-1 slice 2b](../execution/packets/SIGNIN-1.md#slice-2b-provider-enablement-and-outward-sends) (provider enablement and outward sends, waiting for CONNECT-1's canonical pending records).

## Later connectors

Each needs its own ADR and confirmation-class effects under the framework rule.

| Connector | Framework support its own vertical needs |
| --- | --- |
| Stripe | Bind the merchant account and payment/refund occurrence. Use hosted payment references, scoped idempotency, signed events and settlement reconciliation. Money changes enter their own confirmed Semantic Operations. |
| QuickBooks | Bind the OAuth grant to one company and realm. Serialize token refresh and rotate scoped references atomically. Version account/tax mappings, persist backfill and incremental cursors, reconcile remote IDs and revisions, and surface conflicts before posting. |
| SMS | Bind a verified company number, consent and opt-outs per recipient. Enforce throughput limits, correlate signed inbound messages and delivery receipts, and recheck suppression before a queued send. |
