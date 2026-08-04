# 5g3-postroute — Capability-backed Inventory posting surface route

Status: evidence ready; governed surface-grammar decrease registered exactly as
`126 - 2 = 124`; frozen SHA and full-matrix verdict are reported in the packet
handoff because a commit cannot contain its own identity

Tier: Critical

Branch: `packet/5g3-postroute`

Original posting-route base: `7e7c91b84131d6adde3a8fa1dc420b1cf6e962a8`

Finish-and-land base: `011cd6a5a1afb9b314beedf58d8d161fe301dc21`

## Finish-and-land premise audit

Searchcap's refusal work is a different concern, not an overlap, duplicate, or
conflict. Searchcap derives whether a declared search can execute from lowered
storage and raises `MODULE_SEARCH_CAPABILITY_UNAVAILABLE` at runtime when a
historical declaration cannot be honoured. This packet's
`verificationRefusal` instead declares the exact typed error that release
verification expects from a deliberately input-less capability probe. Searchcap
did not add a factory-declared verification expectation or another mechanism
for identifying that probe's producing layer, so there is no second authority
to conform to. The merged service preserves searchcap's same-entity search
witnesses and runtime refusal unchanged while applying the exact code-and-reason
check only to registered-capability verification.

Commit `98bb392` is the ground this guard was written against, not a later
change that invalidates it: it is the parent of the guard commit and introduced
the factory, Inventory adapter, verifier route, and composed-application probe
that this packet tightens. Current main retains those mechanisms. Searchcap
changed the neighbouring search scenarios and their partition counts, but did
not change the posting factory or its route. On the merged tree the exact
verification partition remains searchcap's `163 = 127 executed + 36 derived`;
this guard changes what qualifies as evidence for the existing posting scenario
and adds no scenario of its own.

## Outcome and boundary

Inventory declares one `o1` operation,
`operation.inventory_transaction_post`, with a
`registeredCapabilityEffect` naming the exact frozen
`northstar.inventory:capability.posting` contract. It is permission-gated,
requires human confirmation, reads the transaction back through its registered
scoped Q0 query, and is offered only while the compiled draft-state
precondition holds.

The route is draft-then-post. Ordinary O0 forms stage the transaction header
and lines. The record surface says that the draft is staged and posting is a
separate confirmed step. The command's input contract is the existing
record-scoped `northstar.module-input-contract/v1`: `recordId` and
`expectedRevision`, plus a server-rendered idempotency key outside the canonical
business input. No command fields, movement fields, SQL identity, or posting
decision comes from the browser.

The movement remains an append-only fact with zero record-operation effects.
The unchanged conformance check at `packages/compiler/src/conformance.ts:1378`
continues to refuse any generic effect on append-only storage.

`PostgresInventoryPostingService` is byte-identical to the base. The
capability-local adapter hydrates the complete adjustment snapshot with
SELECT-only reads before the posting transaction opens, as ruled by the command
input verdict. It then delegates at
`inventory-posting-capability-executor.ts:120` to the ratified service. The
service remains the only writer and independently cross-checks that snapshot
against the active draft under its existing serialized locking protocol.

## One registered dispatch

The operation gateway now decodes a discriminated union:

- O0 record effects remain `tier: o0` and retain the complete entity-reference
  validation inside their arm;
- O1 registered capability effects must be `tier: o1`, carry an exact
  capability reference, and dispatch through one exact-ID executor registry.

The same live current-policy decision and permission reference govern both
arms. The gateway supplies ADR-0026's upstream `ALLOW` receipt to the adapter;
the surface supplies no authorization decision. A missing exact executor raises
`NO_SUCH_REGISTERED_CAPABILITY`; an executor registered for a different ID is
not considered.

The provider owns one generic factory contract and extracts the set of required
capability executors from the compiled operation catalog. Inventory owns the
sole adapter declaration for its frozen capability. Serving and release
verification instantiate the same factory set; neither carries a second
operation dispatch.

## Deliberate confirmation and idempotency

`component-registry.ts:530` mints the UUID when rendering the command form.
`surface-runtime.ts:764-770` preserves that exact form input across the preview,
and `:293` submits the preserved value. Nothing generates a key at submit time,
and no client JavaScript exists.

The preview names the exact compiled capability and predicts an append of its
declared business facts. No optimistic record transition occurs: the detail
page still shows revision 1 during preview, then displays the gateway's committed
read-back at revision 2. Re-submitting the preserved form carries the same key;
the posting service returns its existing duplicate receipt, and no second
movement appears.

## Verification refusal

Verification arranges a real generic transaction header and executes the O1
operation through the same operation gateway and exact registered capability
adapter. The arranged transaction is not an adjustment draft, so the adapter
refuses before the posting service is entered with:

```text
INVENTORY_POSTING_INPUT_INVALID
only adjustment drafts are admitted by this route
```

