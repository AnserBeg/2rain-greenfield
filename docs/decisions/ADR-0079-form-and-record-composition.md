# ADR-0079. Compose forms, record pages and actions, and brand the app

2026-11-19 · Accepted with the amendments from Fable’s independent read and the orchestrator’s ruling.

## Compose the page people already use

A buyer can add a **Delivery** section, move the required supplier input there, put an
optional note under **More details**, and move the lines and totals higher on the page.
The same controls work on a tenant’s Goods Receipt Inspection. Customize and the
plain-English drafter both propose edits to the release that owns the screen. The owner
sees the old and new layout, previews it, approves the exact candidate and activates it.
The renderer and assistant then read that release. This extends CUSTOMIZE-2’s form
disclosure and CUSTOMIZE-4’s generated editors. CUSTOMIZE-3’s list columns and saved
views keep their existing patch contract. [Plan §§8.5–8.6, 10.2, 10.6 and 12.2](../greenfield-north-star-erp-platform-plan.md)

### Slots and section identity

Each eligible surface publishes an inventory of the content it can arrange. It binds a
surface ID and mode (create, edit or detail) to declared slot IDs. Each slot declares its
permitted content kinds, stable section and block IDs, and default order. First-party
definitions and the tenant record generator supply the same inventory. A renderer-owned
heading such as **Details** acquires an explicit, persistent section ID before Customize
can offer it. The inventory derives from existing declarations on demand. For built-in
groups the identity is the tuple of surface ID, mode, slot and a permanent platform key.
Tenant-created sections use a reserved tenant-only ID namespace. Both kinds retain
identity through renames and moves. Labels, indexes and DOM selectors cannot identify
sections. Older first-party and tenant-generated packages acquire these base IDs in
Customize without a rewrite. Only an explicit layout revision emits the optional
Surface declaration and raises its reader floor. Listing an inventory changes no bytes.

Eligible first-party entities are the allowlist in customization’s `apply.ts`: item,
location, party, purchase order and sales order. Lines, receipts and posted documents
remain ineligible. Tenant record types use the same declared slots.

| Where the person is working | What the slot admits |
| --- | --- |
| Create or edit | Named sections of bound header inputs. The document editor and the ordinary form for the same mode consume the same header layout. Line entry, totals and save/post controls keep their declared bindings. |
| Record detail | Named field groups in the declared record body. A member identifies its selected, authorized query field. Within the existing sections/childTables region the inventory declares compatible positions for whole blocks such as lines with totals, or progression with its next step. |
| Actions | The Record’s declared action positions accept eligible commands. Posting commands can move among compatible visible positions, individually or with their next-step block. The platform owns the single primary action, its confirmation flow and compact placement. |

Customize can create or rename a section, change its order, set it to expanded, collapsed
or hidden, and place, reorder, relabel or hide a supported field. A field can move between
any two sections accepting its binding on that surface. An input keeps its field ID,
form owner, type, default, picker, validation and error anchor. A detail field keeps its
read binding. Role, company, server-supplied values and read-only results cannot become
writable through placement. Title/status, navigation, the activity rail and shell focus
landmarks retain their grammar. Block reordering stays inside the existing
sections/childTables region. The pinned Record anatomy and focus order stay untouched
on desktop and at 390 px. Within a section, visual and DOM field order agree. Editing uses ordinary labeled controls, including move up/down and
a destination section selector, so a keyboard user can make the same changes.

**Up front, collapsed and hidden have different effects.** Up-front fields appear on
arrival. A collapsed section keeps a labeled disclosure. Optional fields under **More
details** remain reachable in one expansion with their names in the summary. The compiler
refuses nested deferral. Hiding removes optional content from this surface’s presentation.
It neither clears a stored value on edit nor changes field permissions, search or exports.
The builder lists hidden items so the owner can restore them.

