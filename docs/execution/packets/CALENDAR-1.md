# CALENDAR-1 · Board, calendar and resource timeline

Slice 0 established [ADR-0086](../../decisions/ADR-0086-board-calendar-and-resource-timeline.md) with the owner’s reference survey. Fable’s verdict was ACCEPT WITH AMENDMENTS; the orchestrator accepted A1–A14. The delivery order is 1a (Board form), 1b (pointer), 2 (Calendar), 3a (generic timeline) and 3b (Booking timeline).

## Design decisions

- The customer adds a view to a record type in Customize. Each archetype has fixed anatomy, a compact presentation and a bounded Semantic Query.
- A board drop enters a Task for the record’s declared transition. A calendar reads a date or interval. The timeline can change either eligible edge through Booking’s Change interval operation. Extend and Shorten each require explicit confirmation.
- The proposal extends ADR-0036 with one pointer gesture over server-rendered targets. The ordinary form supports the same choices using a keyboard, touch or JavaScript-disabled browser.
- Slice 1a uses the existing INTERACT-1 Task. It has no dependency on UI-COMPOSE-1 pop-ups. ADR-0082’s amendment re-read returned ACCEPT WITH AMENDMENTS. BOOKING-1 is applying A8, the `booking.resourceWindow/v1` contract. Slice 3b waits for BOOKING-1 slices 1a, 2 and 3. The Booking calendar separately requires its owner-collection window query.
- Each executable capability takes its reader rung at merge. This design allocates no rung or migration.

Calendar slice 2 can bind a typed point or interval, and timeline slice 3a a typed interval, by stable field ID and an expected-contract pin once the corresponding CUSTOMIZE-5 slice ships. The pin must match the field’s granularity and end convention. The view chooses its axis zone independently. For a two-date source, the view declares the convention and pins ADR-0083 A1 for derived midnight, business-day and inclusive-successor boundaries (first valid instant after a gap, earlier offset in a repeated hour). Slice 2 proves Toronto March 8 leave occupies March 8 alone on a Vancouver calendar through both paths. [ADR-0087](../../decisions/ADR-0087-tenant-date-time-and-interval-fields.md)

Plan §8.6 item-4 evidence pairs the reference survey with the executable slice 1a walkthrough; that walkthrough is due with 1a.

## Gates

The record check and all 18 jobs passed at `662e09be`. The packet then incorporated the amended Booking contract and the next free ADR number under the docs-only re-run rule. The ADR specifies the acceptance evidence for the executable slices. [CI 44676435105](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44676435105)

## Test it yourself

1. In **What a drop can request**, move a card between two stages with two possible operations. Find the named choice, required confirmation and check of current state.
2. In the same section, extend 09:00–11:00 to noon while a second booking wins the hour. Trace the refusal to the original stored end. Follow **Change end** to see the same decision with JavaScript off. Moving the start instead must preserve the stored end.
3. In **Time windows, coverage and page budget**, find an interval that starts before the displayed month and ends inside it. Check how to reach entry 101, and what a shared resource can reveal to someone with availability-only access.
4. Run `scripts/check-records.sh` from the repository root. Expect exit status zero.