This is the declared verification refusal. It proves registration, gateway
dispatch, adapter hydration, and route-level input enforcement without
inventing a business adjustment or posting a movement; it does not prove that
release verification enters `PostgresInventoryPostingService`. The independent
browser journey proves the complete route reaches that service by posting a
staged adjustment in 1.3 seconds and observing its committed read-back and
idempotent replay.

Each capability factory owns the exact refusal expected from its verification
probe. `captureDeclaredCapabilityRefusal` requires both the assertion's exact
code and the factory-declared exact reason. A different code or the same code
from a different layer becomes
`VERIFICATION_CAPABILITY_REFUSAL_MISMATCH`; a successful response becomes
`VERIFICATION_CAPABILITY_REFUSAL_NOT_OBSERVED`.

In the original posting-route delivery, the authoritative partition moved from
167 total / 129 executed / 38 derived to 168 / 130 / 38, with the new scenario
executed rather than skipped or derived. Searchcap subsequently re-derived the
current partition as 163 / 127 / 36 while preserving that posting scenario as
executed. This finish-and-land guard changes no partition membership or count.

## Controls and victim lines

| Control | Observed fact | Victim |
|---|---|---|
| O0 remains closed | An entity-less O0 effect raises `MALFORMED_PINNED_OPERATION_CATALOG` | O0-only validation arm at `semantic-operation-gateway.ts:1022-1049` |
| Exact O1 registration | The named executor runs once; no executor and a wrong-ID executor both raise `NO_SUCH_REGISTERED_CAPABILITY`, with wrong executor count zero | exact map lookup at `semantic-operation-gateway.ts:745-747` |
| Confirmation is load-bearing | No grant raises `SEMANTIC_OPERATION_CONFIRMATION_REQUIRED` and executor count remains zero; a matching server grant executes once | `mediation.assertConfirmationGrant` at `semantic-operation-gateway.ts:632-637` |
| No direct adapter writer | Architecture reads the production adapter, observes hydration SELECTs and delegation, and refuses a synthetic UPDATE; the PostgreSQL route observes posting-service trust receipts and one movement | delegation at `inventory-posting-capability-executor.ts:120-124` and the adapter's no-mutating-SQL control |
| Same rendered command | Preview preserves the exact hidden key; the real PostgreSQL route replays the same envelope and observes the same trust receipt, revision 2, and exactly one quantity-7 movement | render mint at `component-registry.ts:530`, preservation at `surface-runtime.ts:764-770`, submission at `:293` |
| Exact verification refusal | The adapter's exact code/reason records an executed probe; wrong-code, same-code/wrong-layer reason, and non-refusing promises independently fail | exact code-and-reason match in `captureDeclaredCapabilityRefusal` and its success fallthrough |
| No optimistic posting | Browser observes revision 1 on the preview page and revision 2 only after confirm | confirmation transition at `surface-runtime.ts:758-774` |
| Append-only fact still has no press | Compiled Inventory movement declares zero operation effects and all conformance gates pass | append-only operation-effect refusal at `conformance.ts:1378-1386` |

## Artifact event

ADR-0039 regeneration was performed through the repository scripts, never by
hand:

```bash
node --import tsx apps/web/scripts/generate-app-authored.ts
corepack pnpm --filter @north-star/web build:app-release
corepack pnpm check:app-release
```

`apps/web/release/app.authored.json` and
`apps/web/release/app.compiled.json` moved. Lineage entries 0 through 4 are
unchanged. A new entry 5 records the posting route:

- previous entry 4 root:
  `ee5d474d50eb5243856fd11c7a3160f915b2fe6e1f85b57f2c443f6792e7e843`;
- new entry 5 root:
  `4b254f50b2f558e96b98325467ae339a4bd6492d9691ccb464eb88d1b53f3bb1`.

The experimental compiler output protocol is unchanged. No structural golden,
migration, privilege grant, posting-service byte, timeout, budget, or hex
literal moved.

## Gate evidence

### Finish-and-land guard controls

The guard controls were executed after merging searchcap on
`011cd6a5a1afb9b314beedf58d8d161fe301dc21`:

- Restoring the historical loose predicate
  `code !== expected.code || !reason` made the right-code/wrong-reason promise
  resolve. The test therefore went red with the exact text
  `Missing expected rejection: RIGHT_CODE_WRONG_REASON_MUST_FAIL`. This is the
  original defect demonstrated: the wrong producing layer was admitted.
- Supplying the declared code with the wrong reason to the restored production
  guard exited red with
  `ReleaseVerificationIntegrityError: VERIFICATION_CAPABILITY_REFUSAL_MISMATCH: capability operation northstar.test:operation.capability did not produce its exact declared typed refusal`.
