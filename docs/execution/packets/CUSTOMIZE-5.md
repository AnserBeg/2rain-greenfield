# CUSTOMIZE-5 · Put a customer-built appointment or shift on a time axis

**Slice 0 · Design proposed, 2026-11-20.** Fable’s R1 on ADR-0086 identified the missing field types. The orchestrator’s Fable read of [ADR-0087](../../decisions/ADR-0087-tenant-date-time-and-interval-fields.md) precedes code. This packet adds documentation only and touches no Critical path.

## Slice plan

| Slice | What a customer can do | Acceptance at that slice |
| --- | --- | --- |
| 0 · Design | Trace the examples below against the proposed field contracts. | Record check and docs-only integration. |
| 1 · Service appointment | Add a `dateTime` field in Customize, approve it, then enter, read and edit an appointment in its declared zone. | Publish `addDateTimeField` end to end with its own merge-time rung and UPGRADE-2 replay test. Exercise company and per-record sources and both display modes. This supplies the timed point source for CALENDAR-1 slice 2. |
| 2 · Staff shift or leave | Add one `interval` field, choose timed or date-only and an end convention, then save and reopen both endpoints together. | Publish `addIntervalField` with its own merge-time rung and replay test. Exercise both conventions at both granularities, empty, partial and reversed entries, and a shift across DST. This supplies the typed interval source for CALENDAR-1 slices 2 and 3a. |

The existing CALENDAR-1 two-date path and Booking’s governed interval have their own source contracts. Calendar and timeline bindings ship in CALENDAR-1. The field slices use the normal draft, diff, verification, approval, activation and compatible pointer rollback.

**Slice 0 gates.** The record check passed. All 24 hosted jobs passed at `9b4a2735` before synchronization with main. [Packet CI](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44746473972)

## Test it yourself

**Now, on the design (under five minutes).** Open the linked ADR beside this table. Use its entry, display and window rules to check these examples. After the relevant slice ships, repeat them on tenant record types in Customize using the ordinary create form and Record.

| Try | Expected observation |
| --- | --- |
| On **Service job**, set **Appointment** to per-record `America/Toronto`. Enter March 8, 2026 at 02:30, then November 1, 2026 at 01:30. | March is a gap and saving refuses. November offers UTC−04:00 and UTC−05:00. Choosing them produces 05:30Z and 06:30Z respectively. UTC−06:00 refuses. |
| Save the later November appointment. Switch from **Record zone** to viewer zone `Etc/UTC`, then reopen the edit form. Repeat using a company calendar set to Toronto. | The record shows 01:30 UTC−05:00, the viewer sees 06:30 UTC+00:00, and edit opens at the captured 01:30. A company-sourced entry obtains Toronto from the calendar. |
| On **Shift**, enter 01:30 UTC−04:00 through 01:30 UTC−05:00 on November 1 in Toronto, timed, end exclusive. Read the window starting at 06:30Z. Repeat with an inclusive timed end. | The exclusive shift lasts one hour and misses the window. The inclusive shift belongs to its first millisecond. Submitting an end alone on an empty record or reversing the offsets refuses the write. |
| On **Leave**, enter March 8 through March 8, 2026, date-only, inclusive, in Toronto with a midnight boundary. Switch viewer zones. Try the same endpoints with an exclusive end. | The label stays March 8. The inclusive range is 05:00Z March 8 through 04:00Z March 9 (23 hours). The equal exclusive pair refuses as empty. |

## Release and upgrade proofs for each executable slice

- Try the field in a validation rule (including a related record’s terminal field) and a calculation. The compiler identifies `dateTime` or `interval` and the unsupported position.
- Recompile a first-party release and a real customized release omitting both declarations against identical parents. Compare normalized bytes, entire envelopes, roots and floors. Exercise the immediately preceding serving reader on the declaring release. After slice 2 include date-time alone, interval alone and both together. A missing binding or understated floor refuses admission.
- Reproduce the original roots, upgrade across an unrelated base addition, reopen a pre-upgrade value and write a second. Exercise a real ID collision for each kind and observe the named patch, `FIELD_COLLISION`, and continued verified source reads. Remove each allowlist entry in turn and require the vocabulary check to name it. Include ordered change-set replay. Roll back and re-activate a compatible release to read the original value again.