Validate the *effective* layout against the original operation inputs and protected
component bindings after all edits, including every ancestor and compact placement.
Every supported create or edit input has exactly one placement. Each required input
and each bound field in a published Tier B dependency set stays visible and editable on
arrival in both modes, including through its ancestors. These fields can move between
visible sections. The compiler refuses hiding or collapsing them individually or through
a parent. On detail, required readable values keep a visible placement. Required or action-demanding content cannot be
deferred. A section containing protected content may be renamed or moved. Hiding or
collapsing it requires first moving that content to an eligible visible position.
The lines table and its totals, the stepper and its next-step card, and eligible posting
actions must each remain present and visible whenever their original binding calls for
them. Move the paired blocks together to preserve their meaning. Refuse a duplicate,
omission, incompatible slot or indirect concealment before approval. Live state and grants
still determine which steps and commands apply. If an otherwise optional value resolves
to **blocked** or **attention**, reveal it to the authorized reader and name the layout
conflict. A form error likewise opens the affected section and focuses the error.
[Ledger spec §§5–6](../design/ledger-spec.md) · [UX grammar](../../.agents/skills/ux-grammar/SKILL.md)

## A button opens one governed Task

A custom button on a Record opens a short, server-rendered Task form, for example **Edit
delivery note**. Its declaration names the action, label, origin surface, and one target.
Buttons are secondary. Allow up to three active custom buttons per declared action
position on a surface. A destructive target belongs in overflow. Visibility comes only
from the target’s grants, guards and state. Pin its operation contract version.
Inputs have stable IDs and bind to typed arguments or writable field IDs. Each input
source is a discriminated union of user entry, record field or typed constant. Show every
record-sourced and constant value in the review with its source, including on an
otherwise direct Task. Neither source may bind a Tier B dependency-set field. A person
can enter a value for an otherwise writable field there. Use the existing
Task limit of twelve inputs. The compiler checks input types, required arguments, allowed
value sources and field/record scope. The server supplies actor, company context, current
record, revision and confirmation evidence. Tenant text is escaped wherever it appears.

| Target | What submitting the Task can do |
| --- | --- |
| Existing Semantic Operation | Invoke the one release-bound operation. Consequential operations retain their server-derived effects preview and explicit confirmation. Admit a binding only if the Task can present the target’s full required review. |
| Rule-checked update | Submit a typed patch to the target’s existing update operation. It checks the stored owner, expected revision, writable fields, validations and guards on the merged row. Only the owning capability computes or posts authoritative stock or money facts. |
| Workflow start | Admit only a released, manually startable definition with a WORKFLOW-1 start operation and verified input, scope and approval bindings. Until that contract ships, drafting or compiling this target returns a capability gap. Starting a run grants no approval to its later effects. |

Opening, closing and reopening have no business effect. Use ADR-0036’s native dialog with
`fallback: page`, visible Cancel, focus containment and return, and a compact bottom sheet.
The same Task works with JavaScript disabled. A button cannot declare risk, direct apply,
an approval token or new client behaviour. INTERACT-1 admits direct Task submission only
for an active ordinary O0 operation with `confirmation: none` and no required review.
Inherit any review attached to the target’s existing Task. The server shows the bound
operation, actual record and effects even if the owner gave the button a different name.
When review is required, the person confirms the exact prepared inputs. Edits
invalidate preparation. Any required independent approval must still be supplied by its
authorized approver. Recheck release, scope, current state, grants and approval at execution.
Retry uses the same idempotency key for the same prepared action and returns its receipt
and governed read-back. [ADR-0036 §2](ADR-0036-minimum-client-capability.md) · [INTERACT-1](../execution/packets/INTERACT-1.md) · [Workflow authority](ADR-0073-workflow-isolate-and-authority.md)

**Assistant context.** Resolve PANEL-2’s current surface and record against the pinned
release and current read and operation grants on each request. From the same compiled
layout used to render the page, expose permitted section and field IDs, labels, order
and disclosure, and each available button’s ID, typed inputs and target. A user can ask
“Where is Delivery note?” and get “Delivery → More details,” or ask what the button will
do. For a hidden field the reader may access, answer “not shown on this page”. Field access and operation discovery still follow current grants. Authorized Customize views may explain hidden placements. Navigation refreshes this context. A pending confirmation
stays bound to its original record, plan and digest. Acting uses the ordinary assistant
plan for the underlying target, with its actual risk classification. Only an eligible
`reversible` change with a verified inverse can run under the existing act-and-Undo rule.
`needsYes` requires the person’s decision. The action label cannot downgrade either
channel’s requirements. [PANEL-2](../execution/packets/PANEL-2.md) · [Plan §9.4](../greenfield-north-star-erp-platform-plan.md)