- Supplying the declared reason with the wrong code exited red with the same
  named mismatch:
  `ReleaseVerificationIntegrityError: VERIFICATION_CAPABILITY_REFUSAL_MISMATCH: capability operation northstar.test:operation.capability did not produce its exact declared typed refusal`.
- Supplying a capability factory with no `verificationRefusal` exited red before
  scenario execution with
  `ReleaseVerificationIntegrityError: VERIFICATION_CAPABILITY_REFUSAL_CONTRACT_INVALID: capability factory northstar.inventory:capability.posting must declare its exact refusal`.

The last control exercises `declaredCapabilityVerificationRefusals`, the same
production validator the release-verification service uses to build its
capability expectation map. A TypeScript declaration alone is not treated as a
runtime observation.

### Original posting-route evidence

- `corepack pnpm typecheck`: PASS.
- `corepack pnpm lint`: PASS.
- `corepack pnpm test:compiler`: 116 / 116 PASS.
- `corepack pnpm test:unit`: 55 / 55 PASS; the exact bidirectional hex ratchet
  remains 69.
- `corepack pnpm test:integration`: 71 / 71 PASS after the final wrong-ID
  strengthening.
- `corepack pnpm test:postgres`: 157 / 157 PASS in 594.9 seconds. The composed
  activation parent took 96.9 seconds and the real route/replay subtest passed.
- `corepack pnpm test:browser`: 23 / 23 PASS in 1.7 minutes; the posting journey
  took 1.4 seconds.
- `corepack pnpm check:app-release`: PASS.

Architecture initially found two implementation-shape defects and one governed
registration event. The predicate tripwire is restored without changing its
inventory by reusing the existing authored field-comparison constructor. The
provider press law is restored by deriving the adapter's read-back entity from
compiled storage rather than naming an Inventory operation in generic provider
code.

The governed Inventory surface-grammar decrease is registered by attribution,
not fitted to the observed result: `126 - 2 = 124`. The compiled checker still
reads all 20 Inventory surfaces and observes
`northstar.inventory:surface.inventory_transaction_detail`. That surface now
contains `commandBar` in both the desktop surface and compact projection, so it
has zero commandBar-specific `SG003_REQUIRED_SLOT` and
`SG009_COMPACT_SLOT` findings. Its six unrelated missing-slot findings remain
visible. The exact production ratchet then reports `inventory=124/124`, and the
complete architecture suite passes 107 / 107. No assertion was raised,
relaxed, exempted, or allowlisted.

The load-bearing focused controls were also mutation-proven red and restored:

- replacing the exact capability map lookup with the first registered executor
  made the wrong-ID control fail with `SemanticOperationExecutionFailedError`;
- deleting confirmation-grant validation made the no-grant control fail with
  `Missing expected rejection`;
- bypassing the O0 validation arm made the entity-less control receive a
  non-catalog error and fail its typed assertion;
- dropping `idempotencyKey` from preview preservation made the hidden-value
  assertion fail;
- removing the expected-code comparison made the wrong-refusal arm fail with
  `Missing expected rejection`; and
- removing the no-refusal fallthrough made the successful-response arm fail
  with `Missing expected rejection`.

After restoration, the five focused control groups passed 5 / 5. A formatting
check was accidentally started during another lane's matrix window and is not
counted as evidence; after that matrix exited, formatting, typecheck, lint,
compiler, and integration were rerun on a quiet machine and passed.

Fable's Critical review then found that this record named the posting service's
no-lines refusal even though verification actually stopped at the adapter's
non-adjustment refusal. The record above now names the observed layer and exact
reason. The control was strengthened from code-plus-nonempty-message to exact
code-plus-factory-declared-reason. Mutating the verifier back to a nonempty
message check made the same-code/wrong-layer arm fail with
`Missing expected rejection`; restoring the exact reason comparison returned
the focused control to green.

## Test it yourself

```bash
corepack pnpm test:architecture
corepack pnpm test:postgres
corepack pnpm test:browser
```

Then open the seeded Inventory transaction detail. It should say **Draft
staged**, preview the exact posting capability, remain at revision 1 before
confirmation, and show **Post complete** at revision 2 afterward. Resubmitting
the preserved confirmation must keep revision 2 and produce no second movement.

## Recorded limits

- This packet exposes adjustment posting only. Transfer, count correction,
  agent tools, HTTP APIs, imports, reservations, and grouping remain absent.
- Inventory deliberately declares `confirmation: 'humanRequired'`, and the
  gateway enforces it, but the compiler does not yet require that declaration
  for every fact-writing registered capability. Row `5g3-o1confirm` owns that
  gate before a second O1 family is admitted.
- The gate proving that the adapter contains no mutating SQL is a source
  observation. The real PostgreSQL route supplies the independent behavioral
  evidence: the result carries the posting service's trust receipt and the
  ledger contains exactly one movement after replay.
