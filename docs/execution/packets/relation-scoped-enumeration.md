# relation-scoped-enumeration — scoped relation picker

Date: 2026-08-16
Base: `d6e31024d81e4ed6fe9ef19b1a86673b28d4fbe0`
Branch: `packet/relation-scoped-enumeration`
Tier: Critical
Status: **STOP 1 — the shipped required-relation forms are not writable surfaces**

## Packet definition

Goal: make every required create relation a server-rendered record picker,
including legal-entity-scoped targets and the two-relation
`stock_count_line_form`; unify the browser and gateway on one complete pinned
operation-catalog authority; name relation enumeration refusals; and disclose
the create-only relation freeze.

Owned paths and pre-authorized bridges are recorded in
`docs/execution/lanes.md` at the branch's first commit, `14c97f5`. Compiler and
release-output changes are explicitly outside the lease and are a stop
condition.

## Measurements before implementation

The branch was cut from current `origin/main`; fetching `origin/main` returned
the named base exactly, so the prompt's base had not moved.

The recorded artifact confirms the packet's relation premise:

- compiler-semantic profile `v2`, lineage length 10;
- six relation inputs, all six carrying `targetEntityId`;
- four form surfaces with required relations;
- `party_role_form` targets the unscoped `party_list`;
- `inventory_transaction_line_form`, `stock_count_form`, and both relations on
  `stock_count_line_form` target legal-entity-scoped lists;
- each required target entity has exactly one active list query.

The same artifact refutes the queue's claim that relation enumeration is the
last executable blocker. Every one of those four form surfaces has this slot
shape:

| Surface | Compiled slots | Required relation targets |
|---|---|---|
| `party_role_form` | `breadcrumb`, `titleStatus`, `activity` | `party` |
| `inventory_transaction_line_form` | `breadcrumb`, `titleStatus`, `activity` | `inventory_transaction` |
| `stock_count_form` | `breadcrumb`, `titleStatus`, `activity` | `inventory_transaction` |
| `stock_count_line_form` | `breadcrumb`, `titleStatus`, `activity` | `stock_count`, `inventory_transaction_line` |

`apps/web/src/component-registry.ts` registers form mutation rendering only at
`record:sections`. It does not register `record:activity`.
`surfaceSupportsRuntimeIntent` refuses any surface with an unsupported
component and any surface lacking a slot registered for the requested intent.
Consequently all four forms refuse before a relation picker can be loaded or
rendered. There is no lawful runtime-only substitution: the UX grammar assigns
form controls to `sections` and reserves `activity` for trust-substrate change
documents.

This is not a new hypothetical. `G3-P6a` deliberately shipped Inventory forms
in this inert state and assigned the later anatomy burn-down to `G3-P6b` /
`G2-P5d-c`. The accepted `form-wire-semantics` packet measured the same composed
release gap and stated that its form renderer was demonstrable only through a
fixture.

## Executed observation

The existing composed-application browser control was run on this branch:

```text
node scripts/run-with-test-lock.mjs exclusive -- corepack pnpm exec playwright test \
  --config apps/web/playwright.config.ts \
  apps/web/test/browser/composed-application.spec.ts \
  --grep "scopes immutable Inventory records and refuses writes" --reporter=list
```

The current Playwright configuration executed the complete browser inventory,
not only the requested grep: **76 passed in 1.6 minutes**. The named scoped
Inventory journey opened `inventory_transaction_form` with an explicit legal
entity and observed `UNSUPPORTED_COMPONENT`, zero textboxes, zero buttons, and
HTTP 422 `OPERATION_UNSUPPORTED` for a forged write. That is the exact gate
which would have to change for the scoped create path to become real.

Evidence classification: zero new committed controls and one author-selected
ad-hoc artifact census. The browser result is committed pre-existing evidence;
the four-form census is recorded measurement, not promoted to a regression
test that would contractualize the broken state.

## Why this is a stop

Making `stock_count_line_form` work requires, at minimum, changing its authored
surface anatomy in `packages/domain/src/inventory/definition.ts` and regenerating
the checked-in authored/compiled application release. Those paths and that
release-output change are outside this packet's lease, and the prompt names the
latter as an immediate stop.

A fixture-only scoped picker would prove the new picker machinery but would not
make any shipped scoped required-relation form fillable. It would repeat both
predecessors' failure mode: fix the easy specimen and report the class closed.
No product code was changed after this finding.

## Bridge / re-charter required

Before this packet resumes, the user must choose one of these serial routes:

1. land the already-routed remaining-anatomy slice first, giving the four
   required-relation forms a grammar-owned `record:sections` renderer, regenerate
   the application release, and then restart this packet from the new
   `origin/main`; or
2. explicitly widen this packet to own the same bounded anatomy and generated
   release paths, with all release-output downstream gates added.

The smallest expected path bridge is
`packages/domain/src/inventory/definition.ts`, the deterministic authored
application generator/output, the compiled application release, and every
surface-conformance baseline or fixture made red while preserving its meaning.
The exact generated set must be resolved by the repository generator rather
than guessed or hand-edited.

Still unimplemented and still owed after that dependency clears: the shared
catalog-level parser, reason-specific catalog agreement controls, deletion-dead
control repairs, scoped complete enumeration, relation-subject diagnostic,
create-only freeze disclosure, and the `stock_count_line_form` two-picker
browser-to-PostgreSQL create journey.

## Gate and review state

- Lease commit: `14c97f5`.
- Product delta: none.
- Full cheap gates / blast-radius gates: not run; the packet stopped before an
  implementation candidate existed.
- Full matrix: not run and not owed for this blocked, non-integrating state.
- Review: not launched; no candidate was frozen and no review prompt exists.
- Stop count: 1.

## Program-review trigger evaluation

No program review is run at this stop. The packet is mid-flight and has no
integrated product candidate, which is an explicit anti-trigger. The finding is
systemic evidence of queue/ADR-vs-running-app drift across more than one packet,
but the useful review point is after the anatomy prerequisite and relation
enumeration compose into the first real office-worker write slice. If that
integrated slice exists and module fan-out is next, the strong first-slice
trigger fires and a whole-app program review should be proposed before fan-out.
