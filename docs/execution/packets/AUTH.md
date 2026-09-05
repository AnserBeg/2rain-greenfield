# AUTH — deny-capable authorization and isolation

Status: active · Critical · trust substrate, migration, and RLS paths touched · stops: 0

## Charter

- Outcome: current grants and scoped membership decide every composed query and operation; denial is recorded without changing business data.
- Slices: policy storage/evaluator; gateway denial evidence and composed wiring; checkpoint RLS; explicit permission bindings and identity seam.
- Owns: authorization/trust modules, semantic gateway denial handling, composed identity/policy wiring, migration 0025 and its schema/test pins, AUTH tests and expected-red evidence, release permission acknowledgement, this record and AUTH rows.
- Bridge: the owner ruling on PR #2 makes migration 0025 and the minimum AUTH dependency precede RECEIPT; its new unaccepted migrations follow. Inventory posting, receipt behavior, stock definitions, business tables, and release lineage remain excluded.
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

- PostgreSQL is the current authority. Roles, exact permission/resource grants, scoped memberships, and a monotonically increasing tenant/environment policy epoch are read on every decision under `north_star_runtime` RLS.
- The request view still pins release artifacts, but it does not pin authorization. A grant or membership revoked after view issuance denies its next query or operation.
- The 13 RECEIPT contracts from `a58cfb4c6749f038539b400217c3834dda7456bd` are exact `compatibleExtension` compiler bindings. Their action/resource declarations came from RECEIPT code. Compatibility permits absence before the dependent packet; when declared, exact matching is mandatory. It never grants access.
- The fixed identity is available only through explicit `localDemoIdentity: true`; the API composition rejects non-loopback demo hosts. Non-demo composition exposes a verified-authentication callback seam and fails closed while none is installed.

## Slices

- `0025_current_authorization.sql`: current policy tables, epoch triggers, runtime read RLS/grants, and checkpoint tenant/environment RLS for both internal roles.
- `current-policy.ts`: sealed-context PostgreSQL evaluator, runtime gateway bindings, exact RECEIPT dependency contracts, and redacted semantic-query denial recording.
- Runtime composition/gateways: install the evaluator, re-authorize boundary/query/relation/operation calls, validate policy narrowing parameters, and isolate demo authentication.
- Compiler/release: exact evaluator-binding registry, empty unbound acknowledgement, and compatible-extension admission for the 13 dependency contracts.

## Controls

- `auth.expected-red.json`: revoked-grant, unknown-permission, foreign-scope, exact RECEIPT binding, query-narrowing, checkpoint-RLS, fail-closed identity, and denial-recorder mutations.
- `policy-unbound-refusal.expected-red.json`: retained ratchet controls now mutate the evaluator-binding registry and its historical-census narrowing.

## Gates

- Focused green: current-policy PostgreSQL (1/1); unbound/binding compiler controls (14/14); module storage transition including both internal roles (9/9); composed application authorization vertical (11/11); semantic narrowing integration.
- Green locally: format, typecheck, lint, architecture boundaries, app release, demo release, schema replay/drift (25/25).
- Candidate expected-red execution and pushed full CI: pending the frozen candidate commit.

## Test it yourself

- `node scripts/run-with-test-lock.mjs exclusive -- node --import tsx --test --test-concurrency=1 test/postgres/current-policy.test.ts`
- `node --import tsx --test --test-name-pattern='unbound-permission acknowledgement:' test/compiler/g2-module-conformance.test.ts`
- `node scripts/run-with-test-lock.mjs exclusive -- node --import tsx --test --test-concurrency=1 --test-name-pattern='composed product activates through the kernel' test/postgres/composed-application.test.ts`
- `pnpm evidence:expected-red && pnpm test`

## Filed

- None.

## Review prompt

Review PR #2 at its stated candidate SHA as a Critical authorization change.
Scope: current-policy evaluator/storage, trusted-context sealing, query and operation enforcement,
denial evidence, identity composition, exact compiler bindings, migration 0025 checkpoint RLS,
and the focused/expected-red tests that prove them.
Verify ALLOW requires a live exact grant plus applicable membership and scope.
Verify unknown, malformed, ungranted, revoked, and foreign-scope inputs deny.
Verify release pinning cannot pin grants and caller headers cannot widen identity/scope.
Verify query, relation-option, and operation paths all reach the real evaluator.
Verify denied writes leave business rows absent and evidence contains no credentials/business input.
Verify the 13 RECEIPT action/id/resource triples match source declarations at
`a58cfb4c6749f038539b400217c3834dda7456bd`; compatibility is not a grant.
Verify checkpoint RLS preserves owner access and rejects foreign access under both actual roles.
Verify demo identity is explicit/local-only and non-demo entry fails closed without a verifier.
Run/inspect the declared Critical expected-red controls and successful candidate CI.
Exclude receipt business behavior/tables, inventory posting semantics, stock definitions,
release-lineage behavior, deployment, external login design, and administration UI.
Return only packet-scoped blocking findings with file/line evidence, or ACCEPT.
