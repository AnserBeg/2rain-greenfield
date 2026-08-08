# ADR-0050: `transitionStateEffect` is honoured, and it decides `stateMachines` with it

Date: 2026-08-08
Status: proposed by packet `5g3-sm`; ratified when that packet is accepted
Tier: Critical (it decides how every business document changes state)

## Context

Queue row `5g3-sm` owed an enforce-or-retire decision on `stateMachines`, and
[ADR-0049](ADR-0049-document-transition-and-inventory-effect-seam.md) §1 ruled,
on a false premise, that *"there is no record-transition effect"* and that adding
one would be a canonical-language event. There is one. It is
`transitionStateEffect`, `packages/canonical-model/src/schemas.ts:933-937`, and
it has been released, compiled, and materialized since before either packet.

Everything below was **executed**, not read. The probe is preserved at
`packet/5g3-sm` (`bad2d8f` records the baseline, `276878e` the slice) and is
never merged, in the manner `proj-disc` and `PS-0` set.

---

## 1. What the declared shape actually does today

Measured by walking one `transitionStateEffect` operation outward through the
real compiler, the real materializer, the real release-verification service, the
real gateway and the real interpreter against real PostgreSQL:

| Layer | Result |
|---|---|
| `normalizeApplicationPackage` | **accepts** the machine and the effect |
| `compileApplication` | **compiles clean**, and already emits the closed input contract `['expectedRevision','recordId']` |
| storage materializer | **creates the physical state column** |
| release verification | `MalformedPinnedOperationCatalogError` |
| gateway, the transition operation | `MalformedPinnedOperationCatalogError` |
| gateway, **every other operation in the release** | `MalformedPinnedOperationCatalogError` |

**The last row is the finding the row did not have.** The concept is not merely
*declared but unenforced*, the class ADR-0041 named. One declaration **bricks the
entire release's operation surface** — an unrelated `master_create` fails with
the same error — and the refusal names neither the operation nor the effect,
which is the misnamed-cause defect [ADR-0046](ADR-0046-rollback-activates-history-and-defects-refuse-by-name.md)
forbids. `5g3-sm`'s *"a concept with zero declarations cannot misbehave"* is true
only while the count is zero.

**And the target it names is unreachable.** Also measured:

- an operation precondition referencing the machine's state field fails
  `CANON_REFERENCE_UNRESOLVED` — the derived field is not in `packageRevision.fields`;
- a query selecting it fails `CANON_QUERY_FIELD_LOCALITY` and `CANON_REFERENCE_UNRESOLVED`.

So the shape as spelled is not "accepted and ignored". It is **accepted and
unimplementable**: nothing can read the state, filter on it, or guard it.

---

## 2. Ruled: honour it, and honour `stateMachines` with it

**The two are one decision, and the schema is why.** `transitionStateEffect`
carries exactly one member — `transition` — and a `transitionDefinition` exists
nowhere but inside a `stateMachineDefinition`. The effect cannot name an entity,
a field, or a target without the machine. Honouring one and retiring the other
is not an available combination. **This ADR decides both.**

**The binding: normalization materializes each machine's state field as an
ordinary enum field on its entity, whose options are the machine's states, and
the parallel `derivedStateField` storage construct is retired.**

That placement is not a preference. Three independent compiler guards were hit
while trying the alternatives, each refusing for its own reason:

| Attempt | Refusal |
|---|---|
| materialize in a projection instead of normalization | `COMPILER_PROJECTION_INVARIANT_FAILED` — every projection must agree with the normalized model |
| emit the materialized column **and** `derivedStateFields` | `COMPILER_PHYSICAL_NAME_REUSE_INCOMPATIBLE` |
| leave the machine a second owner of the state identity | `COMPILER_SYMBOL_DUPLICATE` |

The compiler already enforces the ruling's central claim: **a document has one
state field, not two.**

### It is a canonical-language event, and the orchestrator's framing is corrected

The preferred ruling — *implement it as the generic carrier, with a
server-selected target, expected-revision compare-and-swap, authoritative
precondition evaluation and accepted trust evidence* — is **upheld in substance
and corrected in category**. It is **not** an execution-fence widening of
`G3-Pterm`'s shape.

`G3-Pterm` opened a one-argument call into a mode the kernel had already
shipped: nothing new had to be computed or carried, which is why it cost no
language event and no migration. Here the runtime needs three facts — the
entity, the state field, and the server-selected target — that **no pinned
projection carries**. The semantic-model projection carries a
`semanticFingerprint` of the transition, not its content
(`projections.ts:284-305`, measured). A fence cannot be widened onto data that
is not there.

