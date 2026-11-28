# WORKFLOW-3 · Lifecycle and date workflow triggers

**Slice 1 · recordTransitioned, BUILD 2026-11-28.** Critical (migration, activation-adjacent definers, grant SQL; rule 18). Design: `/home/rvham/2rain-missions/WORKFLOW-3-design.result.txt`; Fable design read APPROVE WITH AMENDMENTS (B1-B8 and STOP checks 1-6 for s1). Owner rulings O1-O4 (2026-11-27) and orchestrator ruling Q3 (2026-11-28) are recorded in ADR-0073 A1. Migration 0074 and surface rung 54 are provisional (assigned at merge). One Customize member widened (saveWorkflow's trigger union).

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/46133712994

## What slice 1 adds

- Trigger member `{kind: 'recordTransitioned', triggerVersion: 'v1', recordTypeId, toStateId, fromStateId?}` (strict, add-only). The event is `TriggerEvent` with `fromStateId` and `toStateId`. The record type, the target state and a pinned from-state are literals.
- Admission (compiler `workflows.ts`): the type is admitted as for recordCreated. In addition, its machine must have every declared transition performed by an active generic transition operation (ruling Q3), the target must be entered by one of them, and a pinned from-state must have an admitted transition into the target. A machine any other writer moves is refused by name, for example the purchase and sales order lifecycles.
- Occurrence (0074): `record_creation_occurrences` gains `kind` and both states. The per-command key becomes (command, kind, type, company, record) (B1). The definer `record_transitions` is called by the generic transition writer after its UPDATE. It passes the company that UPDATE returned (B2), and the stored row in that company must be in the target state, exactly one row. The from-state is the compiled constant pinned in that UPDATE's WHERE (B3).
- Definitions gain `to_state` and `from_state`, and the shape CHECK covers three arms. The digest and the approval binding append states only when present. A recordCreated definition keeps its exact digest and binding bytes (B4, pinned by two tests).
- The claim page stays keyed by type. The consumer matches kind and states and resolves the rest INELIGIBLE. The capture is unchanged (type-keyed). The page and scope definers are dropped, recreated and re-granted, with no PUBLIC execute (B5).
- The trigger scope that loadRun, the approval worklist and staff Retry all re-derive through also matches the occurrence's kind and states with the run's definition, in one place (B7).
- Every floor gate (compiler, release verification, serving) reads one per-member rung table (B6). The TS sites widened: `workflowTriggerSource`, the consumer's definitions and match, loadRun's event and `runTrigger`, admission storage and re-check, the SDK event type, the fixture schema and match, and the Customize workflow list label.
- B8: `test/architecture/record-state-writers.test.ts` lists every managed-table UPDATE with the machines it moves. It fails closed on an unlisted writer and on a listed machine that admission would admit. It checks that only the generic writer names moves, and that no compiled caller-writable input contract admits a machine state field.
- Rule 12: drafter lines are generated from the member table, plus the per-type states of admissible machines, computed by the compiler's own rule (labels quoted as data). Evals RT01-RT03 cover field service, a clinic referral that asks approval, and a lease with a hostile state label. The scorer checks member, record type, target state and from-state.

## Test it yourself

| Slice | Try it | Expected observation |
| --- | --- | --- |
| 1 | `node --import tsx --test test/unit/workflow-triggers.test.ts test/architecture/record-state-writers.test.ts`, then (PostgreSQL) `node --import tsx --test test/postgres/workflow-record-transitioned.test.ts`. | The unit and census tests pass. In the journey, two inspections fail in two companies of one tenant and start exactly two runs, and each creates a Repair linked to its inspection in that inspection's company. A pass, a fail from In progress, the creations, and a fail before activation start nothing. |

## Discriminating proofs (rule 8)

The controls are in [`WORKFLOW-3-s1.expected-red.json`](../../../test/evidence/WORKFLOW-3-s1.expected-red.json), 20 entries, one per check:
- the writer call, and the definer's stored-state, company and governed-write checks;
- the per-command key with kind;
- the created digest bytes and the created binding keys;
- the recreated definer's PUBLIC revoke;
- the scope's definition match;
- the consumer's kind/state match, from-state filter and INELIGIBLE resolution;
- the capture covering moves;
- the three admission checks;
- the member's own rung;
- the verification and serving floor gates;
- the census on an unlisted writer.

Not re-proved, because unchanged by this slice: the occurrence start-key index and the seal (0070, WORKFLOW-2's reds).

## Rule 17

(a) The most general form: a committed fact about a record, named by its governed writer, starts runs keyed by occurrence. Creation and every move of a declared machine are two kinds of one source.

(b) It is used unchanged by any tenant lifecycle: field-service inspections and jobs, clinic referrals and appointments, rental agreements, property leases, distributor returns. The created and transitioned kinds share one page, dispositions, capture, start key, scope, loop rules and gateway link rule.

(c) Deliberately narrower:
- Machines moved by the four capability executors are refused. Having those executors name their moves is the owner's call.
- Unresolved occurrences of unsubscribed types are never pruned; this is listed in FIRST-TENANT-OWED.
- The booking engine's commitment states are engine facts, not record machines, and need their own member.

## Rule 13 / 21(c)

Rung 54 is provisional. No preceding-binary proof was built; a FIRST-TENANT-OWED row was added.
