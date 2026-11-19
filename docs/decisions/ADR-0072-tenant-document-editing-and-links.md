# ADR-0072. Tenant document editing and links

Accepted by the orchestrator on 2026-11-18 for CUSTOMIZE-4.

An office worker needs one document form with a header, linked records and
owned lines. A document can be shared across companies or owned by one
company. It can have a lifecycle or admit ordinary edits throughout its life.
These are surface capabilities over existing Tier A operations and queries.

The additive v6 editor declaration can name create-only `headerRelations`.
Each input names an active relation of the header and the target's declared
List and exact get. The picker reuses the existing reference interaction and
the first save sends selected IDs in the pinned create operation's `relations`
argument. A rendered List can name that same relation in a column and use the
existing exact relation restriction and label join for filtering and search.
The detail page resolves labels and navigation under the target's read policy.

The editor's state field and editable state IDs can be omitted together for
a record without a lifecycle. A shared header and its shared lines use
unscoped requests. Company-owned requests carry an explicit company, and the
compiler and provider enforce company ownership on relations. The same
sequential save plan creates the header before writing its child rows and
reports a partial save. Archive refuses a parent with active owned lines.

Surface capability floor 24 applies when an editor uses header relations, a
shared header or a lifecycle-less header, or a List declares a relation column.
Floor-23 releases preserve their bytes and their behaviour. A reader capped
at 23 refuses a release declaring floor 24. The authored change uses the
optional-key rule in ADR-0047 §7. The ADR-0066 re-baseline of the first-party
app produces the existing release byte for byte.

This extends the request-time surface contract under plan §5.11 without a new
query or operation primitive. Tenant writes remain on the tenant's own
record and its owned lines. Quarantine and release are changes to the
Inspection record's state. Receiving event composition is a separate packet.
