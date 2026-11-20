# CALENDAR-1 · Board, calendar and resource timeline

Slice 0 proposes [ADR-0086](../../decisions/ADR-0086-board-calendar-and-resource-timeline.md) for the orchestrator’s Fable read. The three executable slices follow its ruling.

## Design decisions

- The customer adds a view to a record type in Customize. Each archetype has fixed anatomy, a compact presentation and a bounded Semantic Query.
- A board drop enters a Task for the record’s declared transition. A calendar reads a date or interval. The timeline can change either eligible edge through Booking’s Change interval operation. Extend and Shorten each require explicit confirmation.
- The proposal extends ADR-0036 with one pointer gesture over server-rendered targets. The ordinary form supports the same choices using a keyboard, touch or JavaScript-disabled browser.
- UI-COMPOSE-1 supplies Record, Task and brand contracts. Timeline uses BOOKING-1 slice 1’s interval writer and slice 2’s resource-window query with separate availability and detail permissions.
- Each executable capability takes its reader rung at merge. This design allocates no rung or migration.

## Gates

The record check and all 18 jobs passed at `662e09be`. The packet then incorporated the amended Booking contract and the next free ADR number under the docs-only re-run rule. The ADR specifies the acceptance evidence for the executable slices. [CI 44676435105](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44676435105)

## Test it yourself

1. In **What a drop can request**, move a card between two stages with two possible operations. Find the named choice, required confirmation and check of current state.
2. In the same section, extend 09:00–11:00 to noon while a second booking wins the hour. Trace the refusal to the original stored end. Follow **Change end** to see the same decision with JavaScript off. Moving the start instead must preserve the stored end.
3. In **Time windows, coverage and page budget**, find an interval that starts before the displayed month and ends inside it. Check how to reach entry 101, and what a shared resource can reveal to someone with availability-only access.
4. Run `scripts/check-records.sh` from the repository root. Expect exit status zero.
