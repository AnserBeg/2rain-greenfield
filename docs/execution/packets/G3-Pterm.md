# G3-Pterm — Terminal-state operation preconditions (queue row `5g3-term`)

Lane: BUILD · Tier: Critical · Branch: `packet/g3-term` · Initial base: `378216a`

Status: **AUTHORING AND FOCUSED EVIDENCE COMPLETE; FULL MATRIX AND REVIEW PENDING.**
The orchestrator owns the remaining commit, matrix, and review steps.

## Outcome

Generic operations can no longer rewrite, archive, or restore posted stock-count
evidence. `stock_count` declares the same exact not-posted precondition on create,
update, archive, and restore. The generic PostgreSQL interpreter evaluates it against
the candidate image on create, the prior image on every existing-record mutation, and
the separately projected image on update.

The terminal rule also protects aggregate children. The semantic-operation gateway
passes the pinned catalog's active O0 update preconditions as `parentGuards`; the
interpreter resolves and evaluates the matching parent guard only for storage relations
classified `parentScopedChild`. A `reference` relation remains exempt, so a correction
session may still supersede posted evidence without acquiring aggregate-child semantics.

`schemas.ts` and `normalize.ts` remain unchanged. This is enforcement of an existing
canonical operation-precondition concept, not a language-version event. `stateMachines`
remain untouched and belong to row `5g3-sm`.

## The wider compiler defect this packet exposed

Before this packet, whole-model conformance received only
`projectionDispatchRevision(packageRevision)`. That internal compatibility revision
replaces **every operation precondition** with a literal-true `booleanPredicate` in
`compiler.ts`. Consequently, any conformance rule intended to pin an authored operation
precondition was structurally blind: it could never observe the declaration it claimed
to ratchet. A guard could therefore be malformed or absent while the rule inspected a
manufactured `true` instead. This is a general fail-open conformance defect, not an
Inventory-specific mismatch.

The repair keeps both authorities distinct:

- compatibility conformance continues to receive the dispatch revision for the v2
  structural shape;
- `validateModuleConformance` also receives the authored normalized package revision;
- the stock-count ratchet checks lifecycle/effect/entity structure in the compatibility
  view, but compares the canonical root of the **authored normalized precondition**.

The literal-true compatibility value is not the persisted operation catalog consumed at
runtime. `decorateV3ProjectionPlans` restores authored preconditions into the single
operation-catalog plan before `emitScheduledProjections` emits or persists anything. The
request-runtime loader accepts that content-addressed operation-catalog family from the
release manifest; it has no alternate path that resolves operations directly from the
internal dispatch revision. C1–C7 additionally observe the authored guard through the
real persisted gateway/interpreter path, so this conclusion is not based only on source
inspection.

## Implemented boundaries

| Boundary | Result |
|---|---|
| Canonical predicate kernel | Parse-only `admitPredicateForExecution`; its `admitted` receipt remains deliberately distinct from `accepted`, so un-migrated callers fail closed |
| Gateway | Selected preconditions must return `admitted`; unparseable shapes refuse before execution; active O0 update guards are carried in `parentGuards` |
| Interpreter | Candidate, prior, projected, and parent images are evaluated generically; undecidable comparisons are errors, never semantic absence |
| Domain | `operations()` accepts an optional precondition; only the `stock_count` call site supplies the exact not-posted predicate |
| Compiler | `stock_count.state` stays required and all four fixed operation IDs must carry the exact authored predicate |
| Aggregate ownership | Only `parentScopedChild` relations inherit the parent guard; `reference` relations do not |

The Inventory declaration edit is confined to the `operations()` helper and its
`stock_count` call site. No entity, field, relation, state-machine, posting-service, or
surface declaration changed.

## Controls and non-vacuity victims

| Control | Observed behavior | Production victim whose removal turns it red |
|---|---|---|
| C1 | Updating a posted session refuses with `MODULE_OPERATION_PRECONDITION_REFUSED` | prior-image evaluation in `prepareMutation` |
| C2 | The identical update on a counting session succeeds | comparison resolution against the real record image |
| C3 | Reviewed-to-posted update and create-as-posted both refuse | the separate projected- and candidate-image evaluations |
| C4 | Archive of a posted session and restore of an archived line under a posted session refuse | existing-record evaluation plus the parent guard on restore |
| C5 | Creating a line under a posted session refuses | parent-guard evaluation in `requireRelationTarget` |
| C6 | Updating and archiving an existing line under a posted session refuse | `requireExistingParentGuards`, which resolves the stored parent ID |
| C7 | Updating a seeded correction session whose `supersedes` reference targets a posted session succeeds | the `ownership === 'parentScopedChild'` filter; treating references as parents makes this red |
| C8 | Missing guard, wrong option, and optional state each fail with `INVENTORY_TERMINAL_GUARD_MISSING` | authored-revision input to the conformance ratchet |
| C9 | A malformed registered precondition refuses before the executor | gateway guard `preconditionReceipt.outcome !== 'admitted'` |
| C10 | The full stock-count and posting suites stay green | regression boundary proving generic press enforcement does not enter `#post`'s direct-SQL path |

C7 uses an already-seeded correction session because the current generic create contract
cannot construct the non-null legal-entity storage input for an entity-owned stock count.
The control still observes the intended ownership distinction end to end: widening the
existing-parent relation filter to include `reference` makes it refuse against the posted
superseded session. Whether capability-mediated entities should expose unconstructable
generic create operations remains a separate routed contract question.

Kernel controls also prove that parse-only admission does not evaluate truth, every
unparseable shape refuses, and `admitted` cannot be mistaken for the legacy `accepted`
receipt.

## Focused evidence

The orchestrator observed:

- C1–C7: pass through the real gateway and PostgreSQL interpreter;
- C8: pass for exact guard and required-state ratchets;
- C9: pass for fail-closed parse admission;
- C10: both `inventory-stock-count` and `inventory-posting` suites pass;
- `test/integration/module-runtime.test.ts`: 13/13, with the gateway correctly encoding
  admission only rather than a verdict;
- all 34 existing G3-P3/G3-P4a posting controls continue to execute.

`predicate-admission.test.ts` is registered in both the explicit `test:unit` command and
the repository-hygiene inventory, so its controls are CI-reachable rather than merely
present on disk.

## Remaining acceptance work

The full matrix and Critical review chain have not yet been recorded for the final tree.
No packet integration claim is made by this document.