Because normalization output changes, this is a language cut on ADR-0029's
stated line and on [ADR-0047](ADR-0047-the-compiler-semantic-profile-is-the-projection-evolution-axis.md)
§7's stated boundary — *"materialized into normalized output … owes a language
cut."*

### Why not retirement

Retirement is not cheaper, and ADR-0049 already priced half of it: *"inventing a
new effect kind instead is a canonical-language event."* Retiring means paying a
language event to remove a released spelling and a second one later to re-add an
equivalent, because the need does not go away — `purchase_order.release`,
`sales_order.confirm` and every cancel are state-only transitions. In between,
each becomes a hand-written capability executor owning its own compare-and-swap
and its own accepted trust writes, with nothing forcing any two to agree (§4).

ADR-0041 §3's *"nothing is implemented on spec"* is **satisfied rather than
violated**: the enforcement arrives with `PUR-1`, the module that needs it, and
the negative controls arrive with it. ADR-0041's own deferral note — *"the next
planned modules are built from state machines"* — had quietly become false when
ADR-0049 routed `PUR-1` to capabilities. This ruling restores it.

---

## 3. The vertical, and what it cost

Green against real PostgreSQL, through the real gateway and interpreter:

| Property or control | Result |
|---|---|
| exactly one state column, not two | asserted on `information_schema` |
| `draft → released` from the compiled `toStateId`, revision 1 → 2 | succeeded |
| stale `expectedRevision` | `MODULE_REVISION_CONFLICT`, state unchanged |
| a forged target argument | `MODULE_INPUT_MALFORMED` |
| precondition against the persisted prior image | `MODULE_OPERATION_PRECONDITION_REFUSED`, state unchanged |
| a second release of a released record | `MODULE_MUTATION_PRECONDITION_FAILED` |
| written exactly once | one change document, `draft → released` |

**The bill, measured rather than estimated:**

| Gate | Result |
|---|---|
| `check:app-release` | **exit 0** — the whole compiled lineage still reproduces |
| `check:demo-release` | **exit 0** |
| `test/postgres/module-runtime.test.ts` | **20/20 pass** — the entire generic press, trust, RLS and legal-entity-scope suite is undisturbed |
| `test:unit` | 4 red, every one a normalization-byte pin |
| `test:compiler` | 2 red: the retired construct's own test, and the per-entity field budget |

**Zero release roots move, because no first-party module declares a state
machine.** Every one declares `stateMachines: []`. That is what makes the cut
cheap today and expensive the moment any module adopts one — the same timing
argument ADR-0041 §4 made for narrowing, pointing the other way.

The four unit reds include `v0, v1, and v2 readers retain their exact normalized
bytes`, which is the negative control that exists to red exactly here. It firing
is the evidence that this is a language event, not the claim that it is one.

---

## 4. Where the guarantees live, and what forces the next executor

**They live in the generic O0 interpreter, and nothing forces any executor.**

ADR-0049 §1 attributed server-selected target, compare-and-swap and trust writes
to the `o1` tier. Three of the four are ordinary generic-press behaviour:

- **the authoritative image** — `prepareMutation`
  (`module-runtime-interpreter.ts:529-541`) loads the prior row inside the
  trusted transaction and evaluates the precondition there;
- **compare-and-swap** — the mutation's `WHERE` pins `record_id`, `revision` and
  `archived_at IS NULL`, with `requireMutation` on the row count;
- **written exactly once** — one statement, one row.

Only the **server-selected target** is new, and it is the whole content of the
effect: the patch comes from the compiled `toStateId` instead of the caller.

**Nothing forces a capability executor to honour the same four.** Executors are
registered and dispatched by exact capability id
(`capability-operation-executor-factory.ts:41-58`,
`semantic-operation-gateway.ts:745`); no interface carries target selection, CAS
or trust obligations, and ADR-0049 §1 records that accepted trust evidence is
each executor's own. A second capability transition is therefore a second
hand-written implementation of four properties with no gate over it. **That is
the argument for the generic carrier, and it is why `registeredCapabilityEffect`
is reserved for transitions whose atomic domain effects exceed this contract** —
posting being the one that does.

---

## 5. ADR-0034 is answered, not routed around

`prepareMutation` evaluates the projected image **only** for
`updateRecordEffect` (`:542`), and the code states why: an update carries a
caller patch, so without the projected check *"the row lands terminal by press
rather than by the sanctioned writer."*

