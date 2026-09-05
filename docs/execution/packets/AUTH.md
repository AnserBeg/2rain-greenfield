# AUTH — deny-capable authorization and isolation

Status: active · Critical · trust substrate, migration, and RLS paths touched · stops: 0

## Charter

- Outcome: current grants and scoped membership decide every composed query and operation; denial is recorded without changing business data.
- Slices: policy storage/evaluator; gateway denial evidence and composed wiring; checkpoint RLS; explicit permission bindings and identity seam.
- Owns: authorization/trust modules, semantic gateway denial handling, composed identity/policy wiring, migration 0025 and its schema/test pins, AUTH tests and expected-red evidence, release permission acknowledgement, this record and AUTH rows.
- Bridge: shared composition and migration pins may be prepared here but integrate only after RECEIPT; inventory posting, receipt behavior, stock definitions, and release lineage are excluded.
- Decisions already made: ADR-0004 owns trusted context and live authorization; ADR-0008 owns business ingress; ADR-0010 owns invocation evidence; ADR-0031/0055 keep legal entity as an explicit business operand.
- Evidence: Critical claims use one discriminating expected-red each; tests exercise live gateways and non-admin database roles.
- Gates: format, typecheck, focused unit/integration/PostgreSQL/browser suites, expected-red, check-records, and pushed CI.
- Stop only for a one-way identity decision, a real RECEIPT collision, or an honest CI failure outside this vertical.

## Claims

1. A live grant and scoped membership are required for ALLOW; absence, revocation, unknown permission, or invalid scope returns DENY.
2. Query, relation-option, and operation calls re-evaluate current policy through their existing gateways, independent of the pinned release.
3. Denied business calls persist redacted invocation evidence and leave business rows unchanged.
4. Backfill checkpoints enforce tenant/environment RLS for the legitimate materializer and module-runtime roles.
5. Every currently released permission has an explicit evaluator binding and the unbound acknowledgement is empty.
6. Demo identity remains local-only; a non-demo request without verified identity fails closed.

## Decisions

- Pending implementation measurements.

## Slices

- Pending.

## Controls

- Pending.

## Gates

- Pending.

## Test it yourself

- Pending.

## Filed

- None.

## Review prompt

- Written at freeze.
