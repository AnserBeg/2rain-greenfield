# AI-UNDO-1 — the assistant asks before putting a customer on or off credit hold

Status: slice 1 (`packet/AI-UNDO-1-s1`, tip `3048f69c5`): Fable check MERGE, on main. Slice 2 (`packet/AI-UNDO-1-s2`): declarations, the declaration on cut profile v3 (agent-discovery 5) and routing built; see Slice 2 below. Tier: packet, first-party base change. No migration or grant; slice 2 takes reader rung agent-discovery 5 (v3 releases only). Stops taken: none.

## Claims

1. Putting a customer on credit hold and releasing the hold both need the person's yes. On main both ran at once (`risk.ts:29`, review finding A2).
2. The yes comes from the release, not a name: `party_credit_hold` carries the existing `requiresAssistantConfirmation`, which the compiler projects into `confirmationRequiredFor` and `risk.ts` already reads.
3. A plain master field edit (party name) still acts at once with Undo.

## Decisions

- **Approved by the orchestrator (2026-11-22):** the CRITFIX-A auto-run snapshot drops `party_update -> party_credit_hold` (12 -> 11 fields), and the X5 expectation for the hold flips from `reversible` to `needsYes` (charter slice 1 names both).
- **Approved by the orchestrator (2026-11-22):** the AGENT-5 7 pinned `confirmationRequiredFor` list gains `party_credit_hold` (4 -> 5 ids).
- The hand list in `risk.ts` is left untouched in this slice so the declaration is the only layer that refuses (rule 8 one layer); charter slice 2 deletes the list.
- Rule 13: no rung. The v6 field schema has accepted `requiresAssistantConfirmation` since `69e29d07f` (AGENT-5, 2026-11-18) and the first-party agent floor is already 2 (the list was non-empty), so an admitted older reader parses the new stored definition and the projection without a new key. The app release lineage advances by one release, as AGENT-5's did.
- Rules 2 and 3: this slice adds no read and no authority source; the class comes from the stored release declaration.
- Charter slice 0 (census and eval families) moves to AI-RELY-1's next slice (orchestrator, 2026-11-22).

## General blocks (rule 16)

- Uses `requiresAssistantConfirmation` on a field: any release can mark a gate field so the assistant asks. A distributor's credit hold, a clinic's "booking blocked" flag, a rental desk's "do not rent" flag on a customer.

## Most general form (rule 17)

- (a) The general thing is a reversibility declaration every operation, field and Customize member carries (`undo`, `inverse`, `reach`, `basis`), derived by the compiler from release facts and readable by any consumer: an autonomy policy, the UI's Undo, workflows that must not fire on an undoable draft, and audit. A gate field is one case of it (`exact, internal`).
- (b) Unchanged users: any release definition can mark a field or entity so the assistant asks, and no code names the field. No Customize member can set the key yet, so tenant-built fields cannot be marked; they always ask today (Fable finding 3).
- (c) Deliberately narrower: this slice reuses the existing, assistant-scoped `requiresAssistantConfirmation` because charter slice 1 is the defect fix only and a new projection key needs its own reader rung. Charter slice 2 builds the general declaration in the agent-discovery projection with a consumer-neutral shape (not assistant-named), and derives the gate case from "another operation, rule or capability reads this field" instead of a mark.

## Controls

- `party-credit-hold-declared`: removing only the declaration in `packages/domain/src/party/definition.ts` and regenerating the release (`generate-app-authored.ts`, `compile-app-release.ts`) reds four tests in `test/agent/business-map.test.ts`: the auto-run snapshot, X5, `AI-UNDO-1: the release declares the credit hold...`, and AGENT-5 7. Run after the fix commit; restored with `git checkout`.
- On main (without the fix), X5's two hold assertions and the new declaration test fail: the class was `reversible`.

## Gates

Local, sequential: typecheck, lint, agent 79/79, unit 477/477, compiler 190/190, architecture 236/236; `check:app-release`, `check:demo-release`.
CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/45034646289
That run is on the exact code tip `6d651b08`; the record commit on top is docs-only. Attempt 1: one shard timed out alone (`customize-rules` saved Location view, 10 min, unrelated), so the whole workflow was rerun once; attempt 2 green.

## Test it yourself

- `node --import tsx --test --test-name-pattern='X5|credit hold|auto-run snapshot|AGENT-5 7' test/agent/business-map.test.ts` — hold and release ask; a name edit stays reversible.
- In the app, ask the assistant to release a customer's credit hold: it shows a card and waits for your yes.

