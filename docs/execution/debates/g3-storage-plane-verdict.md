# Inventory storage plane — converged verdict

**Status: CLOSED and binding.** Ruled 2026-07-29 by two independent arms
(Codex `gpt-5.6-sol` xhigh, Fable max) against a shared charter, reconciled by the
orchestrator. Binding on packet writers, who follow it and do not relitigate it.

Trigger: `G3-P2b-1` implemented inventory storage as **sixteen hand-authored
tables in the `platform` plane** (`db/migrations/0015_inventory_storage_foundation.sql`).

## The ruling

**`G3-P2b-1` is not accepted as built.** Both arms, independently, unanimously.

**Fourteen relations move to the compiler-owned managed-module plane. Two stay
platform.**

| Relation | Plane | Deciding reason |
|---|---|---|
| `legal_entities` | **Module** | ADR-0015:87-91 rules it verbatim; its evidence section forecloses the kernel reading by name; the ratified family map classifies it `tenantShared`, a classification that exists only for module entity families |
| `inventory_transactions` | **Module** | Business document header; the flagship G6 customization target |
| `inventory_transaction_lines` | **Module** | Parent-scoped child — the shape the press already proves in its mandatory fixture |
| `inventory_movements` + `p0`–`p7` | **Module**, after a press extension | The canonical Inventory entity and Q1 aggregation source. Partitions follow the parent; they are a press feature, not a plane argument |
| `inventory_movement_effects` | **Module companion** | Same writer, same transaction, FK-bound to movements. A compiled companion object, not a standalone Q0/O0 entity |
| `inventory_period_locks` | **Module** | **The one arm disagreement; adjudicated below** |
| `inventory_tenant_calendars` | **Platform** | Tenant provisioning input read by the kernel temporal-authority function; keyed by `tenant_id` alone, structurally inadmissible under a module ABI whose every key leads with tenant *and* environment |
| `inventory_posting_configurations` | **Platform** | Release-recorded governance dials pinning `contract_release_root` — to the posting protocol what the active-release pointer is to activation. No Q0/O0 surface, no G6 extension path by design |

The two platform tables require **their own accepted ADR**. ADR-0023 admits saved
filters as the sole platform-persisted capability and requires a separate ratified
ADR per additional one; that discipline is not optional here.

## The one disagreement, adjudicated

Codex ruled `inventory_period_locks` **module** (`closedThrough` is declared
business state of `legal_entity`). Fable ruled it **platform**, calling it
explicitly "the closest call," while noting it should be revisited at G6 if
tenants need product surfaces over it.

**Ruled module**, siding with Codex, on three grounds: closing a period is a
business operation with an obvious product surface — who closed it, when, and
reopening with audit — not a kernel command; `G3-P1a` froze `closedThroughScope:
'legalEntity'`, scoping it to a module entity; and Fable's own G6-revisit caveat
concedes the kernel placement creates exactly the later module migration both arms
otherwise work to avoid. Placing it in the kernel now buys a re-baseline later.

## Why the plane is not a matter of taste — the read path

The decisive finding, Fable's, verified against ten call sites: **every SQL
statement the generic interpreter builds is hard-anchored to `north_star_module.`**
(`module-runtime-interpreter.ts:474, 490, 549, 576, 594, 615, 645-646, 992, 995,
1657`). Platform-plane movements are therefore **unreachable by the only sanctioned
read path.**

`G3-P5` would face exactly two options: a second bespoke executor over platform
tables, or failure. ADR-0023 forecloses the first — Tier-B is structurally
storage-*less*, saved filters are "the sole capability admitted," and a platform
capability may never "provide an alternate path for a Tier-A entity that the
generic press can represent." And the one bespoke executor that already exists
silently dropped policy filter plans until Q1-P1 caught it.

This is not a G6 concern. It arrives at **G3-P5, the next packet on the read side.**

## The packet has already breached both planes

Three concrete symptoms on the branch today, all found by the arms:

- `db/migrations/0015:476-526` contains a DO-block running
  `ALTER TABLE north_star_module.nsm_t_*` — **a checked-in kernel migration
  mutating the managed plane**, whose desired state the topology verdict says the
  canonical release owns solely. A second desired-state authority.
- The materializer diff adds `entity.entityId.endsWith(':entity.item')` — a
  module-ID branch inside generic press machinery. ADR-0023:110-114 refused exactly
  this even while admitting Tier-B: "that is not permission for the materializer to
  inspect a module namespace."
- The base-unit constraint is authored by provider code and migration DDL,
  representable in no release byte. The invariant is right and stays; its **emission
  must become declaration-driven from the pinned contract.**

The press-law ratchet asserts violations deep-equal exactly the two routed
saved-filter entries, so either the suffix-form literal evades `PRESS006` — a guard
miss of the kind Q1-P2's tripwire limits predicted — or the matrix goes red.

## The partitioning gap is real, and it does NOT require a language version

Both arms verified independently that no declarative partitioning path exists:
`storageClass` admits only `['dedicatedTable','generatedTyped']`
(`schemas.ts:947-948`); the renderer's complete constructive vocabulary
(`protocol.ts:265-271`) contains no partition-creating kind; `removePartition`
appears only in the destructive-rejection union; the materializer's
`partitioned_table`/`partitioned_index` strings are **drift-walker recognition
without emission**. There is no "declare now, partition later" path — PostgreSQL
cannot convert a populated table in place and `G3-P0:108-111` forbids that retrofit.

**The orchestrator asked whether this forces a v4 canonical bump. It does not.**
Fable ruled the sanctioned mechanism is a **storage-target-payload version bump
plus conformance rules driven by the pinned inventory contract, with zero canonical
bytes moving** — precisely the mechanism `G3-P1b` exercised days ago at recorded
modest cost. It was simply not attempted.

**The full bill is three features, not one:** partitioning, an append-only
lifecycle (create-only grants plus a reject-mutation trigger as an admitted
constructive statement kind — today's rejection list bans `deleteCapableTrigger`,
the opposite polarity), and the ABI-function-backed business-period check.

## Why now, and the honest alternative

`G3-P0:179-181`: no movement may exist before Freezes J and K are accepted; after
the first posted movement a change to K is "a governed version/re-baseline event,
never an incidental later-packet edit."

- **Today**, tables empty and packet unaccepted: relocation is an **edit**.
- **After acceptance**: a governed **re-baseline event**.
- **After the first posted movement**: a **business-data migration** whose
  destructive half the program's own law physically resists — the rejection list,
  no-DELETE grants, and the reject-mutation triggers this very migration installs.

**The strongest argument against this ruling**, stated by Fable and preserved
because it is genuinely strong: the movement spine is the critical path, and this
inserts the largest press extension since P2b between `G3-P1b` and the serializer,
while the packet as built exists now with 19 executed negative controls and real
RLS probes. One can argue the ledger is kernel *evidence* like semantic receipts
and verification results — written only by kernel posting code, never through O0.

The answer: receipts are the machinery's evidence about itself and are never
product query results, while movements are the product's central queryable record —
plan §11.6's UI, agent, export and reconciliation all read them.

**But the framing matters more than the preference.** If time-to-first-posting
dominates everything, **option B with a ratified ADR is honest drift; accepting
this packet silently is dishonest drift.** That difference is the one thing this
verdict insists on. A user ruling for speed is legitimate; it must be *recorded*,
not absorbed.
