# TEMPLATE-1 — Start a record from an assigned template revision

Slice 0 · Proposed design, 2026-11-21 · Documentation only · Stop for the requested design read. The ADR number is assigned at merge.

## Claims for the read

1. A worker can publish ordered content for an existing record structure and assign a specific revision to a specific context.
2. Opening an old record shows the questions, column captions or role names originally applied and that record’s own answers.
3. Applying requires current scoped write authority. A retry recovers exactly one original record and cannot replace its answers.

## General blocks and their consumers

| Block | Equipment safety | Print production | School administration |
| --- | --- | --- | --- |
| Add immutable content revisions and context assignments | Checklist for a lift class | Grid for booklet jobs | Contact roles for primary enrolments |
| Add atomic application with a revision receipt and individually owned answers | Inspection results | Quantities and steps on a job ticket | People selected for one pupil |
| Reuse typed fields, declared links, owned lines, record composition and scoped operations | Result and note per question | Named columns over editable lines | Named sections with authorized contact links |

The audit identifies 12 survey rows, A16, A18, A24, A27, B3, C6, C8, C9, F2, F4, F6 and F9. A kit contributes suggested members and a standard job contributes instructions. Stock issue, scheduling and safety release each retain their own operation. [Generality audit, Part B](/home/rvham/2rain-missions/generality-audit.astra.result.md) · [Survey](/home/rvham/2rain-missions/rain-survey/inventory.md)

## Decisions proposed in the ADR

1. Release a typed binding and publish business content as data. A schema release for each wording change would burden the author.
2. Resolve one explicit assignment per company, type, binding and context. Choosing the latest revision would silently change tomorrow’s records.
3. Keep an immutable source revision and fresh owned rows. A live template could rewrite the past, while a detached copy loses provenance.
4. Grant publishing, assigning, applying and answering separately. Inheriting an author’s rights would widen the worker’s access.
5. Create the parent, application, rows, audit and receipt in one transaction. A sequence of client saves could leave a half-filled checklist.
6. The consuming lifecycle owns its release guard. A shared inspection rule would impose a safety policy on printers and schools.
7. Replay binding choices by stable IDs and check reader compatibility. Rebuilding revisions from current labels would break unrelated edits.

## Slices and acceptance

| Slice | What a worker can do | Evidence at that checkpoint |
| --- | --- | --- |
| 0 · Design read | Trace the three records on paper. | Use the walkthrough below and review the two owner choices. |
| 1 · Publish and assign | Create a binding in Customize, publish a template and assign it to a class. | Show the plain-English and visual paths, preview/diff, permission refusals, competing revisions and compatibility gates in decision 7. |
| 2 · Equipment safety | Create and answer the two inspections across a change. | Read back I-17 and I-18 through the normal form and governed query. Exercise a retry, a partial-write failure and a denied apply. Confirm the release boundary in decision 6. |
| 3 · Print and school | Create two tickets and two enrolments across different revisions. | Read back both generations in each business after retirement. Run each proof through the same declared bindings and operations, using distinct business IDs. |

## Controls for executable slices

- Reassign after a lost create response. With authorized retry, assert one header, one application, one set of children and one creation receipt/audit event. Change an answer before retry and verify it survives. Inject a failure on the last seed and assert zero committed creation facts.
- Use two companies in one tenant/environment, the correct stored owner and a principal limited to the other company. Exercise create, direct apply, preview and retry. Independently remove the company check and the apply-grant check against fixtures that isolate each refusal.
- After publishing revision 2, compare each old record’s member keys, authored captions, order, original revision and edited values. Substitute the active revision in the reader and require the old-record assertion to fail.

## Test it yourself

**Five-minute design read.** Open the [three walkthroughs](../../decisions/ADR-XXXX-record-templates.md#three-acceptance-walkthroughs). Cover the last column. After assigning revision 2, predict what the first and second records show and what a retry returns. Check these three results.

- **Safety:** I-17 still says “Does the brake hold?”, Fail, “Slips under load” and cab light N/A. I-18 adds the guard question. Retrying I-17 returns the original inspection.
- **Print:** P-41 still has Proof 1 and Run 750 under Copies. P-42 has Run 250 under Impressions and a Trim row. Retrying P-41 adds no row.
- **School:** S-9 still has Guardian Jo and Emergency contact Sam. S-10 adds Pickup delegate and starts with empty contacts. Retrying S-9 returns the same enrolment under current access.

## Design gate

Quick CI covers the ADR at `33c665d62214545c5fa01146c956e57ac817ae42`. The packet and ledger are checked locally with `bash scripts/check-records.sh`. The executable proofs belong to slices 1–3.

CI tier: quick https://github.com/AnserBeg/2rain-greenfield/actions/runs/44956138996

Owner recommendations for the read are a library per company and exact matching for required templates, with a fresh preview after an assigning lead resolves a missing assignment. [Questions and reasons](../../decisions/ADR-XXXX-record-templates.md#owner-questions-for-the-design-read)
