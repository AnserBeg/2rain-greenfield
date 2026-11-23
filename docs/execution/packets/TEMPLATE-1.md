# TEMPLATE-1 — Start a record from an assigned template revision

Slice 0 · Documentation only · Amended once after the independent read on 2026-11-21. The ADR number is assigned at merge. [Design](../../decisions/ADR-XXXX-record-templates.md)

## Claims for the read

1. A worker can publish ordered content for an existing record structure and assign a specific revision to a specific context.
2. Opening an old record shows the questions, column captions or role names originally applied and that record’s own answers.
3. Applying requires current scoped write authority. A retry recovers exactly one original record and cannot replace its answers.

## General blocks and their consumers

| Block | Equipment safety | Print production | School administration |
| --- | --- | --- | --- |
| Add immutable content revisions and context assignments | Checklist for a lift class | Grid for booklet jobs | Contact roles for primary enrolments |
| Add atomic application with a revision receipt and individually owned answers | Inspection results | Quantities and steps on a job ticket | People selected for one pupil |
| Extend the declared editor and detail slots to present pinned groups and columns over owned lines | Typed result and note per question | Selected columns over editable steps | Empty or populated role sections with a Person picker |
| Reuse scoped operations and in-app drafting for bindings and business content | Draft questions and start a check | Draft a grid and start a ticket | Draft roles and start an enrolment |

The audit identifies 12 survey rows, A16, A18, A24, A27, B3, C6, C8, C9, F2, F4, F6 and F9. A kit contributes suggested members and a standard job contributes instructions. Stock issue, scheduling and safety release each retain their own operation. [Generality audit, Part B](/home/rvham/2rain-missions/generality-audit.astra.result.md) · [Survey](/home/rvham/2rain-missions/rain-survey/inventory.md)

## Launch decisions

1. The owner chose one library per company. Publication uses the library’s stored company. Assignment verifies ownership of the context and revision.
2. Workers must use the exact required assignment. Attempt a different readable revision and an empty required context. Both refuse. After the assigner repairs the missing assignment, a fresh worker preview succeeds.

## Slices and acceptance

| Slice | What a worker can do | Evidence at that checkpoint |
| --- | --- | --- |
| 0 · Design amendment | Trace the three records on paper. | Use the five-minute walkthrough below. |
| 1 · Publish, assign and create | Create a binding in Customize, publish a template and assign it to a class and create from it atomically. | Compare visual and plain-English drafts, race two publications of one predecessor, check source/audience, company scope, assignment locks, guarded atomic application, verification sample create, retries and the declaring merge gates. |
| 2 · Equipment safety | Create and answer the two inspections across a change. | Exercise the full editor and assistant journeys, Release refusal and historical reads. |
| 3 · Print and school | Create two tickets and two enrolments across different revisions. | Read back both generations in each business after retirement using the same declared slots and operations with distinct business IDs. |

## Amendment rules and executable acceptance tests

- **A1 · Editor and detail.** Run all three ADR walkthroughs through the generated views. Compare the pinned field/relation IDs, captions, group keys/order, distinct child IDs and edited values. Exercise explicit source column/row selection, changed column order and a picker in each empty role section. Verify Legal guardian retains Guardian’s key. Substituting the current assignment for the pin must fail the old-record assertions.
- **A2 · Release.** Validate supplied choices on write and permit incomplete drafts. With the guard absent, submit a complete passing quarantined inspection through the UI, assistant and direct CUSTOMIZE-4 Release operation. All refuse with a capability gap and retain Quarantined. Enabling Release requires the decision 6 matrix for missing rows/answers, illegal N/A, missing notes, blocking Fail with a note and one valid release. Race answer edits in both orders and try reclassification before and after Release.
- **A3 · Source and worker authority.** At publish, separately deny a source read, mark a selected field ineligible for copying, and restrict a selected value from the audience. Expect no published revision. In one company give the worker revision/context read, apply and parent create. Withhold only one seed-field write, then only one referenced-record read. In each case deny preview and direct create (using a preview issued before revocation), with no protected default in responses and zero committed creation facts.
- **A3 · Stored owners and current reads.** Use two companies in one tenant/environment. A dual-company assigner pairing A’s stored context with B’s revision refuses. An A-only worker listing libraries or supplying known B IDs to assignment, revision or instance history, preview, create and retry gets no B data or changes. Use correct stored IDs. Revoke access to Jo after S-9 commits and inspect detail, history and retry for disclosure of Jo’s label or ID. Restore access and recover S-9. Removing the scope and apply checks independently must fail their respective tests.
- **A4 · Atomic create and retry.** Use the editor, import, assistant and direct create, including a header-only request without the required preview. Inject a last-seed failure and require zero header, application, rows, success audit and receipt. Submit identical requests concurrently, lose the winning response, edit an answer, reassign, retire and switch to a compatible release. Retry at each step and assert one original header, application, row set, creation audit and receipt with the edit preserved. A changed payload under the key refuses. Withhold read-back, retry twice and restore grants. The receipt still identifies that one record.
- **A4 · Races.** Pause first assignment at an unused context against simultaneous template retirement. Make each writer win the company library lock in turn. Retirement first must refuse the assignment, assignment first must leave the retired revision closed to fresh creation. Race two first assignments on one empty key and expect one winner. With an uncommitted preview, reassign or move the release pointer away and back. The old preview refuses, writes nothing and requires fresh review.
- **A5 · History and rollback.** Use the scoped Record application query on an applied inspection and retry its committed receipt after binding retirement and again after compatible rollback. Check the applied context, typed choice meaning, failure rule, edited answer, guard and receipt identity. Independently remove the historical decoder or restore the source-state-only Release path in a rollback target. Both targets must refuse and the verified source must serve the original record.
- **A6 · Live in-app AI.** In AI-BUILD-1 run ADR decision 8 end to end. An owner approves and activates the proposed binding, an author edits a plain-English content draft before publishing, and an assigner chooses Lift. The assistant uses the mechanic’s grants and confirmation policy to create from the server-selected revision. Verify the wording and receipt. Deny apply, then change the assignment after preview. Both refuse without a record and the latter requires fresh review.
- **A7 · Replay and admission.** Removing the binding patch from replay or drafter coverage must fail CI. Reproduce the authoring root, run the active/retired compatible changes and named Copies type conflict, and compare persisted feature-absent bytes as specified in decision 7. At executable merge allocate floors and run the actual preceding binary through production admission. Require a real compatible query result, named pre-parse refusal at cold boot and after a pointer move, and a compatible query that returns the expected record. UPGRADE-2 slice 5 owns deployment refusal after rollback as its named fleet-register entry condition.

