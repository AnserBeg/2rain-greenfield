# WORKFLOW-2 — make AI-written workflows safe, reliable and usable on customer-built modules

Status: design only, proposed 2026-11-20. Docs-only. No code, migration or
reader rung in this packet. Charter: orchestrator missions folder,
`charters/WORKFLOW-2-charter.md`. Source ruling:
`workflow-scripts-ruling.fable.md`.

[Design: ADR-0073, WORKFLOW-2 amendments](../../decisions/ADR-0073-workflow-isolate-and-authority.md#workflow-2-amendments-2026-11-20-proposed) ·
[Engine patch policy](../../operations/engine-patch-policy.md)

## Decisions in one line each

| Item | Decision |
| --- | --- |
| 1 Triggers | A versioned trigger union: `goodsReceiptPosted` unchanged, plus `recordCreated`, `recordTransitioned` and `scheduledOnField`. IDs only (rule 10). Exactly once by source event; the schedule key excludes revision, timer and fence. Always Manual on activation. One rung per member, allocated at merge. |
| 2 Repair loop | At most two repair turns that receive type-check, lint and replay diagnostics. |
| 3 Review | Pending draft shows the source, a plain-words sample run from the fixtures, and a summary derived from call sites. The approval binds the rendered review. |
| 4 `waitForEvent` | Removed from the SDK. A named gap. Old pins keep old behaviour. |
| 5 Engine patch policy | Written note, named owner role, deadlines, human-Retry-only move. |
| 6 Isolation | Draft verification moves into the forked sandbox with an allowlisted environment and a time bound. Live runs: separate process or accept WASM, **for Fable's design read**. |
| 7 Nice-to-haves | CPU-overrun retry, per-tenant run-rate limits, sleep cap. The rest are named gaps. |

## Slice plan

Order is by dependency. Slices 1 to 4 do not depend on the trigger decisions and
may start when this merges. Slices 5 to 7 wait for Fable's design read. A
migration or rung takes the next free number at merge. Every slice ends with CI
green and a "Test it yourself". Critical slices get an independent read from
Fable or Codex sol, never from the writer's model.

1. **Draft isolation (A6 draft half).** `verifyWorkflowDraft` in the sandbox,
   allowlisted child environment, 30 s bound, trace of candidate admission's
   process boundary. Tests: the child sees no database variable and opens no
   connection; an infinite loop in a draft is killed at the bound; each check
   fails when removed. Not Critical.
2. **Repair loop (A2).** Diagnostics feed, turn counter, cost cap, evidence.
   Tests: a seeded type error, a lint error and a replay divergence are each
   repaired in at most two turns; a third failure reaches the user with the
   diagnostics; authority and unsupported refusals are not repaired.
3. **Review before approval (A3).** Source, sample run, call-site summary, digest
   in the approval proof. Tests: pending draft shows all three; same inputs render
   the same bytes; a changed body changes the proof; a declared-but-uncalled grant
   is flagged. Browser journey.
4. **Remove `waitForEvent` (A4) and the nice-to-haves (A7).** SDK version bump,
   `REMOVED_ACTION` on replay, sleep cap, CPU retry, rate limits. Tests: a body
   calling it fails type-check; a legacy pin still suspends; a second overrun
   quarantines as `cpu-limit-exceeded`; a rate-limited event starts later.
5. **`recordCreated` (A1).** Source audit first; the union and its reader rung;
   consumer and watermark union by (event type, record type); trigger record link
   in the gateway; loop bound; drafter support and eval cases (rule 12).
   Critical. Tests below.
6. **`recordTransitioned` (A1).** Same shape. If the audit finds the transition
   is not durably recorded, this slice stops for an owner decision before any
   writer change.
7. **`scheduledOnField` (A1).** Registration table (a migration), firing, past-due
   handling, A1 time rules, activation evidence counts, rung. `date` fields first;
   `dateTime` follows ADR-0087's field landing. Critical.
8. **Live-run isolation (A6 live half).** Only after Fable's choice. A gate before
   the first real tenant activates a workflow.

Proofs every trigger slice carries:

- **Exactly once:** duplicate delivery, polling retry and a crash between claim
  and start each yield one run.
- **Two companies in one tenant:** a trigger record of company B never starts a
  company A run, and a link to a record the trigger did not name is refused.
- **Rollback and upgrade:** an event committed before a rollback starts nothing;
  an unfired registration re-arms under the same key; a consumed one stays
  consumed; the release is Manual and its evidence counts registrations.
- **Reader rung:** a binary one rung below refuses the release through the
  archived production loader. No-workflow byte identity still holds.
- **Rule 10:** with the member active, and again after retiring it, adding a
  field and arranging the list on that type compile; a label-only base change
  replays clean; a retired state or field is `RETIRED_TARGET`.
- **Replay:** one compatible base move and one real conflict per member.
- **Rule 12:** the fail-closed coverage test enumerates trigger members; each has
  generated drafter text and an eval case.
- **Loops:** a workflow's own create does not restart it; depth above 3 starts
  nothing.

## Not done here

Interval-field triggers, working-day offsets, re-firing on a new anchor
generation, durable external-event waits, an instruction budget, independent
fixtures and live-model evidence (AI-BUILD-1), connectors.

## Test it yourself

This packet is documents only, so there is nothing to run in the app.

1. Open the [ADR-0073 amendment](../../decisions/ADR-0073-workflow-isolate-and-authority.md#workflow-2-amendments-2026-11-20-proposed).
   Check that A1 lists three new trigger members and keeps `goodsReceiptPosted`,
   that A4 says `waitForEvent` is a named gap, and that A6 marks the live-run
   choice "for Fable's design read".
2. Run `grep -n "for Fable's design read" docs/decisions/ADR-0073-workflow-isolate-and-authority.md`.
   Three lines should print: the status line, the live-run heading and the live-run choice.
3. Open the [engine patch policy](../../operations/engine-patch-policy.md). Check
   it names an owner role, a watch, a deadline per severity and that a worker
   never re-pins a run.
4. Run `scripts/check-records.sh` to confirm the record layer is consistent.
