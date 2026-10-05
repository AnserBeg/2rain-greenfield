# RELATION-INSTALL — install relation columns on existing company tables

Status: draft PR #20 against PAYABLES; Critical; owner-run review owed; no merge or deployment.
Base: PAYABLES `96ac234122322b2cbe18349299664f56c8f5190a` (upstream review/CI refresh; app envelope unchanged).
Critical scope: relation-column resolution and existing column-grant admission in `module-storage-materializer.ts`; no other Critical path changed.
Design: `DROP-SHIP-RELATION-INSTALL-design.md` at DROP-SHIP `4000c486` (owner selected 2026-10-04).

## Claims

1. A relation-backed `addColumn` resolves its unique declared relation from the pinned storage target, installs a nullable UUID with no default on its source table, and leaves existing rows unlinked.
2. The installed FK and index use the compiled deterministic names and scoped columns; the FK retains tenant/environment/company scope and refuses a foreign-company target independently of gateway validation.
3. The added relation column receives creation-equivalent column privileges without table UPDATE; a governed operation-gateway create persists a valid link.

## Design and decisions

- Owner ruling: build the reusable platform capability; no re-baseline and no plain-text link substitution.
- `locateColumn` retains field lookup, then matches a non-field relation by relation ID and physical column name; ambiguous or absent targets still refuse.
- Return relation storage attributes with nullable default semantics through the existing `applyDdlElement` inertness and grant checks; FK/index installers and creation-time grant enumeration are unchanged.
- No app definition, release output or lineage change; no posting kernel, serializer, trigger/rebuild, activation, verification, trust, migration or RLS change.
- Evidence lives in the CI-reachable composed PostgreSQL test: a synthetic initial release of the recorded head definition, persisted base rows, then a relation successor on that same tenant. Neither fixture release is written to the app artifacts; product lineage is unchanged.

## Controls

- `relation-install-target-missing` -> claim 1: disable the new relation lookup branch.
- `relation-install-foreign-company-target` -> claim 2: remove company columns at `applyDdlElement`'s FK installer for the synthetic added relation.
- `relation-install-column-write-grant-absent` -> claim 3: omit add-column UPDATE admission.
- Manifest: `test/evidence/RELATION-INSTALL.expected-red.json`; committed controls run through owner-approved evidence-on-demand CI. Local controls remain behind AC and >=2 GB free Windows memory checks.
- First target-missing attempt ran but failed the restored-green prerequisite; no discriminating red is claimed. Its container was removed and source restored. Further unmutated diagnosis expired at the lock before starting. The test now exposes typed preparation codes and isolates this transition from unrelated historical installs; bounds unchanged.

## Gates

- Typecheck PASS; focused Prettier PASS.
- Full hosted [earlier CI PASS](https://github.com/AnserBeg/2rain-greenfield/actions/runs/37268185759) at `66cf178a`. [Refreshed CI](https://github.com/AnserBeg/2rain-greenfield/actions/runs/37277958211) at `8505c168` has passing composed PostgreSQL and schema jobs; full completion remains pending.
- [Controls at `8505c168`](https://github.com/AnserBeg/2rain-greenfield/actions/runs/37277961005): target-missing and column-write-grant-absent each killed one declared test for its declared reason, then restored one passing test. Foreign-company-target survived because its mutation did not reach the FK installer; no red is claimed for it. Its committed mutation now targets that installer; all three await a fresh run.
- Static expected-red validation PASS (165 entries / 14 manifests). Typecheck, focused lint and formatting PASS; record-claim names executable `b318205c`. The diff to refreshed PAYABLES remains the same 17-line production addition.
- Refreshed hosted CI, revised control evidence and owner Critical review pending; draft PR https://github.com/AnserBeg/2rain-greenfield/pull/20. Latest Windows memory about 1.36 GB remains below the local control minimum; no local control started.

## Test it yourself

After checking Windows memory outside the lock, run:
`node scripts/run-with-test-lock.mjs exclusive -- node --import tsx --test --test-name-pattern='^relation install advances' test/postgres/composed-application.test.ts`
Observe a released base with no new column; the upgraded table has a nullable UUID, the named scoped FK/index and column-only UPDATE; the old line stays null; a gateway create stores a valid link; a foreign-company gateway create and direct FK write leave rows unchanged.
DROP-SHIP's user-facing delivery workflow is the next authorized checkpoint after this bridge's draft PR and owner-review prompt.

## Filed

- Review prompt is owner-run only; this lane does not review its own work.
- No stage boundary or new posting correctness domain is introduced by this bridge.

## Review prompt

`RELATION-INSTALL-review-prompt.md` names executable `b318205c`; facts and questions only. Owner-run review pending; no self-review.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "RELATION-INSTALL",
  "base": "96ac234122322b2cbe18349299664f56c8f5190a",
  "head": "b318205c0b885ecbbdcc2e14c18ba0345f71acbf",
  "changedPaths": [
    "packages/postgres-provider/src/module-storage-materializer.ts",
    "test/postgres/composed-application.test.ts",
    "test/evidence/RELATION-INSTALL.expected-red.json"
  ],
  "symbols": [
    { "path": "packages/postgres-provider/src/module-storage-materializer.ts", "name": "locateColumn" },
    { "path": "packages/postgres-provider/src/module-storage-materializer.ts", "name": "applyDdlElement" },
    { "path": "test/postgres/composed-application.test.ts", "name": "appendRelationSuccessor" },
    { "path": "test/postgres/composed-application.test.ts", "name": "relationInstallBase" },
    { "path": "test/postgres/composed-application.test.ts", "name": "copyRelationFixtureRow" }
  ]
}
```

## Continuation checkpoint — 2026-10-05

- Next: focused revised PostgreSQL transition, all three controls and fresh CI; no application artifact, deadline or readiness change.
- Authorized step 6 is active: DROP-SHIP merged the refreshed PAYABLES and bridge at `76a3628c`; draft PR #19 continues on its own worktree. Schema regeneration, PostgreSQL/browser and full green CI remain owed.
