# ADR-0071: Read decisions are live per request; write decisions are live per call

Date: 2026-11-17
Status: accepted
Tier: Critical (request security path; review per `review-tiers`)

## Context

A purchase order page cost 1,204 statements in 148 transactions, 119 of them permission
lookups for 23 distinct permissions (SPEED-1 charter). The rule at
`packages/runtime/src/request-runtime-view.ts` (`authorizeCurrentPolicy`) said every call
reaches the live gateway again, which made each read decision its own transaction. The
owner wants pages "super super fast"; the security guarantees may not move.

## Decision

1. A page read (a GET) runs its reads in one read-only `REPEATABLE READ` snapshot
   (`withReadSnapshot`, `packages/postgres-provider/src/request-context.ts`) with one
   envelope: login-role check, identity `set_config`, the snapshot's policy epoch.
2. Inside that snapshot, a read decision (decision input kinds listed in
   `REUSABLE_READ_DECISION_KINDS`, `current-policy.ts`: query, list, legal-entity scope,
   the advisory eligibility preview) is computed from the principal's live grants, read
   once per snapshot with the same three revocation checks as the per-decision statement.
   Reuse is keyed by tenant, environment and principal, held for one snapshot of one
   request, and recomputed per call from the gateway's binding (permission, resource) and
   the decision input's legal entities. It is never shared across requests.
3. Every other decision -- an operation's invocation, a capability executor's, Confirm,
   the agent's execute, and any decision outside a page -- reads the live grants in a
   transaction of its own. Such a transaction never joins the snapshot: it first ends it.
4. When the snapshot ends (before the page is rendered), the live policy epoch is read in
   a transaction of its own. Any grant, role or membership change bumps the epoch
   (`db/migrations/0025_current_authorization.sql` triggers). If it moved, the page is
   discarded and assembled once more; a second change refuses the request.
5. A real denial is still recorded in its own durable transaction, as before.

## Amendment (2026-11-18): a read-only request, whatever its method

The snapshot covers one read-only request, a GET or a composition task's step POST (open,
Review, and Confirm's render reads). Invocations stay live, as rule 3 says. A read-only
task step carries exactly the hazard this ADR accepts for a GET: a decision is reused
within one request, the end-of-request epoch check discards the response on any policy
change, and no data reaches the person. The boundary was drawn at the HTTP method; the
property that matters is a read-only request with an end-of-request epoch check. The
memo read of `40de0205` raised it as a Medium ("outside the stated boundary"); it is
resolved by this amendment (orchestrator ruling), on three conditions:

- the snapshot transaction is `READ ONLY`, so any write attempted in it fails;
- every write goes through the live invocation path, outside the snapshot;
- the end-of-request epoch check runs on a task step's response exactly as on a GET's
  (a step is never re-run: it is sent again by GET, or a Confirm offers its own retry).

## Consequences

- A revocation that commits while a page is being assembled is not seen by the page's
  later decisions; the page is then discarded by rule 4, never sent. A revocation before
  the snapshot is seen by every decision of the page.
- The read-twice checks inside one page (`verifyLegalEntityReadScope`'s epoch comparison)
  compare snapshot values with themselves; rule 4 is what covers a change during the page.
- A page holds one connection; a write or denial row in a GET ends the snapshot first, so
  a full pool cannot deadlock on a page that needs a second connection.

## Evidence

`test/postgres/read-snapshot.test.ts` (revoked mid-page: discarded and re-assembled to
DENY; changed twice: refused; writes apart; pool of one; a write inside a step's
snapshot refused `25006`). `test/postgres/speed-fixes.test.ts` (a grant revoked between a
task step's two reads of its record: the response is discarded, the order never shown). The page budget
(`test/performance/page-budget.test.ts`) measures the statements before and after.

## Enforcement

`test/postgres/read-snapshot.test.ts`; `test/postgres/current-policy.test.ts` (decisions
outside a page stay live per call); the orchestrator's critical reviews of SPEED-1.
