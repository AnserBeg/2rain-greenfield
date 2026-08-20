# stock-balance-read-model — posted-stock projection stop record

Status: blocked before product edits by the packet's compiler stop condition
Base: `8136cfaa8caf23a73221cfa2b0feb5c90987556b`
Branch: `packet/stock-balance-read-model`
Tier forecast: Behavioral in authored behavior; Critical in its correctness gates

## Intended outcome

Add an ordinary browsable read-model entity for **posted stock** while preserving
the five-parameter `inventory_movement_on_hand` lookup as the precise bitemporal
answer. The read model would answer only “the sum of all posted movements.” It
would not claim an as-of instant.

The row decision is retained from the prior stopped lane: one row is one item at
one location inside the explicitly selected legal entity. Summing locations would
answer a different question and would discard the stock identity fixed by
ADR-0015 and ADR-0016.

The honest canonical family name is `posted_stock_balance`, and the operator label
is `Posted stock`. Calling it `on_hand`, or leaving “posted” out of the canonical
name, would imply temporal semantics the projection does not have.

## Renderer decision — clear

The existing ordinary List archetype can render the read model through its
registered `title` and `dataGrid` slots over a normal row query. No
`apps/web/src/**` or component-registry change is required. The renderer stop did
not fire.

## Stop — the new family is not admitted

The program review's R6 correctly identified ADR-0007's projection mechanism,
but its inference from `inventory_movement` was incomplete. That entity is not
only operationless; its family is already explicitly registered in both halves
of the pinned legal-entity contract.

`posted_stock_balance` is not registered. The production compiler resolves an
unknown family in the governed Inventory package to `status: 'undeclared'`, and
the conformance pass emits `INVENTORY_LEGAL_ENTITY_FAMILY_UNDECLARED`. The same
closed list is also the domain-side attestation reproduced by compiler contract
tests.

Observed without modifying the packet tree (the source files are byte-identical
between checkout `6bce9d7` and packet base `8136cfa`):

```text
SOURCES_IDENTICAL_6BCE_TO_BASE
{
  "resolution": {
    "familyId": "posted_stock_balance",
    "status": "undeclared"
  },
  "declared": false
}
```

The observation invoked `resolvePinnedLegalEntityFamily` for
`northstar.inventory:package.inventory` and
`northstar.inventory:entity.posted_stock_balance`, then independently tested
membership in `LEGAL_ENTITY_FAMILY_MAP_V1`.

An honest implementation therefore needs both:

- `packages/domain/src/inventory/contracts.ts` — admit
  `posted_stock_balance` as `entityOwned` in the authoritative domain map; and
- `packages/compiler/src/conformance.ts` — admit the same family in the compiler's
  pinned copy so the new entity receives the derived legal-entity column and can
  compile.

Neither path is owned. More importantly, `packages/compiler/src/**` is an
explicit stop condition in this packet. No workaround is admissible:

- reusing `reservation` would lie in the entity name and violate the packet's
  honesty condition;
- making the projection tenant-shared would lose the legal-entity member of the
  stock identity; and
- adding an authored `legal_entity_id` field would create a second authority in
  place of the compiler-derived system column.

No domain definition, provider, release artifact, test, ADR, compiler, posting
service, or web source was changed after this stop was found.

## Provenance gap in the prior stop

The requested prior record
`docs/execution/packets/stock-on-hand-browsable.md` is absent from the named
branch tip `ca6fe310cb10da883a009525dab6b3fb9f8a872c`, absent from its clean
worktree, and absent from that branch's one-entry reflog. Its grouped-language
findings survive in `docs/execution/current-plan.md` and R6; this record does not
invent a missing file or claim to have read it.

## Stop count and required re-scope

This is stop 1 for the re-chartered packet and stop 2 for the browsable-balance
chain. Do not issue a third continuation under the same charter. The next
selected packet must pre-authorize the two pinned-contract paths above (plus their
contract tests) or split that registration into a preceding bounded packet. It
remains a contract-registration change, not the grouped-aggregate language cut
that the prior lane correctly ruled out.

No candidate was frozen, no blast-radius gate was claimed, and no review prompt
is owed for this stopped record.
