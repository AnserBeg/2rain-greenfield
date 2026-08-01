# ADR-0038: Capability-backed surface operations — the O1 route

Date: 2026-07-31
Status: proposed by the orchestrator; ratified when its first implementing packet
is accepted.
Tier: Critical (it is the path by which a screen writes a business fact)

## Context

Inventory is readable. A user can pick a legal entity and see movements. **No
screen can post anything**, and no screen can reach the posting engine at all.

The engine exists and is admitted.
[ADR-0026](ADR-0026-inventory-posting-capability.md) ratified
`northstar.inventory:capability.posting` v1 — frozen by `G3-P1a`, implemented by
`PostgresInventoryPostingService`, and proven across four merged packets to
refuse negative stock, enforce approval thresholds and period locks, reject
backdating, catch duplicate idempotency keys, and hold its locks in serializer
order.

**ADR-0026 deliberately did not authorize a way to call it from a surface.** Its
Boundaries section is explicit — it does not *"authorize an HTTP route, top-level
agent tool, UI binding, import path, or reservation writer."* That gap is this
ADR's subject.

### Why the ordinary operation path cannot be used

Every operation authored in this platform today is `tier: 'o0'` with a record
effect — create, update, archive, restore. Six of them, no exceptions.

An `o0` operation **cannot** post, and this is structural rather than
incidental. `conformance.ts:1001` requires an append-only fact entity to declare
**zero** operation effects, so the generic press refuses to write a movement by
construction; the movement capability requirement carries
`declaredEffects: ['read']`. `5g3-post` recorded the finding plainly: *posting
cannot be an O0 operation.*

The danger is therefore not that posting is unreachable. It is that Inventory's
transaction and stock-count entities **do** carry ordinary `o0` create
operations, so a generic form can write a transaction row directly — bypassing
every invariant listed above. A screen that appears to record an adjustment while
skipping the posting service is worse than no screen at all.

### The vocabulary already exists, unimplemented

The canonical model already spells this seam:

- `registeredCapabilityEffect` — an operation effect referencing a **capability**
  rather than an entity (`packages/canonical-model/src/schemas.ts:937`)
- `tier: 'o0' | 'o1'` — a second operation tier, admitted by the schema, by
  `apps/web/src/surface-contract.ts:545`, and by
  `packages/runtime/src/semantic-operation-gateway.ts:85`

Nothing consumes either. `registeredCapabilityEffect` has **zero** references
outside the schema file, and nothing is authored as `o1`.

One concrete obstacle is already visible:
`semantic-operation-gateway.ts:820-828` asserts `isRecord(value.effect.entity)`
*before* examining the effect kind, and admits only the four record effects. A
`registeredCapabilityEffect` carries `capability`, not `entity`, so it is
rejected before its kind is considered. **The gateway's shape assumes every
operation writes a record.**

## Decision

### 1. The route is O1 + `registeredCapabilityEffect`. No new mechanism.

A surface operation reaches an admitted capability by declaring
`tier: 'o1'` and `effect: { kind: 'registeredCapabilityEffect', capability }`.
The compiler lowers it; the operation gateway dispatches it to the named
capability; the surface renders it as a command.

This ADR **authorizes the route, not a second posting path**. ADR-0026's warning
is binding: *"Similarity to this capability is not authorization."* An O1
operation invokes an already-ratified capability by reference. It may not embed
posting logic, re-implement a command, or reach storage directly.

### 2. Widening the gateway must not weaken the O0 path

The entity assertion at `semantic-operation-gateway.ts:820` must move behind the
effect-kind discrimination so an entity-less capability effect can be admitted.

**The O0 arm keeps every check it has today, unchanged.** A record effect without
an entity must still be refused exactly as now. The change admits a new kind; it
does not relax the existing one, and a control must prove the O0 refusal still
fires.

### 3. Authorization is the existing permission reference, plus ADR-0026's ALLOW

An O1 operation carries `permission` like any other, and the same policy gateway
governs it. Nothing here creates a second authorization mechanism.

ADR-0026 additionally requires an upstream ALLOW decision that the adapter
persists. That requirement is unchanged and unweakened: the surface supplies the
request, never the decision.

### 4. Posting requires deliberate confirmation

Plan §8.5 binds *weight matches consequence*, and
[ADR-0032](ADR-0032-feedback-ladder-and-loading-states.md) §4 forbids optimistic
treatment of anything that posts a movement, corrects a posted fact, or crosses a
legal-entity boundary.

An O1 operation whose capability writes a business fact declares
`confirmation: 'humanRequired'` and previews its predicted effects before
commit. No optimistic transition, no in-place silent success.

### 5. Idempotency is minted server-side, per rendered command

The posting capability requires an idempotency key and refuses duplicates. The
application ships **no client JavaScript**, so a double submit is a real and
ordinary event — a second POST from a re-clicked button or a back-navigation.

**The key is minted server-side when the command is rendered and carried with the
submission**, so a resubmission of the same rendered command presents the same
key and the capability's existing duplicate refusal absorbs it. The key is never
generated at submit time, and never by a client.

### 6. Verification exercises an O1 operation without asserting a business fact

Release verification arranges records through generic creates. An O1 operation
has no generic create, and verification has no authority to post a real business
movement.

The principle is already settled twice in this program and applies unchanged:
ADR-0031 §5 invokes a scope-declaring query with its operand omitted and requires
the typed refusal, and [ADR-0033](ADR-0033-exact-partition-verification-derivations.md)
governs recording what could not be executed. **Verification must exercise the
O1 route by driving a typed refusal, never by performing a posting**, and
ADR-0020:156 remains binding — a derivation is never a skip.

The precise refusal a packet drives is left to that packet, which must state it.

## What this ADR does not decide

- **The command input contract.** A posting command carries lines, quantities,
  reasons, an effective instant and a source identity. How a compiled surface
  *describes* those inputs — and whether that description is a new canonical node
  or an extension of an existing one — is genuinely open and deserves its own
  decision. **No packet may invent it silently.** This is the largest remaining
  question and it should be answered before the first O1 operation is authored.
- **Which capabilities become O1-reachable.** Posting adjustment is the intended
  first. Transfer, count correction, and release activation are not authorized
  here; each needs its own justification, per ADR-0026's rule that similarity is
  not authorization.
- **HTTP routes, agent tools, and import paths.** ADR-0026 withheld them and this
  ADR withholds them too. A surface operation is not an API.
- **Whether the ordinary `o0` create operations on Inventory's transaction and
  stock-count entities should be retired.** They are the bypass risk named in the
  Context, and retiring them may be the right answer — but it is a separate
  change with its own blast radius.
- **Client capability.** Nothing here requires JavaScript; §5 exists precisely so
  it does not. `U3` remains open and unaffected.

## Consequences

- **The bypass becomes visible.** Once posting has an authorised route, the
  ordinary `o0` create on `inventory_transaction` is plainly the wrong door.
  Naming it here means the next packet inherits the question rather than
  rediscovering it through a wrongly-written row.
- **The gateway gains a second dispatch shape**, which is where the risk
  concentrates. Every existing operation flows through the arm being widened, so
  the O0 refusal control is not optional decoration — it is the thing that proves
  the widening did not open a hole.
- **`o1` stops being decorative.** It has been admitted by three layers and used
  by none since it was written; a tier nothing exercises is a tier nobody has
  tested.
- **This is the last undesigned step to a usable Inventory.** Reading is done —
  surfaces, the legal-entity operand, and the picker. Trust is in flight —
  `ver-agg` and `G3-P5`. After this route exists and its input contract is
  settled, a warehouse operator can do their job.
