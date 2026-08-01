# 5g3-journeysplit — independent composed-browser journey budgets

Status: evidence in progress

Tier: Behavioral

Base: `2ac0b5b`

## Outcome

The composed-browser checkpoint is four independent Playwright tests rather
than one accumulating test body:

1. grouped Inventory navigation and responsive list behavior;
2. legal-entity-scoped on-hand lookup;
3. scoped immutable Inventory reads and refused generic writes; and
4. the Party lifecycle followed by application restart and persisted readback.

All four use the unchanged 20-second Playwright test budget. A worker-scoped
fixture owns the callback lifetime of one ephemeral PostgreSQL container and
one composed application, and seeds the posted Inventory adjustment once. Its
setup ceiling is the former test's unchanged 180-second ceiling. Playwright's
existing `browser` -> `composed-application` project dependency is unchanged.

The worker fixture is load-bearing: a test run containing all four journeys
creates one fixture, while each test selected alone creates its own fixture and
passes. The latter is the order-independence control; no journey relies on a
record or page left by another test. The Party journey creates its own record
and performs its restart before asserting persisted state.

## Assertion parity

The source contains 140 `expect(...)` call sites before and after the split.
The fresh reviewer independently extracted all 140 complete matcher-call
expressions from `main` and the candidate; both sorted normalized multisets
have SHA-256
`c414a087dae36d20b89379037bd53a70623f28bd9bfa7fee1849a08ee580f490`.
No assertion subject or matcher changed. The only formerly top-level assertion
was the Party readback after restart; it moved into the Party test after the
fixture's restart callback.

## Measured controls

The final quiet shared run observed the four test bodies at 1.0 s, 2.0 s,
2.2 s, and 4.6 s respectively, each against its separately named 20 s budget.
Each journey also passed through a focused `--no-deps` invocation with a fresh
ephemeral stack; their total wall times, dominated by the common lineage
bring-up, were 123.39 s, 142.09 s, 121.02 s, and 126.50 s.

The unchanged browser-suite baseline passed 19 tests in 119.38 s, with the
single composed test reported at 1.4 minutes. The final quiet post-split run
passed 22 tests in 108.64 s. An earlier post-split sample took 169.00 s; it is
retained as evidence of immutable-lineage setup variability, not selected as
the verdict. The final sample began and ended with no matrix, composed
PostgreSQL profile, or activation-cost profile running. Structural startup
count alone was not substituted for measured wall time.

## PostgreSQL analogue — investigated, not changed

`test/postgres/composed-application.test.ts` has the same accumulated-budget
symptom but not the same immediate split. Its two 300-second parents are already
separate top-level tests with separate ephemeral databases:

- `composed product activates through the kernel and persists tenant-scoped
  gateway data` performs two complete tenant bring-ups plus gateway,
  persistence, verification, approval, and activation controls; and
- `composed product advances an existing deployment to an exact compiled
  successor` performs forward activation, refusal arms, rollback, and replay.

Each parent contains several independently meaningful journeys, so the
monolithic-budget disease is present. Naively splitting them would multiply
full immutable-lineage preparation and make the suite slower. A follow-up needs
its own fixture-sharing and state-isolation charter; this packet changes
nothing under `test/postgres/`.

## Reusable rule

Split accumulated end-to-end journeys at semantic boundaries, give each the
existing test budget, and place callback-owned expensive setup in one worker
fixture. Prove both sides: the full file starts the fixture once, and each test
passes alone with a fresh fixture. Do not infer independence from serial green.
This lesson remains here because the live `gate-perf` branch also edits
`learnings.md`; creating an avoidable shared-file collision would defeat the
packet it is intended to unblock.

## Gates

- `corepack pnpm typecheck`: PASS.
- `corepack pnpm test:browser`: PASS (22 tests in 108.64 s).
- `corepack pnpm test:architecture`: PASS (101 tests).
- Fresh Behavioral Codex xhigh review: PASS on `34942772`; the subsequent
  assertion-evidence correction was docs-only.
- Full matrix `1b3abc37`: FAILED after 139/139 PostgreSQL tests when CI-mode
  Playwright rejected a named fixture argument rather than its required object
  destructuring pattern. The replacement destructures the built-in
  worker-scoped `browserName`, uses it in the ephemeral resource label, and
  passes the exact `CI=1 corepack pnpm test:browser` path (22 tests).
- Replacement full matrix and fresh review: pending.
