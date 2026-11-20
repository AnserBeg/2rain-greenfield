# CUSTOMIZE-5 · Put a customer-built appointment or shift on a time axis

**Slice 0 · Docs only, 2026-11-20.** Fable accepted [ADR-0087](../../decisions/ADR-0087-tenant-date-time-and-interval-fields.md) with amendments A1–A11 and nits N1–N6. The orchestrator’s narrow re-read of A4 is due before slice 1. This round touches no Critical path.

## Slice plan

| Slice | What a customer can do | Acceptance at that slice |
| --- | --- | --- |
| 0 · Design | Trace an appointment, a shift and a day of leave through their declared types. | Specify the optional v6 projections, storage columns, database checks and field-owned indexes. The existing-table index proposal in A4 goes to the orchestrator for re-read. |
| 1 · Service appointment | Add a `dateTime` field to a tenant record type, approve it, then enter, edit, list and sort appointments. | Ship `addDateTimeField` with its merge-time rung and replay test. Prove typed gap/overlap entry using both zone sources, record-zone display, list order by instant and UTC-process document output. The viewer-zone switch may follow slice 1 as reader behaviour. This supplies CALENDAR-1’s timed point. |
| 2 · Staff shift or leave | Add an `interval` field and reopen both endpoints together. | Ship `addIntervalField` with its own merge-time rung and replay test. Scoped GiST depends on `btree_gist` from BOOKING-1 slice 1a. Prove date-only inclusive/exclusive, timed exclusive, parser refusal of timed inclusive, invalid entries, elapsed duration, civil day count, derived DST boundaries and UTC-process output. Supply typed intervals for CALENDAR-1 slices 2 and 3a. |

Each field uses the ordinary draft, diff, verification, approval, activation and compatible pointer rollback. CALENDAR-1 owns the view bindings and the slice 2 cross-zone membership proof. Booking’s governed interval has its own source contract.

**Slice 0 gates.** The record check and all 24 hosted jobs passed for the original proposal at `9b4a2735`. This amendment uses the docs-only no-re-run ruling and the record check. [Packet CI](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44746473972)

## Test it yourself

**Now, on the design (under five minutes).** Follow the entry, display and window rules in ADR-0087 for these examples. Each row names a proof for its executable slice.

| Try | Expected observation |
| --- | --- |
| 1 · On **Service job**, set **Appointment** to per-record `America/Toronto`. Enter March 8, 2026 at 02:30, then November 1, 2026 at 01:30. Repeat using the Toronto company calendar. | March is a gap and the form preserves the refused entry. November offers UTC−04:00 and UTC−05:00, yielding 05:30Z and 06:30Z respectively. UTC−06:00 refuses. The two equal-looking civil times sort in instant order. |
| 1 · Save the later November appointment. Select `Etc/UTC` in **Viewer zone** when the switch ships, then reopen the edit form. | Record zone shows 01:30 UTC−05:00. Viewer zone shows 06:30 UTC+00:00. Edit opens at the captured 01:30. A calendar change leaves an untouched field intact. Editing the company-sourced time recaptures the current calendar. |
| 2 · Enter a Toronto shift from 01:30 UTC−04:00 through 01:30 UTC−05:00 on November 1, timed and end exclusive. Open the window starting at 06:30Z. Try declaring timed + inclusive. | The Record shows one elapsed hour. The shift misses that window and an abutting shift may start there. The patch parser refuses timed + inclusive. A partial or reversed shift refuses on write. Equal instants give an empty-interval error pointing to `dateTime`. |
| 2 · Enter March 8 through March 8, 2026, inclusive, in Toronto with a midnight boundary. Switch viewer zones. Repeat as exclusive, then extend the exclusive end to March 9. | The Record shows **March 8**, one civil day. The evidence spans 05:00Z March 8 to 04:00Z March 9 (23 elapsed hours). Equal exclusive dates refuse as empty. The March 9 exclusive end restores the one-day range. |
| 2 · Set the Toronto business-day boundary to 02:30 and enter inclusive leave for March 7. Then use a 01:30 boundary for November 1 leave. | The derived March 8 successor falls in the gap and resolves to 03:00 UTC−04:00 (07:00Z). The repeated November 1 start resolves to 01:30 UTC−04:00 (05:30Z). Both save without an offset prompt and pin the rule version. |
| CALENDAR-1 slice 2 · View Toronto leave for March 8 on a Vancouver month calendar, first from two dates, then from the typed interval when available. | Both entries occupy March 8 alone. Neither appears on March 7. An instant-axis timeline bar retains its civil label. |
| 1 and 2 · Generate a document in a UTC process. In slice 1 bind the later November appointment and a March 8 civil date. In slice 2 bind the date-only leave and the timed shift as well. | Inspect the PDF text. It prints **01:30 UTC−05:00** for the appointment, **March 8** for the date and leave, and both captured offsets for the shift. A process rendering of 06:30 or a prior-day date fails the proof. |

## Release and upgrade proofs for each executable slice

- Require the whole field when status is Scheduled. An absent field refuses and a complete value passes. Exercise named comparison, maximum length and numeric duration gaps, including literals, same-record and to-one comparisons and calculated operands/results. Exercise each row of the ADR’s consumer table, including saved string filters and forged bindings. Every refusal identifies the type, field and use.
- Check the database constraints against partial captures, civil/offset/instant disagreement and, for intervals, empty, reversed, non-finite or inconsistent ranges. Verify the scoped window index at activation. Commit before removing each independent guard and require its own regression proof to fail.
- Recompile a first-party release and a real customized release omitting both declarations against identical parents and provenance. Compare normalized bytes, entire envelopes, roots and floors read back from persisted release rows. Exercise the archived production loader immediately preceding each rung on a declaring release. After slice 2 cover date-time alone, interval alone and both together against their required floors. Missing bindings and understated floors refuse before serving.
- Reproduce the original roots, upgrade across an unrelated base addition, reopen a pre-upgrade value and write a second. Exercise a real ID collision for each kind and observe the named patch, `FIELD_COLLISION`, and continued verified source reads. Remove each allowlist entry in turn and require the vocabulary check to name it. Include ordered change-set replay. Roll back and re-activate a compatible release to read the original value again.
