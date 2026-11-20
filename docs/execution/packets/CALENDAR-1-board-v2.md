# CALENDAR-1 Board v2 fix — Boards record choices, not derivations

Status — built on `packet/CALENDAR-1-board-v2` from main `5d315668` (docs E1–E20). Surface reader rung 36, taken at merge above draft line create values (35). No migration. Governs: [ADR-0086 view revision member shape](../../decisions/ADR-0086-board-calendar-and-resource-timeline.md), [Board v2 fix proofs](CALENDAR-1.md#board-v2-fix).

## Claims

1. The Board patch member and compiled body carry version literal 2. They record the chosen stage IDs, each offered move's operation ID with its contract digest (operation, effect kind, transition, from and to state, tier), up to three fact field IDs with field-type kinds, and every other binding once (List, list query tier and company scope, Record and get query, title and state fields). The v1 parser and builder are removed.
2. Normalization checks only the recorded digest and each referenced ID's contract. A retired Board is not validated. Nothing derives a Board outside authoring.
3. On the authoring base, the choices must reproduce the exact recorded digest. On another base, replay checks each binding by stable ID. A missing binding is `RETIRED_TARGET` and a changed one `INCOMPATIBLE_TYPE`, each naming the ID. Only the last revision of each Board surface is checked.
4. Labels and Ledger roles render from the active release: the compiler emits `boardPresentation` beside the digested `board` member, and the diff renders it from the approved release.
5. Serving admission refuses a Board under rung 36, a rung-36 claim without a Board, and a forged move. It skips retired Boards.
6. The Board offers only moves the person is granted, in the chosen company. A forged or ungranted confirmation returns 403. A scan-ceiling or timeout read renders "Narrow the search", never "No cards".

## Decisions

- A field type's contract is its kind. Enum options and labels stay outside it, so a stage relabel or a new choice is not a conflict.
- Operations have no version. The contract digest replaces "pinned operation version" (E5). Confirmation is read live. Per the orchestrator's ruling, a changed contract is `INCOMPATIBLE_TYPE`.
- A retire revision records its predecessor's body unchanged and binds nothing new.
- The builder offers every list-query-selected field of the type as a fact. The type's key facts and column priority remain the default (E11).
- **Not expressible today:** a validation rule binds only create and update operations (`CANON_VALIDATION_BINDING_UNSUPPORTED`). The E15 validation case and finding 3's "validation refusal leaves the card in place" have no platform form. A test pins that refusal.
- The automation-only proof grants the transitions to a separate policy principal and withholds them from the person. It does not deploy a workflow.
- A stage relabel replays clean. Shipping it is refused by the storage planner's retype rule (`COMPILER_STORAGE_RETYPE_UNSUPPORTED`), which is not a Board rule. The proof therefore checks replay and normalization for that case and compiles the fact-column and operation relabels.
- Local dev tenants that activated a v1 Board need `dev:reset` (E14).

## Controls

[Manifest](../../../test/evidence/CALENDAR-1-board-v2.expected-red.json). These 10 unit controls were reproduced locally and restored: re-derived facts, the fact contract read from List columns, a retired Board validated, the normalization self-digest, a superseded revision bound, a conflict left unattributed (7 kills), the apply self-digest, the authoring exact digest, an understated serving floor, and a retired Board checked at serving. The three PostgreSQL controls run under `check-expected-red.sh --run`: an unscoped company read, an admitted forged confirm and an offered ungranted move.

## Test it yourself

1. Run `corepack pnpm dev`. In **Customize → Add view**, choose **Purchase orders → Add Board view**. Keep the offered stages, leave **Cancel order** checked and the three default facts ticked. Then draft, approve and activate.
2. In **Customize**, arrange the Purchase orders List: hide **Order date** and relabel **Expected**. Draft, approve and activate. The change should compile, and the Board should still show both facts under the new label.
3. Edit the Board and choose **Draft retirement**, then activate. Add a field to Purchase orders. It should compile.
4. Run `node --import tsx --test test/unit/customization-board.test.ts`. Expect 17 passing tests.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "CALENDAR-1-board-v2",
  "base": "5d315668741e4f0cd4e71fc284e731beac1ff940",
  "head": "c8792ffc33af05127446771c8e4132f766bd4fcc",
  "changedPaths": [
    "apps/web/src/board.ts", "apps/web/src/customize-screen.ts", "apps/web/src/surface-contract.ts", "apps/web/src/surface-runtime.ts",
    "package.json", "packages/canonical-model/src/board.ts", "packages/canonical-model/src/surface-workspace.ts",
    "packages/compiler/src/projections.ts", "packages/customization/src/ai-draft.ts", "packages/customization/src/apply.ts",
    "packages/customization/src/board-revision.ts", "packages/customization/src/render.ts", "packages/customization/src/upgrade-replay.ts",
    "packages/postgres-provider/src/board-admission.ts", "packages/postgres-provider/src/module-runtime-interpreter.ts",
    "packages/runtime/src/request-runtime-view.ts", "test/evidence/CALENDAR-1-board-v2.expected-red.json",
    "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/postgres/board-policy.test.ts",
    "test/postgres/customization-validation.test.ts", "test/postgres/request-runtime-view.test.ts",
    "test/unit/customization-board.test.ts", "test/unit/customization-upgrade.test.ts", "test/unit/customization.test.ts"
  ],
  "symbols": [
    {"path": "packages/canonical-model/src/board.ts", "name": "boardBindingConflicts"},
    {"path": "packages/customization/src/board-revision.ts", "name": "applyBoardRevision"},
    {"path": "packages/customization/src/board-revision.ts", "name": "supersededBoardRevisions"},
    {"path": "packages/postgres-provider/src/board-admission.ts", "name": "boardBindingsProblem"}
  ]
}
```