**A transition carries no patch.** Its input contract is closed over
`['expectedRevision','recordId']` and the target is compiled, so the hazard the
projected check exists to prevent is structurally absent. The prior-image check
is the whole precondition guard, and the compare-and-swap additionally pins
`fromState`.

The consequence §7.7 asked for is measured: a `not(released)`-shaped guard
**admits the release and refuses the second one**. No exception to ADR-0034 is
requested, and none is needed.

---

## 6. What is owed and not done

Found by the probe, and none of it optional for `PUR-1`:

1. **The read path.** The materialized state field is correctly excluded from
   every caller-writable contract, but nothing yet admits it to query selections
   — so a released purchase order cannot be listed by state. **This is the gap
   that makes the vertical thin rather than complete.**
2. **Release verification.** Measured: `ReleaseVerificationIntegrityError:
   search exclusion probe could not populate its subject field`. The plan probes
   a field no caller may write — the same class as `5g3-mount`'s
   `legal_entity_id`, for which `systemInput` is the solved precedent.
3. **Which layer owns the closed contract.** `assertClosedOperationArguments`
   runs for capability operations only, so an O0 transition's closed contract is
   enforced one layer down by the interpreter. Both refuse; the placement should
   be decided rather than inherited.
4. ~~**The per-entity field budget** gains one field per machine.~~
   **Withdrawn as a misattribution — corrected 2026-08-08 by `5g3-sm-impl`.**
   There is no per-entity field budget. The red was
   `cold full compile stays within the numeric v0 maximum-field budget`, a
   **wall/CPU timing** gate whose fixture (`test/fixtures/g1/compiler/vertical-v1.authored.json`)
   is authored at v3 and declares **zero** state machines, so no change here can
   reach it; the probe ran it while a PostgreSQL container and two other lanes
   held the machine, and that gate refuses to measure below 90% CPU idle by
   design. Attributing a load artifact to the change was the error.
   The real and much narrower consequence:
   `STRUCTURAL_LIMITS_V0.families.fields` is a **package-wide** limit of 4096
   counted **after** normalization, so a package declaring N machines has an
   effective authored budget of 4096 − N.
5. **`apps/web`.** `operationIntent` (`surface-contract.ts:638`) returns `null`
   for this effect kind, so a bound surface would throw `INVALID_SURFACE_BINDING`.
   Not exercised by the vertical.
6. **The misnamed refusal** of §1, which is owed regardless of this ruling.

## 7. One transition, one permission — ruled 2026-08-08 on `5g3-sm-impl`'s review

**The language declares two permissions for a transition and execution honours
one.** `transitionDefinition.permission` is declared at `schemas.ts:634`; the
gateway authorizes `definition.permissionId`, which is the *operation's*. The
compiled effect carries `entity`, `fromStateId`, `toStateId`, `stateFieldId` and
`transition` — and no permission. A transition declaring `release_restricted`
under an operation declaring `edit_basic` therefore executes on `edit_basic`,
and the declaration a reader trusts is precisely the one ignored.

**This is §1's defect class, one field down, re-introduced by the packet that
closed it.** The vertical stayed green because it declares one permission id in
both positions, so its policy cannot tell the two declarations apart. A control
that reuses an identity cannot observe a rule about two identities agreeing.

**Ruled: `operation.permission` must equal `transition.permission`, refused by
name at compile time** (`COMPILER_TRANSITION_PERMISSION_MISMATCH`).

**Equality rather than a second runtime authorization**, and the reason is a
fact about the effect rather than a preference: `transitionStateEffect` holds
exactly one `transition` reference, so the two permissions are 1:1 and one
authorization is the whole truth. Adding a second gateway decision would be
generalizing in advance of the shape that needs it.

**And the rule refuses the multi-transition case loudly, which is the trigger to
revisit.** The day an effect carries more than one transition, equality stops
being expressible and this diagnostic fires — a decision point that announces
itself rather than one someone must remember to look for.

**Two controls are owed, not one.** A mismatch must be refused, *and* the matched
case must still compile. Without the second, the first is satisfiable by refusing
every transition — which would pass the control while destroying the feature.

## Boundaries

This decision authorizes no purchasing entity, no module, no mount, no posting
role, no dependency-set change and no merge. ADR-0049's unresolved items —
capability admission, the companion transaction, the posting kernel — are
untouched. It does not cut the language version; it rules that one is owed and
prices it.
