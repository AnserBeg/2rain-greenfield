# ADR-0081. Staff sign-in and authority for human decisions

Proposed on 2026-11-19. The orchestrator's Fable read gates implementation.

An office worker signs in once to work in the ERP. When they approve a release, connect a provider
or confirm a send, the ERP must be able to show who agreed, what they saw and whether they were
entitled to decide. A customer who receives a document request needs access to that request alone.
The plan places identity, delegated administration and policy in the platform. Its G7 admission
includes an isolation review.
[Plan §§12.2 and 12.12](../greenfield-north-star-erp-platform-plan.md#1212-capability-to-stage-delivery-schedule)
· [Pilot topology](../execution/loop-ux-plan.md#then-in-this-order-the-audits-architecture-findings)

## Staff sign-in and recovery

Use user-verified WebAuthn passkeys for staff, including platform passkeys and external security
keys. This works before an email connector exists and gives the person the same gesture for sign-in
and approval. The pilot requires a compatible device or security key. Offer enrollment of a second
passkey. Keep staff credentials on the identity origin and contact credentials on a distinct contact
origin with its own RP ID. Passwords and email codes are outside the staff sign-in methods admitted
in v1.

The identity service owns a dedicated HTTPS origin and uses its exact hostname as its relying party
ID. Use a maintained WebAuthn verifier for registration and authentication. Bind a fresh random,
single-use, five-minute challenge to the browser transaction, ceremony and intended account where
known. Check the ceremony type, configured origin, RP ID, credential binding, user presence and user
verification. Verify the assertion signature with the stored public key. Resolve a discoverable
credential to its active account server-side. A credential belongs to one account of one actor type.
Record the method as `webauthn` and assurance as `user-verified-passkey`, a description of the
checks performed.
[W3C WebAuthn verification procedures](https://www.w3.org/TR/webauthn-3/#sctn-verifying-assertion)

An authorized administrator checks the person's identity against the tenant's staff records and
hands them a short-lived, one-use enrollment invitation through a separately established channel.
Bind it to one pending account. Enrollment registers a passkey, then sign-in proves possession.
Adding a key to an active account requires a fresh assertion with an enrolled key. A person with a
spare key can revoke a lost one. After loss of all keys, an administrator with recovery authority
for that account repeats the identity check, records the reason, revokes all old credentials,
sessions and outstanding invitations, and issues a 15-minute enrollment-only invitation. Notify the
person through an existing verified channel. Recovery preserves their principal and grants.

Provision the first tenant owner through an attended, audited installation step which closes
atomically once an owner exists. Record a separately verified owner recovery contact at
provisioning. Loss of the sole owner's keys requires that attended ownership check by the
installation operator, an audit entry and the same revocation and re-enrollment. Ordinary staff
administrators cannot recover a more privileged account.

Apply shared PostgreSQL attempt limits to challenge creation and completion, enrollment, recovery
and link redemption. Start with five failed completions per account or invitation per 15 minutes and
30 attempts per source per 15 minutes, with a bounded retry delay. Count unknown account handles the
same way, using keyed digests and the address observed by the trusted ingress. Spend the attempt
atomically before expensive work. Return the same public response for unknown, inactive and
unavailable accounts. Throttling one source expires automatically and survives a process restart.

## Sessions and request entry

Keep sessions in PostgreSQL. At sign-in the identity service creates a new, random 256-bit opaque
session handle and retires the pre-sign-in transaction. Use a single-use, short-lived handoff bound
to the initiating browser's secret, the fixed ERP callback and the intended staff audience to set
the ERP host's cookie. The ERP redeems it through the identity service. Pass only the opaque handoff
in a fragment to the protected callback page and exchange it by POST. Store handle digests in place
of bearer secrets, along with principal, tenant/environment membership, authentication event, issue
time, last activity, deadlines and revocation state. Rotate the handle on reauthentication and scope
changes. Reject all superseded handles.

The ERP cookie is `__Host-erp-session` with `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` and no
Domain attribute. Use separate host-only cookies for the identity service and contact entry. The
identity and ERP origins are fixed at provisioning. Limit each session to 30 minutes without user
activity and 12 hours from sign-in. Background polling does not extend idle time. Rotation or
activity cannot extend the original absolute deadline. Enforce expiry and active membership on every
request before touching last activity. Sign-out revokes the session family at both origins. Sign-out
everywhere, deactivation and recovery invalidate every session family and outstanding handoff for
that principal under the same account lock. Check revocation at protected writes as well. Compare
shared UTC deadlines at the database, fail closed on clock regression and use an injected monotonic
clock for in-process elapsed time.
[NIST session management](https://pages.nist.gov/800-63-4/sp800-63b/session/)

Check Host against the configured allowlist before routing. At each origin, require a POST and a
synchronizer CSRF token bound to the session or pre-sign-in transaction for every browser state
change, including login, logout, link exchange, Customize, Tasks, fragments and assistant actions.
Require matching scheme, host and port for a supplied Origin. Refuse conflicting or cross-site Fetch
Metadata and require same-origin Fetch Metadata if Origin is absent. Preserve fragment and assistant
header checks. Use read-only landing pages for redirects and links, followed by a same-origin POST.
Scope proxy trust to the configured ingress. [Current web entry](../../apps/web/src/app-server.ts) ·
[Assistant Host check](../../apps/api/src/assistant-endpoint.ts)

Supply `authenticateRequest` to the existing `AuthenticatedRequestEntryAdapter`. Its sole staff
identity source in pilot mode is the identity service's verified session lookup. Tenant and
environment must match the session and an active membership. Company selection is explicit and
checked against current grants and stored ownership. Request IDs originate at entry. Reject
caller-supplied identity in headers, query, form or JSON. A task token, assistant conversation or
provider callback cannot select a staff principal. The resulting trusted context supplies
transaction-local tenant, environment, principal and request ID to PostgreSQL.
[Entry adapter](../../packages/runtime/src/request-context.ts) ·
[Database context](../../packages/postgres-provider/src/request-context.ts)

“Acting as” currently posts `localDemoActAs` and sets `northstar-demo-actor`, which selects the
buyer or manager fixture. Keep this only in explicitly enabled, loopback-only local-demo composition
with its own store. The pilot serves no switch route or selector, rejects that field, disregards the
fixture cookie and refuses startup with demo identity enabled. Demo decisions carry fixture
provenance. Existing server-asserted approvals retain their historical provenance and are ineligible
for new pilot effects.
[Composition](../../packages/postgres-provider/src/composed-application-runtime.ts) ·
[Switcher](../../apps/web/src/surface-runtime.ts)

## Human decisions and activation evidence

Two existing grants matter here. The runtime can call `workflow_decide_approval` under its asserted
principal. It can also insert release approvals and activation verification receipts. Changing the
source of the request identity alone would leave these database paths open.
[ADR-0073 authority boundaries](ADR-0073-workflow-isolate-and-authority.md#authority-boundaries) ·
[Both filed findings](../execution/current-plan-archive.md#filed-during-the-freeze)

For each decision below, the ERP proposes a target. On its own origin the identity service loads the
canonical pending operation, displays its material terms and the proposed decision, and asks the
signed-in person to confirm with their passkey. Bind the one-use WebAuthn challenge to that session,
actor, tenant, environment, company where applicable, action, outcome, exact target digest, release
and applicable fence. Require an assertion for **this decision** within five minutes. Changing the
target, answer or fence requires a new review and gesture. The assistant may prepare a proposal and
direct the person to review it.

| Decision | What the person confirms |
| --- | --- |
| Release approval | Candidate ID/root, verification evidence, diff digest, preparation, source pointer and expected fence. Preserve existing eligibility and segregation of duties. |
| Customization approval | Exact patch and base, candidate and displayed diff. Use the ordinary release approval path and link both records to the same decision. |
| Workflow approve or decline | Pending plan, canonical arguments, run and occurrence, effect cursor, company, release root and fence. At dispatch recheck human authority, automation grants and the active fence. |
| Provider connection | Company, installation, provider account, operation scopes and action. A provider callback proves account linkage. Enabling the installation requires confirmation of the observed account and scopes. |
| Outward-send confirmation | Company, installation and sender, recipients, message revision and content digest, exact attachment versions and digests. Dispatch rechecks live consent, document access and installation state. |

Only the isolated identity service can issue a decision proof after verifying the assertion. Keep
its database login, keys and confirmation page outside the serving runtime and workers. Record the
proof as an immutable row whose database writer is the identity service. An authorized decision
writer consumes this proof once, under lock, rechecks session, current policy, exact target and
expiry, and commits the decision and append-only audit together. Persist principal, actor type,
authentication method and assurance, authenticated-at and decided-at UTC, outcome, request ID and
binding to the reviewed facts. Keep a non-secret evidence ID. The protected transaction and
revocation serialize on the same account and session state. A retry of the same committed decision
under current authority returns its receipt. A different action cannot reuse it. Recompute the
digest from the facts used by the writer. A caller-supplied digest or assertion of freshness cannot
satisfy this check.

Remove the runtime's direct decision writes and access to the old workflow decision function.
Replace the release-approval insert and workflow decision grant with narrow operations that enforce
the proof at the database boundary. Apply that same boundary to provider enablement and send
confirmation. Give only a separate activation verifier permission to record an activation
verification receipt. It independently checks the committed approval/proof, immutable candidate
verification evidence, activation attempt, locked pointer, release root, swap receipt and fence
using the activation kernel, then records the observed outcome. Attribute that check to the verifier
and reference the human decision. Reconciliation uses the same verification path. Remove runtime
insert rights from `release_activation_verification_receipts` and any equivalent function, role
membership or alternate completion path. Route writes to pointer, swap and outcome records through
the authorized activation kernel as well. Successful verification requires its independent read-back
of the activated state. A set of runtime-authored inputs is insufficient. Run provisioning and
migrations separately. The pilot web and worker processes have no credentials or role membership for
owner, authentication or verifier functions.
[Release contracts](../../db/migrations/0004_release_activation_contracts.sql) ·
[Activation kernel](../../db/migrations/0005_release_activation_kernel.sql) ·
[Workflow decision grant](../../db/migrations/0041_workflow_authority.sql)

Close the two filed findings only when slice 2 demonstrates both boundaries with the actual runtime
and worker roles. Until then the workflow scheduler and real email/maps providers are limited to the
explicitly enabled local demo. Pilot provider connection and outward sends also require their own
connector and delivery gates. Staff signatures need authenticated signing and the exact document
challenge. Customer uploads and signatures additionally need verified contact redemption.
[Workflow](ADR-0073-workflow-isolate-and-authority.md#authority-boundaries) ·
[Documents](ADR-0078-governed-documents-files-templates-and-signatures.md#signing-and-attribution) ·
[Connectors](ADR-0080-connector-framework.md#who-can-connect-a-company)

## Customer and contact links

Staff issue a signed, revocable invitation to one named contact associated with the record, for one
purpose and at most 24 hours. The signed envelope carries a random grant ID, issuer, contact
audience, expiry and key ID. Scope the immutable grant to tenant, environment, company, contact,
record and the exact upload categories, document version or signature slot and PDF digest. The
signing key stays in the identity service. Check the permitted signing key and algorithm, signature
and stored scope on redemption. Reissue a new grant when the target changes. Deliver the secret in a
URL fragment to a dedicated contact origin, clear it from browser history after capture, and send it
only in the protected POST. Use no third-party resources, no referrer and no caching on that page.

Possession locates the request. To redeem it the person must also authenticate as its named contact.
In v1, authorized staff verify the contact through an established relationship and separately enroll
a contact passkey through an attended handoff. Staff invitations and contact enrollment have
distinct audiences. A contact with no enrolled credential must finish that independent enrollment
first. An email code to a previously verified address can be considered when email delivery exists.
It would require its own assurance decision.

In one transaction check the contact, purpose, stored association, live policy, expiry and
revocation, consume the grant once, and issue a bounded contact session for the same scope, expiring
no later than the invitation. Two browsers redeeming concurrently yield one session. Each view,
upload stage, publish or sign operation rechecks that scope and revocation. Viewing admits the named
version, upload admits the requested slots and their submission receipt, and signing requires a
separate fresh challenge over the displayed PDF and consent. Signing records the contact's passkey
method and assurance. Contact principals and sessions have no staff memberships or staff audience.
[Upload grants and signing receipts](ADR-0078-governed-documents-files-templates-and-signatures.md#signing-and-attribution)

## Staff administration

Expose invite, grant, revoke, deactivate and recover as governed Semantic Operations. Use the
existing tenant/environment roles, permission grants and company-scoped memberships. A delegated
administrator has explicit grantable roles and companies within their own live authority. Check the
whole proposed change, including every company affected by a role edit. Require a fresh passkey
decision for account recovery, deactivation and authority changes. Refuse self-elevation, actions on
peers outside the delegated remit and removal of the last active tenant owner. Serialize that last
check. An invitation binds the intended principal and authorized assignments, expires after 24 hours
and is consumed once. Recheck the inviter's grantable scope at enrollment.

Write the acting administrator, subject, before/after scope and reason with the mutation.
Deactivation revokes access, increments the policy epoch through the existing grant model and
preserves business and audit history. Recheck current grants on every use, including after a company
switch and on an already open task.
[Policy roles and memberships](../../db/migrations/0025_current_authorization.sql)

## Pilot persistence

Both web instances use the same PostgreSQL stores. A response acknowledging a draft edit or task
step follows its durable commit. Bind each row to tenant, environment, owner principal, authorized
company scope, pinned release and revision. The browser holds an opaque locator. Recheck access
before resuming and return a stale-state result when the pin or revision has moved.

| Process-local state today | Durable pilot state |
| --- | --- |
| Document editor `buffers` | Versioned draft header and lines, entry/selection state, base revisions, in-progress creates, pending save steps, stable request keys and acknowledged receipts. Rebuild lookup displays through current queries. |
| Task `sessions` | Ordered rows and inputs, prepared confirmation and its digest, release/fence, step cursor, request keys, results/receipt references and completion or recovery state. |
| Assistant conversations and pending plans, when served | Owner/company, bounded conversation history, budget consumed, pinned proposal and its expiry, decision and execution/undo receipt references. An interrupted turn resumes from its recorded outcome or reports interruption. |

Use a version check for edits and a bounded, fenced database claim for execution. Persist the step
and its idempotency key before calling the gateway. After a lost response, recover the committed
receipt by that key before advancing or retrying. One instance can then finish work begun on
another. Existing customization patches, workflow journals, decision evidence and outbox receipts
retain their existing stores. Request-local caches can be rebuilt.
[Draft buffers](../../apps/web/src/document-editor.ts) ·
[Task state](../../apps/web/src/surface-composition.ts) ·
[Assistant state](../../apps/api/src/assistant-endpoint.ts)

## Migration and proof

The first implementation slice adds a forward migration for scoped accounts, credential public keys,
challenges, session families and handle digests, enrollment/recovery records, shared attempt
counters and append-only authentication audit. Use composite scope keys, forced RLS and narrowly
granted functions for pre-authentication lookups. Only the identity service can write verified
authentication events. Later slices add decision proofs and restrictions on existing writers,
contact grants and durable work state as they are used. A legacy decision keeps its original
provenance. Require a new decision for pending pilot work. Allocate each migration after the highest
on freshly fetched `origin/main` at merge, regenerate the snapshot and migration-list tests, rerun
CI, and re-fetch before push. Serialize migration merges and renumber on collision. Assign any
required surface rung by the same rule. A deployment must support every parser and surface floor
already used by a tenant.

Allowlist identifiers, event types, times and outcomes for audit and diagnostics. Keep credential
material, WebAuthn payloads, cookies, CSRF tokens, codes, invitations and signed URLs out of logs,
proxy traces, errors, exports, business payloads and assistant tools or prompts. Private passkey
material stays with the authenticator. Give the assistant no credential or confirmation endpoint.

| Implementation check | Required observation |
| --- | --- |
| Session fixation, expiry and sign-out | A pre-login handle and a replaced handle both fail. Inject clocks at idle and absolute boundaries, including active polling and a clock regression. A second instance refuses a revoked session. |
| Cross-site request and identity input | With a valid session, wrong Host or Origin, conflicting Fetch Metadata or missing CSRF token prevents every protected mutation. Identity headers, form/JSON/query claims and the demo switch cannot turn a signed-in buyer into a manager. No session yields no staff context. |
| Decision and activation authority | As the actual runtime and worker roles, a matching principal setting and complete pending plan yield zero decision or verification rows without the independent proof or verifier. Exercise direct table and function entry. Change one bound fact, revoke authority, or repeat a proof and observe zero new effects. A valid confirmation and verification produce the linked evidence. |
| Contact scope and replay | Open a forwarded link as a different verified contact, then race two redemptions as the intended contact. Count one consumption and one scoped session. An expired or revoked grant, another slot and a staff endpoint all refuse it. |
| Administration and credential handling | Exercise enrollment, spare-key sign-in, recovery, account deactivation and a delegated admin's out-of-scope grant. Inspect audit rows, captured logs and model inputs for synthetic credential markers. Observe atomic rate limits from two instances. |
| Restart and concurrent work | Save on A, read on B, interrupt after business commit and resume on B. Observe the acknowledged draft values, one business effect, one receipt and one cursor advance. Another principal cannot resume it. |

## Delivery after the design ruling

1. Staff sign-in, sessions, attended bootstrap and session-bound principal at every staff entry point.
2. Decision and approval binding, independent activation verification and the two filed-finding tests.
3. Verified contact enrollment and scoped customer links for upload, view and sign with the Documents capability.
4. Governed staff administration, company roles, delegation, deactivation and recovery.
5. Durable drafts and task recovery across process restart and two serving instances.