## One company brand for the shell and its documents

Approve a brand revision for a stable company ID within its tenant and environment. It
contains a trimmed plain-text display name of 1–80 Unicode code points, free of markup and control characters, an optional immutable logo asset version and digest, and a
versioned Ledger accent palette ID. The name is a presentation label. Business ownership,
the legal name and the company selector’s authorization keep their original sources.
Resolve the brand from the authorized working company, including on shared records. Use
the platform Ledger defaults when no company or brand applies. A company switch resolves
the new context before rendering.

The owner picks a colour scheme by palette ID. Choose from a platform palette, starting with Ledger teal and at least one distinct
approved alternative. A swatch supplies both themes’ `--accent`, `--accent-hover`,
`--on-accent`, `--accent-soft` and `--accent-text`. The renderer maps the ID to owned
styles. Refuse unknown IDs, CSS, URLs and markup in styling positions. A bounded palette
lets the platform test every combination. Check normal text at 4.5:1 and focus indicators
and meaningful control boundaries at 3:1 against their actual backgrounds in both themes,
including hover. Progress uses the accent. Success, attention and blocked keep their
distinct hues, labels and glyphs. In each theme run the hue-band gate against the rendered accent and these three roles. Test print text and marks on white and in greyscale. Every admitted palette version remains a permanent renderer obligation. [Ledger tokens](../design/ledger-spec.md) · [WCAG text contrast](https://www.w3.org/TR/WCAG22/#contrast-minimum) · [WCAG non-text contrast](https://www.w3.org/TR/WCAG22/#non-text-contrast)

Use DOCS-1’s scoped, scanned and sanitized PNG/JPEG asset version for the logo. Validate
scope and admission before activation and recheck access when serving the asset. The
logo uses a platform-owned plate token in both themes. The shell shows the company display name alongside the logo and falls back to that name if the asset is unavailable, quarantined or unauthorized. For a generated document,
resolve the issuing company through the template’s governed source under the same
pinned release as the data. A shared record needs a declared, authorized issuer binding
to generate a company-branded document. Pass the resolved name, checked bytes and print
colours from the light palette to DOCS-1’s renderer. Preview and generation must agree.
A configured asset that is missing, quarantined or unauthorized refuses generation.
Record the brand revision, logo digest and palette version with the document version.
Rebranding or rolling back affects future generation. Existing and signed versions retain
their exact bytes. Document branding ships with DOCS-1 templates. An out-of-process document generator must check the required brand reader floor before rendering. [DOCS-1 design](ADR-0078-governed-documents-files-templates-and-signatures.md)

## Patch history, replay and reader admission

Each of the following add-only kinds appends an immutable revision through draft, diff,
verification, approval and compare-and-swap activation. Require a `schemaVersion` on
every new payload, typed layout edit, input, input-source and target union member. Labels
are versioned text objects. The historical patch parsers and bytes keep their meaning.

| Kind | Payload and interpretation |
| --- | --- |
| `addLayoutRevision` | Surface ID, mode, versioned scope discriminator (initially `{kind: tenant}`), stable revision ID, predecessor, ordered typed edits and `resultLayoutDigest`. Create allocates a tenant section ID in a declared slot. Rename sets its label. Move/reorder identifies a field, section or compatible block, expected parent, destination and sibling anchor or edge. Disclosure tier (`always\|progressive`) and visibility (`shown\|hidden`) are independent properties. Retire-section removes an empty tenant-created section and preserves its ID against reuse. Reset-to-base relinquishes overrides on label, placement or disclosure so upstream changes flow through again. |
| `addPopupActionRevision` | Surface, actionId, revision, predecessor, status (`active\|retired`), label, slot, ordered inputs and exactly one typed, contract-versioned target. Retirement withdraws one button independently. Refuse collisions, broken predecessors, incomplete bindings and attempts to set policy. |
| `addCompanyBrandRevision` | Company and brand IDs, revision and predecessor, display name, logo reference or explicit absence, and palette reference. Refuse an invalid or cross-company reference. |

The first layout revision takes the effective `arrangeLayout` result as its base.
Afterwards refuse `arrangeLayout` on that surface, including through a linked header form
or document editor. The first result and every successor are computed atomically and
verified against the digest of the canonical effective result. On upgrade reproduce the
original result digest before applying the same edits to the new inventory. The owner
reviews a new result digest for an upgraded base with compatible additions.

Bind each patch digest to its immutable source lineage. For every touched member or
anchor, capture its source contract at draft time, including stable owner, slot,
section, relative position and binding type. Include the before-state of each edited
property. Section-wide edits capture affected membership and protection requirements.
Verify the expectations against the source, then against the upgraded base as each edit
is replayed. Earlier edits in an ordered patch or chain establish the input to later
ones. Revalidate each action target, input, company, asset or palette against its
recorded scope and contract. If an upgrade has moved **Delivery note** from **Details**
to **Shipping**, the ID still resolves but the expected parent fails. Return a typed
refusal distinguishing a moved member, retired target or changed contract, with the
affected IDs and expected and observed locations when permitted. Never match by label,
skip an edit or silently move a new field out of view. Unrelated compatible additions
keep their declared placement. A new optional field under a hidden or collapsed section
stays there and is listed in Customize. A new required field there returns a typed
conflict, as does any new protected input under concealment. Show the conflict in Customize and leave the verified
source release active until the owner reviews a fresh draft. Admit each kind to upgrade
replay only after reproducing its original release root. Pointer rollback uses the
verified compatible predecessor and restores its presentation. [ADR-0074](ADR-0074-formula-rule-and-workflow-projection-admission.md)

Use optional v6 declarations in the existing Surface family. Each implementation slice
raises the **mandatory surface-manifest reader floor** for releases declaring its feature.
Each declaring slice takes **the next rung above the implemented maximum at merge**.
Fetch main, regenerate the artifacts and tests, run CI and fetch again before pushing.
If the maximum moved, renumber and repeat. [ADR-0078, surface admission](ADR-0078-governed-documents-files-templates-and-signatures.md#customize-and-surface-admission)

The release floor is the maximum owed by its features. A serving binary claiming a rung
must implement every lower rung. Prove compatibility on mixed releases as well as layout
alone. Allocate a fresh rung each for pop-ups and branding, so even a layout-only
reader refuses those releases. Verify both directions between declarations,
compiled content, resolved consumer bindings and advertised requirements. Run the
actual preceding serving reader against each declaring release and observe refusal
before serving any request. Also prove missing bindings and understated floors refuse.

With the keys absent, reproduce normalized bytes, compiled envelopes, roots and existing
floors for first-party and real tenant-runner releases. Follow ADR-0047 for compiler
profile changes and return for a language ruling if v6 would require a key, materialize
a default or change the meaning of an existing node. Deployment must support at least
the newest patch parser and reader floors any tenant has used, including after a release
pointer rollback. [ADR-0047 §7](ADR-0047-the-compiler-semantic-profile-is-the-projection-evolution-axis.md) · [ADR-0074](ADR-0074-formula-rule-and-workflow-projection-admission.md)

## Implementation checkpoints

1. **1a · Layout inventory and editing.** On a purchase order and a tenant record type,
   create, move, rename and reorder sections and fields in create, edit and detail.
   Check persistent IDs, original input bindings, paired block positions, replay of
   the first revision and byte reproduction on real releases without the declaration.
2. **1b · Visibility, upgrades and assistant.** Add hide and collapse, check protected
   inputs and blocks in both widths, restore a saved value, exercise moved/retired
   field and changed-contract refusals, guided re-draft and the assistant’s field location.
3. **Shell branding and pop-ups** may land in either order. Check palette, name and logo
   fallback across companies, themes and compact screens. For pop-ups, exercise the
   rule-checked update, a consequential operation, review, approval and idempotent retry.
   Ship eligible targets while workflow start awaits WORKFLOW-1.
4. **Document branding** lands with DOCS-1 templates. Check print and greyscale, generate
   under two brand revisions, and verify the first document’s original bytes.
