# ADR-XXXX. Apply a versioned template when creating a record

Proposed for the TEMPLATE-1 design read, 2026-11-21. Assign the ADR number at merge.

A safety lead can already define an Inspection with a table of results. The lead also needs to write the questions for a particular equipment class. If the lead changes “Does the brake hold?” next week, a supervisor reopening Monday’s inspection must see the question the mechanic actually answered. A print shop needs the same guarantee for job instructions, and a school for the roles on a pupil’s contact form. [CUSTOMIZE-4](../execution/packets/CUSTOMIZE-4.md) · [Plan §§10.5–10.6](../greenfield-north-star-erp-platform-plan.md)

## Proposed decisions

### 1. Release the record structure. Let office workers publish the content.

In Customize, the owner enables templates for a declared place on a company-owned record, such as its results table. The binding identifies the record type, owned collection, writable fields and relations, allowed answer types, context selector and creation operation by stable ID and contract. It also says whether a template is required. The same binding serves the Record, the assistant and the operation gateway. Use ADR-0079’s existing sections and child tables. [ADR-0079](ADR-0079-form-and-record-composition.md)

An authorized author opens **Templates**, drafts an ordered set, previews it on the bound record and publishes a numbered revision. They can start with the declared columns and explicitly chosen starting values from a grid they may read. Show exactly what will become a reusable default. A field must be declared eligible for copying and for disclosure to the template’s audience. Copying a finished job wholesale risks publishing a customer’s entries to colleagues. Answer-only fields always start empty. Editing published content starts a successor draft with an expected predecessor. A competing publish must reload the winning revision. Retiring a template closes it to new applications and retains its revisions.

| What the author saves | How the record uses it |
| --- | --- |
| Ordered question or instruction, help text, answer field and permitted choices | One identifiable item, with the question and an empty typed answer or an instruction to read |
| Named role or section | A labelled group with its own membership and declared contact fields or links |
| Ordered column captions and typed field bindings, followed by starting rows | A grid with the selected columns in order and fresh editable rows |
| Member reference and suggested count | A proposed kit line on the new record. Stock movement, custody, reservation and billing each need their own authorized operation. |

Every revision has its own identity under a stable template ID. Members have stable keys independent of their label and position. Retain keys through renames and moves, allocate new keys for different meanings and never recycle removed keys. Constrain copies to declared, bounded literals, choices or scoped reference IDs. Publishing checks the entire set, including types, targets, duplicate keys, required starting fields and the declared size limits. Exclude protected fields and authoritative Tier B inputs and outputs from defaults. A template author can select among admitted types. Adding a new field type, widening access or installing a new operation requires a release. [Plan §10.6](../greenfield-north-star-erp-platform-plan.md)

**Reason.** Staff change the ten questions far more often than the shape of a result row. A release per question set would turn a weekly content edit into a schema deployment. A free-form JSON or script field would lose typed inputs, permission checks and discoverability.

### 2. Assign a published revision to one exact context.

The assignment key includes tenant, environment, owning company, record type, template binding and context value. The binding selects one declared choice or one scoped record link, for example a job class. A binding for the whole type uses one explicit whole-type key. Use the validated value on the proposed record or the stored linked record identified by the binding. The server resolves and locks that context. A caller-supplied company label or suggested template ID has no authority.

One assignment at a key points to one published revision. Show the revision and context in the creation preview. Replacing that assignment requires its expected version and takes effect for subsequent creates. Publishing a successor alone leaves the previous assignment in force. A changed assignment between preview and first save requires a fresh preview. An unassigned optional section starts empty. A required section with no assignment refuses creation and identifies the section to an authorized editor. An existing assignment that is inaccessible, retired, incompatible or ambiguous refuses creation even for an optional section. Existing records retain their original application through reassignment or reclassification.

**Reason.** An inspector and a scheduler starting like records in the same company must be able to explain the choice. Selecting “latest,” matching by display name or taking the first of several inherited matches could give them different questions.

### 3. Give each record its own rows and keep what each answer meant.

At first save record the parent and binding IDs, assignment version, template and revision IDs and the immutable content digest. Generate fresh IDs for owned groups and rows. Keep their source member keys and original order. The pinned revision preserves authored captions, question wording, option meanings, instructions and starting values. The record owns its answers, actual contact links and edited counts. Its page reads those values alongside the pinned definition. Reference labels and access to a linked person still come through the current governed read. Ordinary answer edits use the record’s revision checks and audit trail.

Source identity and the original checklist membership are server-owned. A user cannot erase a required question by deleting its seeded row through the ordinary child editor. Where the binding admits extra work rows or contacts, give additions fresh IDs and distinguish them from template defaults. Archiving a parent, role or template retains provenance. Existing records created before templates keep their ordinary data and have no application. Changing a record’s context, restoring an earlier assignment or publishing a later revision never migrates answers.