## Slice 2 — capability declarations, the declaration on cut profile v3, unowned types follow it

- Rulings (orchestrator, 2026-11-22/23): act at once only with a value inverse AND no undeclared consumer; capabilities declare safe fields at the composition root; the key rides compiler-semantic profile v3, cut but NOT adopted (option 1, reversing "no profile v3" after full run 45264594739 showed an unconditional key breaks ~15 older-reader proofs and customization reproduction); rung = agent-discovery 5.
- Capability side (`b8df0bb2b`): each capability supplies an `ImmediateEditDeclaration` (`packages/canonical-model/src/reversibility.ts`); first-party modules declare today's eleven (`packages/domain/src/app/immediate-edits.ts`); `risk.ts` and `writeRisk` name no record type, field or state.
- Emission (`c4a81b05e`, `4f466e143`; on main `d8aad66b3` via `e1e8e83c1`): under v3 the agent-discovery chunk carries the derived declaration, floor 5; v3 is v2 plus that key and nothing else (`compilerSemanticProfileAtLeast` replaces the `=== v2` checks). The runtime reads agent discovery up to 5. The checked-in release is byte-identical to main (floor 2), so no re-pin or re-baseline is owed.
- Fixed on the way: the dispatch alias carries placeholder preconditions, so the derived declaration had lost every gate and enum lifecycle; it now reads the authored preconditions, and a test pins emitted = derived.
- Routing (`risk.ts`): an owned type acts at once only on its capability's declared fields, less any a release consumer reads; a type no capability owns acts at once only on fields classed `exact` / `restorePriorValues` / `record`, under the compiled `holdsWhile`; a release without the declaration asks, so today tenant types ask.
- Consumer rule, fail closed: every release member not in `PASSIVE_RELEASE_MEMBERS` (workflows, rules, calculated fields, billing plans, documents, connector bindings, any later member) makes the fields it names ask.
- Older reader (rule 13): the head compiled under v3 (`compiledAppViewV3`) is installed fresh; the archived `d8aad66b3` binary answers an item query on its own release and refuses the v3 release with `UNSUPPORTED_RUNTIME_CAPABILITY`, agent-discovery 5 against 4; rows persist byte for byte (`request-runtime-view.test.ts`).
- Rule 8, each applied after `4f466e143` and restored: emission removed (emission, unowned tests); alias preconditions back (emission, unowned-line); consumer scan narrowed (fail-closed test); routing removed (unowned test); owned consumer tightening removed (consumer-rule test); compiled `holdsWhile` dropped (unowned-line); floor 4 (emission test); key on v2 (check:app-release, golden vectors); v3 drops v2 output (v3 = v2 + key test).
- Rule 17: (a) one release-derived reversibility class per operation and field, readable by any consumer (autonomy, Undo, workflows, audit); (b) any release unchanged once it compiles under v3, first-party or tenant, a clinic, distributor or rental desk; (c) narrower: v3 is not adopted, so no shipped release carries the key and tenant types ask (adoption is a later packet, bundled with other floor raises so the ~15 older-reader re-pins happen once); owned masters act only on what their capability declares; creates, archives and transitions ask; Customize members are charter slice 5.
- Also: the census test is registered as a compiler language-coverage producer; the profile-axis tests list v3. `wip/AI-UNDO-1-s2-switch` stays out of every train.
- Gates (slice 2): local typecheck, lint, unit 527, compiler 197, agent 95, architecture 240, integration 341, check-records, check:language-coverage; PostgreSQL: the older-reader proof alone. Full CI on the branch tip: see the review-log row.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1", "packet": "AI-UNDO-1",
  "base": "e1e8e83c137aa45538a7099e2a4aa1a440128d4e",
  "head": "4f466e1432083e011b17052a710e7fe3ba3038a1",
  "changedPaths": [
    "packages/compiler/src/compiler.ts", "packages/compiler/src/index.ts", "packages/compiler/src/projections.ts",
    "packages/compiler/src/protocol.ts", "packages/compiler/src/reversibility.ts", "packages/operations-agent/src/catalog.ts",
    "packages/operations-agent/src/risk.ts", "packages/runtime/src/request-runtime-view.ts", "test/agent/business-map.test.ts",
    "test/agent/compiled-view.ts", "test/compiler/compiler-semantic-profile.test.ts", "test/compiler/disclosure-tier-projection.test.ts",
    "test/compiler/reversibility-census.test.ts", "test/helpers/reachability-producers.ts", "test/postgres/request-runtime-view.test.ts"
  ],
  "symbols": []
}
```
