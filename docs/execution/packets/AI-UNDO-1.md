# AI-UNDO-1 — the assistant asks before putting a customer on or off credit hold

Status: slice 1 (`packet/AI-UNDO-1-s1`, tip `3048f69c5`) is with Fable for the rule 11 check, then a train. Slice 2 (`packet/AI-UNDO-1-s2`) STOPPED at a safe boundary; see Slice 2 below. Tier: packet, first-party base change. No migration, grant or reader rung. Stops taken: none.

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

## Slice 2 — stopped for two rulings

- Built, not wired: `packages/canonical-model/src/reversibility.ts` (the consumer-neutral declaration, its strict reader, absence = `none, outward`) and `packages/compiler/src/reversibility.ts` (derivation from contracts, preconditions, state machines, `parentScopedChild` relations, field declarations; no names). Measured by `test/compiler/reversibility-census.test.ts`; today's per-state behaviour pinned by the `AI-UNDO-1 lock` test.
- Blocker 1 (ADR-0047): emitting the key into the agent-discovery chunk fails `COMPILER_HISTORICAL_REPRODUCTION_MISMATCH`; new output must ride a compiler semantic profile v3 adoption (its own packet so far). An unadopted v3 would leave first-party with no declaration, so nothing would act at once.
- Blocker 2 (A2 at scale): from release facts alone 233 plain edits derive `exact, record` (today 11), including fields capability code reads that the release does not declare (`party_credit_limit`, `item_base_unit`, item inventory policy and standard costs, location and legal-entity status, invoice and bill balances). Each needs a declared gate or a capability read declaration before it may act.
- The wiring (projection key at agent floor 5, catalog reader, `risk.ts` with no hand list, session lifecycle and parent checks replacing name suffixes and `parentEditApprovals`) is kept on `wip/AI-UNDO-1-s2-switch`, not for merge.
- After the rulings: CRITFIX-A retarget, second application, architecture test, older-reader proof pinned to `1092e14d`.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "AI-UNDO-1",
  "base": "37bfd47311c58060000cebca49d5f55174e3874a",
  "head": "6d651b08ff8e3ac4c7b3e1e51f63455278dbb73c",
  "changedPaths": [
    "apps/web/release/app.authored.json",
    "apps/web/release/app.compiled.json",
    "packages/domain/src/party/definition.ts",
    "test/agent/business-map.test.ts"
  ],
  "symbols": []
}
```