**Reason.** A live join to the active template would change the meaning of an old answer. A detached copy would preserve the text but lose which approved revision supplied it.

### 4. Separate permission to publish, assign, apply and answer.

Scope the library and its operations to the company in the authenticated tenant and environment. Grant drafting/publishing and assigning explicitly. Applying requires the apply write grant, read access to the assigned revision and context, target create authority and permission for every seeded field, child write and referenced record. An inspector with apply access can start an inspection without gaining permission to change next week’s checklist. Editing an answer later needs the record’s ordinary scoped write permission. Govern preview, template history, instance reads and linked contact details with current read permissions. Offer only authorized actions and recheck at execution, including when the assistant calls the operation.

Resolve company, binding, published status, stored owners, effective grants and active release fence on the server. Bind any reviewed decision to its exact digest and fence, including after switching away and back. Use scoped readers and narrow database writers with a fixed trusted search path. Give the runtime role no direct table grants. Audit publication, assignment, application and answer edits with actor, scope, revision and record identity as applicable. Withheld read-back reveals no prior answers or other company’s template name.

**Reason.** Anyone who can answer a question need not be able to change the questions for all colleagues. Copying the author’s privileges into a template, or treating a read grant as permission to apply, would let a default write a value the caller could never enter.

### 5. Apply once, in the transaction that creates the record.

The normal create path for a bound type enforces template resolution for every caller, including imports and the assistant. A single governed operation writes the header, pinned application, seeded rows, receipt and audit evidence atomically. Apply each binding at most once per parent. A failure in any seeded row rolls the whole creation back. Later manual edits follow the ordinary document editor’s save contract. [ADR-0072](ADR-0072-tenant-document-editing-and-links.md)

Keep a stable create request key from preview through retry. Bind the receipt to the authenticated caller, scope, operation, key and digest of the original create inputs and reviewed selection. Concurrent identical submissions converge on one receipt. On a committed retry, check current authority and the original digest before looking for today’s assignment. Return the original record and revision with governed read-back. Reusing the key with changed inputs refuses. A fresh create key represents another record. Reapplying to an existing record, even with a new key, refuses. After a rolled-back attempt a retry may create only if its original preview is still valid.

Reassignment, retirement, creation and archive must serialize on the same stored identities. Use one lock order for all of them, including simultaneous first assignments to an empty key. Acquire the release fence, then the scoped request and assignment identities in stable order before the affected record locks. Respect the existing descendant-before-ancestor record lock order. Re-read versions, scope and liveness after lock waits. Writers relying on READ COMMITTED check that isolation level on entry. Use storage uniqueness for the receipt and for the parent/binding pair. Use distinct namespaces for system-created member identities and user additions.

**Reason.** A lost response should cost a retry, never a second checklist. A browser loop that first saves the header and later copies defaults could leave an inspection looking complete with half its questions missing.

### 6. Keep release decisions with the business that owns them.

The template can carry a question’s allowed answers, whether an answer is required for completion, whether “N/A” is allowed, and when a failure needs a note. Preserve these choices in the applied revision. Draft inspections can be incomplete. Use ordinary typed validations for admitted same-row or to-one checks. A safety business can additionally mark a failure as blocking its **Release** action. That transition must check the full set of required members from the pinned revision and their stored answers under the same lock as release. An unanswered or missing required item, a disallowed N/A, a missing required note or a blocking failure must keep the record from being released. A direct operation call owes the same checks as the form.

ADR-0076 admits no to-many check across owned lines. Until the lifecycle consumer has an admitted general guard that checks the pinned set atomically against answer edits, report that missing guard and keep the guarded Release action unavailable. TEMPLATE-1 can prove recording a failed check and its note independently of shipping that transition. Other applications choose their own completion policies. [ADR-0076](ADR-0076-cross-field-and-to-one-validation.md) · [Plan §10.4](../greenfield-north-star-erp-platform-plan.md)

**Reason.** A printer can proceed with an unfinished work request where a failed safety check must stop release. A built-in inspection rule would impose one business’s policy on everyone. A display-only warning could allow release through a different caller.

### 7. Upgrade the binding without rewriting template history.

Persist the author’s binding choices by stable ID and pinned contract. Bind the exact choices digest on the authoring base. During upgrade check the required structure and name the affected ID on conflict. Retired customization revisions skip active-member validation. Keep the author’s business text in the immutable content revision. Labels supplied by a released field can evolve independently of that text. Check active assignments for compatibility before enabling a changed binding. Retain a readable interpretation of used revisions under current permissions, including after pointer rollback. If a change would strand existing answers or silently change their type, refuse it and keep the verified source serving. [ADR-0085](ADR-0085-platform-upgrades-for-customized-tenants.md)