## Test it yourself

**Five-minute design read.** Follow both records in each walkthrough. After assigning revision 2, predict their editor and detail views and what retrying the first creation returns. [Three walkthroughs](../../decisions/ADR-XXXX-record-templates.md#three-acceptance-walkthroughs)

- **Safety.** I-17 shows “Does the brake hold?”, Fail, “Slips under load” and cab light N/A. I-18 adds the guard question with Pass and keeps its own brake answer blank. Retrying I-17 returns the original inspection.
- **Print.** P-41 has Step / Copies with Proof 1 and Run 750. P-42 has Impressions / Step with 250 Run, 1 Proof and 1 Trim. Retrying P-41 adds no row.
- **School.** S-9 shows Guardian Jo and Emergency contact Sam. S-10 starts with three empty sections, Pickup delegate, Legal guardian and Emergency contact. Retrying S-9 returns the original enrolment under current access.

## Design gate

The quick run below covers the original ADR at `33c665d62214545c5fa01146c956e57ac817ae42`. The amendment gate is `bash scripts/check-records.sh`. A1–A7 specify tests for future executable slices. [Independent read](/home/rvham/2rain-missions/template1-adr.sol.result.txt)

CI tier: quick https://github.com/AnserBeg/2rain-greenfield/actions/runs/44956138996

## Slice 1 build checkpoint · 2026-11-22

The build branch is `packet/TEMPLATE-1-s1`, merged with main at `d8aad66b` (after REBASE-1 and TRAIN-L). The provisional allocations are migration 0069, Surface reader 48 (main took 47 for presentation) and operation reader 7; the integrator reassigns them at train time. The PostgreSQL proof runs in shard 5. Archived probes meet the test database at their own migration level (UPGRADE-2 ruling, option 1: `presentLedgerAtArchivedLevel`, with its own red). `CUSTOMIZE_RECORD_TEMPLATE_CONFLICT` is repairable (a draft-shape mistake, like Board); R01–R03 carry a dated eval exception until they join BUILD_CASES.

| General block | Equipment safety | Print production | School administration |
| --- | --- | --- | --- |
| Customize binding and replay | Inspection results by class | Job steps by job class | Contact sections by programme |
| Company publication and assignment | Ordered brake questions | Selected Copies defaults from a saved job | Named contact roles for the selected programme |
| Editable English draft and human review | Review permitted answers and notes | Review a reusable starting grid | Review proposed role captions and ordering |

The PostgreSQL test exercises all three definitions in one tenant and uses two companies. It includes source-read revocation, field and value restrictions, competing publications, an existing revision in the other company, first assignment and retirement in each lock order. On an isolated fixture with a declaring release already selected, the stored functions passed the source and audience checks, known-ID company denials, competing publications and both lock orders. Removing the audience check, exact source-cell comparison, released choice-meaning check or either stored-company filter failed its corresponding assertion. All three businesses published and assigned revisions through Customize and the library on a disposable build with the create guard disabled.

The preceding binary `d8aad66b` must reproduce the persisted normalized definitions, artifact bytes and roots and return the known inspection from the compatible get query. On a declaring release it must refuse cold boot and a query after the pointer move by name before parsing any payload. Creation is atomic in this slice: an active binding refuses an unprepared create, and release verification creates its sample through the independent verifier probe. An A-only worker reads the first company’s application but is refused the second company’s application and preview for the same parent. UPGRADE-2 slice 5 owns the fleet deployment check after rollback. Create-path red controls are declared in `test/evidence/TEMPLATE-1.expected-red.json` for the `run-controls` evidence job. A timed local run at load 10 to 17 showed no lock waits but never passed composed start-up in 18 minutes; on CI the proof reached the older-reader step in 1m44s. Full pending.

**Rule 12.** The drafter covers `addRecordTemplateBindingRevision` from its schema. Dated AI-BUILD-1 cases R01–R03 (inspection checklist, print job grid, enrolment contact roles) live in `test/agent/build-eval-cases.ts`. Their scorer accepts a scripted correct draft and refuses a wrong requirement or context.

**Test it yourself** (about two minutes on a prepared checkout). Run `node --import tsx --test --test-name-pattern='record template bindings reproduce|Customize tool admits|upgrade replay admission|upgrade replay of addRecordTemplateBindingRevision|record template eval cases' test/unit/customization-upgrade.test.ts`. Expect five passing tests. Removing the binding replay entry or its generated drafter schema fails the corresponding inventory test.
