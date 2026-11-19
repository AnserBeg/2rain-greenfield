# ADR-0079. Compose forms, record pages and actions, and brand the app

2026-11-19 · Proposed for the orchestrator’s Fable read. Implementation starts after its ruling.

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
can offer it. A label, array index or DOM selector cannot identify an editable section.

| Where the person is working | What the slot admits |
| --- | --- |
| Create or edit | Named sections of bound header inputs. The document editor and the ordinary form for the same mode consume the same header layout. Line entry, totals and save/post controls keep their declared bindings. |
| Record detail | Named field groups in the declared record body. A member identifies its selected, authorized query field. The body also declares compatible positions for whole blocks such as lines with totals, or progression with its next step. |
| Actions | The Record’s declared action positions accept eligible commands. Posting commands can move among compatible visible positions, individually or with their next-step block. The platform owns the single primary action, its confirmation flow and compact placement. |

Customize can create or rename a section, change its order, set it to expanded, collapsed
or hidden, and place, reorder, relabel or hide a supported field. A field can move between
any two sections accepting its binding on that surface. An input keeps its field ID,
form owner, type, default, picker, validation and error anchor. A detail field keeps its
read binding. Role, company, server-supplied values and read-only results cannot become
writable through placement. Title/status, navigation, the activity rail and shell focus
landmarks retain their grammar. Reading and tab order follow the resulting structure on
desktop and at 390 px. Editing uses ordinary labeled controls, including move up/down and
a destination section selector, so a keyboard user can make the same changes.

**Up front, collapsed and hidden have different effects.** Up-front fields appear on
arrival. A collapsed section keeps a labeled disclosure. Optional fields under **More
details** remain reachable in one expansion with their names in the summary. The compiler
refuses nested deferral. Hiding removes optional content from this surface’s presentation.
It neither clears a stored value on edit nor changes field permissions, search or exports.
The builder lists hidden items so the owner can restore them.

Validate the *effective* layout against the original operation inputs and protected
component bindings after all edits, including every ancestor and compact placement.
Every required create input occurs exactly once, visible and editable on
arrival, wherever the owner moved it. Required or action-demanding content cannot be
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
Inputs have stable IDs and bind to typed arguments or writable field IDs. Use the existing
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
do. Hidden fields are absent from ordinary screen discovery. Authorized Customize views
may explain hidden placements. Navigation refreshes this context. A pending confirmation
stays bound to its original record, plan and digest. Acting uses the ordinary assistant
plan for the underlying target, with its actual risk classification. Only an eligible
`reversible` change with a verified inverse can run under the existing act-and-Undo rule.
`needsYes` requires the person’s decision. The action label cannot downgrade either
channel’s requirements. [PANEL-2](../execution/packets/PANEL-2.md) · [Plan §9.4](../greenfield-north-star-erp-platform-plan.md)

## One company brand for the shell and its documents

Approve a brand revision for a stable company ID within its tenant and environment. It
contains a plain display name, an optional immutable logo asset version and digest, and a
versioned Ledger accent palette ID. The name is a presentation label. Business ownership,
the legal name and the company selector’s authorization keep their original sources.
Resolve the brand from the authorized working company, including on shared records. Use
the platform Ledger defaults when no company or brand applies. A company switch resolves
the new context before rendering.