The proposed Customize member ships with a schema-generated description, in-app AI drafting, fail-closed patch-kind coverage and live module-building evals. Prove that adding a field, arranging a List and replaying a label edit work with the member active and again after retirement. Omission must preserve persisted definition and projection bytes, roots and floors on both first-party and tenant releases. Assign migration numbers and any required parser/reader rungs at their executable merge. Test the actual preceding serving binary through query dispatch on a featureless release and named refusal on a declaring release. Keep the deployment high-water floor after rollback. [ADR-0090](ADR-0090-check-release-capabilities-before-boot.md)

**Reason.** Rebuilding old revisions from the current layout would make an unrelated rename break publication or historical reads. Letting an older reader ignore a binding could let it create records without their mandatory questions.

## Three acceptance walkthroughs

These are proposed tests for the executable slices. For each, create through the normal form, retry the same submission after revision 2 is assigned, then reopen both records under current permissions.

| Business and authorized worker | First record under revision 1 | Change the assignment and create a second record | What reopening and retry must show |
| --- | --- | --- | --- |
| Equipment safety. A safety lead publishes and assigns **After repair** to the Lift class. A mechanic may apply and answer. | On inspection I-17, answer **Does the brake hold? → Fail**, add **Slips under load**, and mark the optional cab light **N/A**. The brake requires a note and disallows N/A. | Revision 2 adds **Is the guard fitted?** above the brake. Assign it, open I-18 and answer the new question **Yes**. | I-17 still shows revision 1, the original order, Fail, note and N/A. I-18 shows revision 2 with its own brake answer blank. Retry I-17’s create returns I-17. A viewer cannot apply. The guarded Release test is separate under decision 6. |
| Print shop. A production lead saves a standard grid and assigns it to Booklet jobs. A coordinator may apply and edit the grid. | Ticket P-41 starts with **Step / Copies**, rows **Proof / 1** and **Run / 500**. Change Run to **750**. | Revision 2 renames Copies to **Impressions**, puts Run first, changes its default to **250** and adds **Trim**. Assign it and open P-42. | P-41 still says Copies and reads Proof 1, Run 750. P-42 shows Impressions, Run 250 and Trim. Retry returns P-41 with two rows and 750. A coordinator cannot publish over the lead’s template. |
| School. The registrar assigns contact roles to Primary enrolments. An enrolment clerk may apply and choose readable contacts. | For pupil S-9 choose **Jo** as Guardian and **Sam** as Emergency contact, in two named sections. | Revision 2 renames Guardian to **Parent or carer**, adds **Pickup delegate** and puts that role first. Assign it and enrol S-10. | S-9 still lists Guardian/Jo and Emergency contact/Sam under revision 1. S-10 shows the revision 2 roles with empty contact fields. Retry returns S-9. A clerk scoped to another school company in the same tenant cannot apply or discover these contacts. |

## Slice plan

0. **Design read.** Review these contracts, the three before/after examples and the owner choices below.
1. **Publish and assign.** In Customize enable a template binding, then have an office worker preview, publish and assign revision 1. Prove concurrent publication, invalid defaults, permission checks, archived-reader admission and AI drafting.
2. **Start and answer an inspection.** Create I-17, record the failure, reassign and create I-18. Prove atomic rollback, a lost-response retry, simultaneous creates with one key, stale selection, scope denial and preservation of the old answers. Exercise the guarded-action boundary in decision 6.
3. **Use the same capability beyond questions.** Build P-41/P-42 and S-9/S-10 through tenant declarations and the same operations. Reopen them after reassignment and retirement, check independent rows and contacts, and repeat with an unauthorized caller. Include an instruction or proposed kit line as ordinary typed content.

## Owner questions for the design read

1. **Should staff in two companies share a template library at launch?** Recommend one library per company. A school’s contact configuration and an equipment firm’s checklist can each have a clear owner. Cross-company distribution would need a separately authorized publication and assignment model.
2. **May staff override a required assignment when starting a record?** Recommend enforcing the exact assignment. If it is missing, the assigning lead resolves it and the worker previews again. Optional bindings can start empty. This makes the selected checklist explainable after a safety incident.

The [generality audit, Part B](/home/rvham/2rain-missions/generality-audit.astra.result.md) attributes the reusable content to A16, A18, A24, A27, B3, C6, C8, C9, F2, F4, F6 and F9. The survey distinguishes per-record contacts from profile roles, starting grid rows from finished work, and proposed kit members from stock movements. [Survey inventory, sections A–C and concrete examples](/home/rvham/2rain-missions/rain-survey/inventory.md)
