# RELATION-INSTALL — install relation columns on existing company tables

Status: unfinished, paused for the owner's Windows restart; Critical; owner-run review owed; no push, PR, merge or deployment.
Base: PAYABLES `b91c5284e163d19a834802479dd2dc1e3a1201d1`.
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
- Evidence lives in the already CI-reachable composed PostgreSQL test; its synthetic successor is not written to the app release.

## Controls

- `relation-install-target-missing` -> claim 1: disable the new relation lookup branch.
- `relation-install-foreign-company-target` -> claim 2: remove company columns only when resolving the newly added relation.
- `relation-install-column-write-grant-absent` -> claim 3: omit add-column UPDATE admission.
- Manifest: `test/evidence/RELATION-INSTALL.expected-red.json`; execution pending, after executable commit, on AC with >=2 GB free Windows memory.

## Gates

- Typecheck PASS; focused Prettier PASS.
- Focused real PostgreSQL transition: never started; cancelled while waiting for another lane's exclusive lock before the owner's Windows restart.
- Static expected-red validation refused the uncommitted candidate (`EXPECTED_RED_TREE_NOT_FROZEN`); rerun after this checkpoint commit. No mutation control was run or file mutated by a control.
- Check-records: not run; the record-claim block and frozen review prompt remain to be written at completion.
- Full hosted CI and owner Critical review: pending.

## Test it yourself

After checking Windows memory outside the lock, run:
`node scripts/run-with-test-lock.mjs exclusive -- node --import tsx --test --test-name-pattern='^relation install advances' test/postgres/composed-application.test.ts`
Observe a released base with no new column; the upgraded table has a nullable UUID, the named scoped FK/index and column-only UPDATE; the old line stays null; a gateway create stores a valid link; a foreign-company gateway create and direct FK write leave rows unchanged.
DROP-SHIP's user-facing delivery workflow is the next authorized checkpoint after this bridge's draft PR and owner-review prompt.

## Filed

- Review prompt is owner-run only; this lane does not review its own work.
- No stage boundary or new posting correctness domain is introduced by this bridge.

## Review prompt

`RELATION-INSTALL-review-prompt.md` (to be frozen after CI).

## Restart checkpoint — 2026-10-04

- Saved paths: the materializer's 17-line relation lookup, the composed PostgreSQL transition test, the three-control manifest and this record.
- Next: run static controls on the committed tree, then the focused PostgreSQL test after checking free Windows memory outside the exclusive lock; fix any real failure; freeze and run each Critical control on AC with >=2 GB free Windows memory.
- Still owed: control outcomes, record-claim, facts/questions-only review prompt, draft RELATION-INSTALL PR against PAYABLES and full green CI. No app release or lineage artifact changed.
- DROP-SHIP worktree was not touched. Its saved tip is `4000c48663aca79b4ac5e5c87b72f7b0bdb772f3`, draft PR #19. Return there only at authorized step 6 to merge this bridge, regenerate the schema snapshot and run its PostgreSQL/browser gates.