Choose from a platform palette, starting with Ledger teal and at least one distinct
approved alternative. A swatch supplies both themes’ `--accent`, `--accent-hover`,
`--on-accent`, `--accent-soft` and `--accent-text`. The renderer maps the ID to owned
styles. Refuse unknown IDs, CSS, URLs and markup in styling positions. A bounded palette
lets the platform test every combination. Check normal text at 4.5:1 and focus indicators
and meaningful control boundaries at 3:1 against their actual backgrounds in both themes,
including hover. Progress uses the accent. Success, attention and blocked keep their
distinct hues, labels and glyphs. [Ledger tokens](../design/ledger-spec.md) · [WCAG text contrast](https://www.w3.org/TR/WCAG22/#contrast-minimum) · [WCAG non-text contrast](https://www.w3.org/TR/WCAG22/#non-text-contrast)

Use DOCS-1’s scoped, scanned and sanitized PNG/JPEG asset version for the logo. Validate
scope and admission before activation and recheck access when serving the asset. The
company display name remains visible alongside the logo. For a generated document,
resolve the issuing company from its governed record under the same
pinned release as the template and data. Pass the resolved name, checked bytes and print
colours from the light palette to DOCS-1’s renderer. Preview and generation must agree.
A configured asset that is missing, quarantined or unauthorized refuses generation.
Record the brand revision, logo digest and palette version with the document version.
Rebranding or rolling back affects future generation. Existing and signed versions retain
their exact bytes. Document branding ships with the DOCS-1 generation binding. [DOCS-1 design](ADR-0078-governed-documents-files-templates-and-signatures.md)

## Patch history, replay and reader admission

Add three closed, versioned patch kinds. Each adds an immutable declaration or revision
to a new package revision through the existing draft, diff, verify, approve and
compare-and-swap activation path. Stable IDs are allocated once, including for tenant
sections, and survive label changes. Preserve the meaning and historical bytes of
`arrangeLayout`, `addField` and `changeSet`.

| Kind | Payload and interpretation |
| --- | --- |
| `addLayoutRevision` | Surface ID, mode, revision ID, predecessor and an ordered list of typed edits. Create names a fresh section ID in a slot. Rename and disclosure name an existing section or field. Move names the field, section or block, its expected source, destination and sibling anchor (or start/end). Apply the list atomically to the prior effective layout. |
| `addPopupAction` | Fresh action ID, origin surface and action slot, label, ordered input IDs and exactly one typed target binding. Refuse ID collisions, incomplete inputs, unavailable contracts and attempts to set policy. |
| `addCompanyBrandRevision` | Company and brand IDs, revision and predecessor, display name, logo reference or explicit absence, and palette reference. Refuse an invalid or cross-company reference. |

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
keep their declared placement. Show the conflict in Customize and leave the verified
source release active until the owner reviews a fresh draft. Admit each kind to upgrade
replay only after reproducing its original release root. Pointer rollback uses the
verified compatible predecessor and restores its presentation. [ADR-0074](ADR-0074-formula-rule-and-workflow-projection-admission.md)

Use optional v6 declarations in the existing Surface family. The compiler raises the
**mandatory surface-manifest reader floor to 29** for the first layout-bearing release.
Main serves through 26, WORKFLOW-1 reserves 27 and DOCS-1 reserves 28. The release floor
is the maximum owed by its features. Since the current reader advertises a scalar
maximum, a binary claiming 29 must also honor or explicitly refuse every unsupported
lower-rung feature before serving. Prove this on mixed releases as well as layout alone.
Allocate the next free higher floor when pop-ups and then branding ship, so even a
layout-only reader refuses those releases. Verify both directions between declarations,
compiled content, resolved consumer bindings and advertised requirements. Run the
actual preceding serving reader against each declaring release and observe refusal
before serving any request. Also prove missing bindings and understated floors refuse.

With the keys absent, reproduce normalized bytes, compiled envelopes, roots and existing
floors for first-party and real tenant-runner releases. Follow ADR-0047 for compiler
profile changes and return for a language ruling if v6 would require a key, materialize
a default or change the meaning of an existing node. Deployment must support at least
the newest patch parser and reader floors any tenant has used, including after a release
pointer rollback. [ADR-0047 §7](ADR-0047-the-compiler-semantic-profile-is-the-projection-evolution-axis.md) · [ADR-0074](ADR-0074-formula-rule-and-workflow-projection-admission.md)

## Slices after approval

1. **Layout.** Rearrange create, edit and detail on a purchase order and a tenant record.
   Check required inputs and protected blocks in the rendered page at both widths, a
   saved value after hiding and restoring it, the assistant’s field location, rollback,
   and upgrade refusals with the same ID moved and with the field retired.
2. **Pop-up actions.** Try a rule-checked note update and a consequential operation.
   Exercise page fallback, assistant risk, stale or missing approval and idempotent retry.
   Observe the actual write count, receipt and authorized read-back. Prove an unavailable
   workflow start is refused until WORKFLOW-1 admits it.
3. **Branding.** Switch between two companies and both themes. Check logo, displayed name,
   rendered contrast and status colours. Generate a DOCS-1 PDF, change the brand and
   generate another. Verify the new branding and the first version’s original digest.
