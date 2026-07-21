# ADR-0006: Human-controlled release activation

Date: 2026-07-21
Status: accepted
Tier: Critical (review per `review-tiers`)

## Context

ADR-0001 makes `ActiveReleasePointer` the sole active-version authority. This
ADR decides who may authorize a pointer change. Product releases and tenant
customizations share the same activation path, and neither an AI authoring
client nor a verification service may promote its own output.

## Decision

An immutable `ReleaseApproval` issued by an authorized human is the sole
authority that permits an activation attempt. It binds:

- one tenant, environment, `TenantRelease`, and release content hash;
- one unique approval identity and one allowed activation-attempt identity;
- the expected current `ActiveReleasePointer` identity and fencing/version
  token;
- the human-readable semantic, policy, effect, and migration diff;
- the exact verification evidence and capability-support result reviewed;
- the approving principal, current policy version, decision time, and any
  expiry; and
- the applicable confirmation, maker-checker, and segregation-of-duties
  policy.

The Identity and Policy gateways governed by ADR-0004 decide whether the human
is currently allowed to approve. That authorization check does not itself
approve a release. A release service may execute an approved transition, but
it cannot mint, broaden, retarget, or infer the approval.

Approval metadata on `TenantRelease`, activation receipts, and UI status are
references or projections of `ReleaseApproval`; they are not parallel approval
authorities.

Immediately before execution, the release service rechecks the approval,
current policy, candidate identity/hash, compatibility and migration state,
and expected pointer. It atomically claims the approval by inserting exactly
one immutable `ReleaseActivationAttempt` under a uniqueness constraint on the
approval identity. Retries resume that same attempt idempotently; a second
attempt requires a new human approval even when the first failed before pointer
compare-and-swap. The service then uses compare-and-swap, reads back the
pointer, invalidates affected caches, and runs active verification. The
`ActiveReleasePointer` remains the sole record of which release is active;
approval is permission for one attempt, not a competing active-version
authority.

AI agents, visual builders, compilers, verification workers, and application
authors may prepare candidates and evidence but cannot approve or activate.
Protected candidates require an approver distinct from the author when policy
declares maker-checker separation. Rejection, failed activation, halt,
compatible rollback, and governed forward-fix decisions retain their full
human and machine evidence. Selecting a prior release for rollback requires an
equally explicit authorized decision and never reverses business transactions.

## Consequences

- Product and customization releases use one attributable governance path.
- Approval cannot be replayed for a different tenant, environment, release,
  hash, evidence set, or pointer state.
- An automated executor can perform mechanics after approval but cannot decide
  what becomes active.
- Pointer rollback is allowed only when data and runtime contracts remain
  compatible; migrations are not assumed reversible.

## Evidence

- Plan sections 5.4, 9.1, 10.1, 11.3, and 15.3 require permission-gated human
  approval, compare-and-swap activation, read-back, verification, and history.
- REFERENCE only: prior repository
  `docs/erp-trust-data-lifecycle-plan.md` at `chess@668a60b`, sections 3-4 and
  7, for separate approving-human attribution and maker-checker evidence. No
  prior implementation or runtime contract is admitted.

## Enforcement

G1 must test exact approval binding, current-policy recheck, stale-pointer CAS,
atomic single-attempt claim, idempotent attempt resumption, refusal of approval
replay, read-back, activation history, compatible rollback, and absence of
ambient activation. G6 must prove that authoring and customization agents
cannot self-approve or self-activate. Protected-candidate tests must refuse
self-approval.
