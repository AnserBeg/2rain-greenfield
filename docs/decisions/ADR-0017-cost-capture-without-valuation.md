# ADR-0017: Cost capture without valuation authority

Date: 2026-07-26
Status: accepted (orchestrator ruling, user-authorized 2026-07-26; the capture obligation is
implemented by the G4 purchasing/receiving stage, and valuation itself remains N3)
Tier: Behavioral (review per `review-tiers` when implemented)

## Context

Plan §2.3 excludes valuation, landed cost, and revenue recognition from launch, and §12.6
schedules "landed-cost inputs and valuation interfaces" at N3. That sequencing is right:
valuation is adjacent to accounting, and doctrine forbids inventory prices quietly becoming
financial truth (plan §16, "scope creep into accounting").

But "we do not compute stock value" and "we do not retain the inputs to stock value" are
different decisions, and only the first one was made.

Every perpetual valuation method — FIFO, weighted average, standard with variance — needs
the **actual cost at which each receipt entered stock**. If a goods receipt posts without
capturing it, that number is gone. The purchase-order price is not a substitute: it is the
agreed price, not the received one, and they differ through partial receipts, substitutions,
price corrections, and supplier credits.

The consequence is the one failure the plan's own doctrine most wants to avoid. "What is my
stock worth" is among the first questions a business owner asks. If the system cannot answer
it, the answer gets built in a spreadsheet, and the spreadsheet becomes a peer source of
truth — which is precisely what doctrine #4 exists to prevent and what the prior-art audit
calls **E4, the spreadsheet shadow system**. The audit treats E4 as unaddressable in general;
this ADR closes the specific instance the plan itself creates.

Recorded as **G3** in [`prior-art-failure-modes.md`](../execution/prior-art-failure-modes.md).

## Decision

**Capture the inputs. Compute nothing.**

### Goods receipt lines capture actual received cost

`goods_receipt_line` carries the unit cost and currency at which the quantity was actually
received, as an immutable operational fact recorded at posting time, alongside the existing
quantity.

Where the cost is genuinely unknown at posting, it is recorded as **explicitly absent** —
a declared absent state, never zero and never null-as-unknown. A gap in cost coverage is
then a queryable fact with an exact row list, not a silent valuation of zero. This follows
the same fail-visible discipline as ADR-0016's `unspecified` member.

### Movements do not carry value

A posted `inventory_movement` carries quantity, never amount.

Movements already carry stable source-document, source-line, and effect identity
(ADR-0007). Cost therefore lives at the receipt, reachable from any movement by the lineage
the ledger already guarantees. Putting an amount on the movement would create a second
place for cost to be wrong and would make the ledger look like a subledger it is not.

FIFO layers, weighted averages, and standard-cost variances are all derivable at N3 from
receipt history plus movement lineage. Discarding the receipt cost is the only step that
cannot be undone later, and it is the only step this ADR forbids.

### Valuation is unsupported and fails closed

There is no `inventory.value` read model, no valued balance, no costed movement report, and
no agent answer to "what is my stock worth" at launch. The capability resolves to
`unsupported` with its required capability named, per plan §5.5, and the agent surfaces it
as a first-class capability gap rather than approximating it.

Captured cost is an **operational fact**, not accounting truth. It creates no ledger entry,
no accrual, and no posting intent. Plan §6.4 invariant 13 is unchanged and now has something
concrete to bind.

## Consequences

- N3 valuation becomes a derivation over retained history instead of a project that starts
  by admitting the history is unusable.
- Launch cost is one nullable-with-declared-absence column pair on one child entity, plus a
  capability-gap disclosure. No new authority, no new read model, no accounting surface.
- The absent-cost state is deliberately visible. A tenant that never records costs gets an
  honest, exact report of that, and N3 valuation can tell them precisely what it cannot
  value and why.
- The obligation sits at G4, not G3, because goods receipt is a G4 entity. G3 must not
  invent a costed movement in the meantime — that is what "movements do not carry value"
  forbids.
- This ADR deliberately does not decide the valuation *method*. Method selection is an N3
  capability decision with its own support cells; retaining the inputs is method-neutral.

## Evidence

- Plan §2.3 launch exclusions, §6.2 launch entity catalog, §6.4 invariant 13, §12.6 N3
  landed-cost and valuation interfaces, §16 scope-creep-into-accounting risk row.
- ADR-0007: movement source-document and source-line identity, which is the lineage this
  decision relies on instead of a value column.
- [`prior-art-failure-modes.md`](../execution/prior-art-failure-modes.md) **E4** and **G3**.

## Enforcement

- Compiler: a compiled projection that derives a monetary amount from `inventory_movement`
  fails closed. `inventory.value` and costed-balance query IDs resolve to `unsupported`
  with a named required capability.
- Provider: receipt-line cost is immutable after posting, like every other posted fact.
- Structural test: no movement-sourced money field exists in any compiled artifact — the
  executable form of "movements do not carry value."
- G4 gate: posting a goods receipt records actual unit cost or an explicit absence, and the
  absence report returns an exact row list.
