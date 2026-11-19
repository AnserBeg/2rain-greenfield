# ADR-0074: Admission of the formula/rule and workflow projection families

Date: 2026-11-19

Status: Proposed for orchestrator read. This record admits no language syntax, patch payload, or reader.

## Context

[ADR-0012](ADR-0012-expression-kernel-ceiling.md) requires a dedicated projection for first-class `FormulaRuleDefinition` and batches family admission at a language/profile boundary. [ADR-0047 §7](ADR-0047-the-compiler-semantic-profile-is-the-projection-evolution-axis.md#7-an-optional-authored-key-rides-the-adopted-language-version--ruled-2026-08-07-on-u5bs-review) allows an optional authored key when prior normalized bytes and compiled roots reproduce. The formula/rule family deferred at v3 and the [WORKFLOW-1](../execution/packets/WORKFLOW-1.md) workflow family now need the same admission rule.

## Measurements

Compiler under test: `5f12be07640e5bade0937d3bc7c1bc26b08d4c87`. The probes used the current first-party authored application and the same application with one existing `addField` patch, **Dispatch note** on Party. Neither input declared a formula, rule or workflow. Each case compiled from an equivalent fresh bootstrap with the current compiler-semantic profile. The customized case compiled against its case's first-party release as the expected active parent.

For the optional case, a temporary compiler registered both family identifiers, accepted an optional nonempty declaration for each and lowered a projection only when the declaration was present. For the revision case, it also registered a prototype v7 and matching normalization profile, retained the v6 feature set and storage defaults, and re-tagged the same authored nodes. The v7 probe used the v7 tag for new nodes emitted by the patch. No modeled rule or workflow behavior was added to the experiment.

| Input | Mode | Canonical release envelope (bytes) | Release root |
| --- | --- | ---: | --- |
| First-party | v6 before registration | 6,608,990 | `29d092c10e9c39cbe39303423c5fd59ac100c33aad0df3dc5f2d2390ecb4a537` |
| First-party | v6 with both unused families | 6,608,990 | `29d092c10e9c39cbe39303423c5fd59ac100c33aad0df3dc5f2d2390ecb4a537` |
| First-party | Prototype v7 | 6,608,990 | `952cb4f39086b9fc0f3d01223669aa7f66a0002123e31bc002bf5e0d55128ab0` |
| Customized | v6 before registration | 6,364,162 | `4a3c7ba2ac82705e014d203710811f08be6ed0f0411a2f80d6102c4b297465e6` |
| Customized | v6 with both unused families | 6,364,162 | `4a3c7ba2ac82705e014d203710811f08be6ed0f0411a2f80d6102c4b297465e6` |
| Customized | Prototype v7 | 6,364,162 | `a4dd9c71e997cb7381a58e8026cfbc1a13921228cfd63739138056832b049568` |

The complete first-party v6 lineage compared byte for byte with the optional-family result. Both first-party v6 envelopes have SHA-256 `c56329c19f579fa4fc65346bc91800246e55798d879de187ac7e0e0442da449a`. The v7 envelope has SHA-256 `01b120eee1690fcef03e04bb9a20fcfa7ff65c5b5f40e8fa57e2836b91338402`. The raw storage-target projection chunk was byte-identical across v6 and v7. The release manifest commits the declared language, normalization profile, normalized-definition digest and projection references, so the revision changes release identity even when the storage target and the set of emitted families stay the same.

The two customized v6 envelopes also compared byte for byte. Their SHA-256 was `36f5d91653624b83efc8ac9219b28b11ea9caa9b9967aca6ab1f70f017b5a672`. The customized v7 envelope had SHA-256 `8982ef09984dca0d7010a8f845a9574f912cc5514bffab002ba1655811ed262d`. The full tenant runner and the isolated compiler probes hit the existing local wall-clock limit. To measure artifact identity, the successful comparison fed the generated patch output to the current compiler with first-party fixture provenance in all three cases. Exact tenant-authored envelope reproduction remains an admission test. No compile or sandbox limit changed.

The prototype also appended a v7 entry, `eec65f91f560098e8ccf7c5e927b5aea2b881600b9ed1d94ee772d533a8e5c70`, to the checked-in first-party lineage after reproducing both recorded v6 roots. The planner admitted that edge.

The unchanged patch writer was tried against the prototype v7 base first. Its v6 tag on the new field, field selections and form/list nodes caused `CANON_VERSION_MIXED`. The v7 measurement re-tags the patch's emitted nodes in the probe. Current cross-language replay stays refused.

## Proposed decision

Admit both closed family IDs together through one versioned registration. Recommend optional, nonempty collections on v6 and a named, versioned payload and minimum reader for each dedicated projection. An absent declaration produces no normalized key, manifest reference, capability claim, or empty artifact. The existing mandatory families stay required. A present declaration must resolve to its complete, typed projection and required consumer bindings, or compilation or release admission refuses. This is an explicit amendment to the family-admission timing in ADR-0012 for additive families with measured absence parity. The older inline predicate positions stay in their owning catalogs.

The release manifest and release-verification code must match **both** directions of declaration and output, including the exact family, instance, payload version and reader requirement. A missing consumer refuses before activation. WORKFLOW-1's planned surface-reader floor 26 remains reserved for the surface behavior that consumes workflows. Dedicated family readers are independently versioned from the surface reader, and a release without either feature keeps its existing floors. When deploying, keep at least the newest patch parser and reader floors already used by tenants.

If admission requires materializing a default or changing the normalized language, batch both families in one language adoption. If identical normalized input starts producing different projections, append a compiler-semantic profile under ADR-0047 §1. Combine those events when both axes move. Historical readers reproduce each entry under its own language and profile.

## Release lineage and replay

Patch records store the payload digest, patch vocabulary version, base package/version/revision/root, parent and result revisions, resulting release, canonical language and normalization profile. The digest hashes the payload bytes. The release links bind the interpretation through the immutable normalized bytes and manifest, which commits the language and normalization profile. Approval and upgrade records bind exact release identities. These bindings survive a binary deployment and keep their recorded language.

UPGRADE-1/CRITFIX-B retains old bases, reproduces the source chain from its recorded roots, checks the replayable-kind allowlist, and compiles the replay against the new authored base with the source release as parent. The current preflight explicitly refuses a different package ID, language, or normalization profile with `CUSTOMIZE_BASE_MOVED`. CRITFIX-B keeps the verified source live and exposes the refusal. It does not translate patches. The optional v6 path keeps the language/profile check satisfied, with per-kind replay admission and original-root reproduction still required.

For a version bump, adopting it in the first-party source mints a new root even without declarations. Rebuild the authored and compiled first-party artifacts and rederive language conformance coverage and verification scenarios. Retain the existing entries when the planner admits the edge, as it did in the probe. If the planner refuses a storage change during pre-tenant development, ADR-0066 permits rebuilding the checked-in lineage from an empty bootstrap and resetting affected development databases. The platform migration chain stays append-only.

An existing customized v6 release remains pinned and serviceable on refusal. A disposable development environment could reset and re-author its changes at v7. Preserving a customized history across a language change requires an explicit, separately admitted translation and replay protocol. Evidence must cover source-root reproduction, version-aware patch emission, candidate verification, approval, activation and reverse compatibility. Keep historical readers and the original rows for rollback and audit.

## Formula/rule binding contract

- The dedicated projection carries stable IDs, versioned typed IR and result type, binding position and phase, purity, target, absence and error behavior, dependency and authorization/classification closure, applicable lowering and provider-probe references, allowed sinks, explanation contract, kernel version and IR hash, and deterministic assertion references.
- Validation binds to declared plain create/update Semantic Operations. Create evaluates the candidate values with declared defaults applied. Update evaluates the proposed row with unchanged values filled from the governed transaction snapshot. A rule fires on an update only if the actual write set intersects its compiler-declared watched fields, which include its local dependencies and the reference fields for admitted to-one traversals. An unrelated write or an independent update of a related record does not invoke the rule. A dependency on stored state is re-read inside the write transaction under the same locking and scope as the operation.
- Comparisons with an absent optional operand pass in the validation position. Only a required rule tests presence. Resolve absent values by canonical field type and position. An unreadable dependency, malformed value, or evaluation error is a refusal and cannot be treated as absence. A bound date comparison uses a captured business-date value from the operation context. Its source and time-zone semantics belong in the primitive contract.
- The compiler emits a deterministic satisfying example as the assertion reference for each admitted validation binding. It proves the reference meets the admitted rules and the invocation's typed input contract, and refuses an unsupported or unproved example. The verifier passes that exact example into the pinned assertion invocation. It does not search for, rewrite, or synthesize inputs. Gateway refusal and its form message use the same active rule as assistant discovery.
- Calculated fields are server-evaluated read-time display values. Exact-decimal operands carry precision, scale and currency through typing. Reject mixed currencies, unsupported overflow bounds and undeclared sinks. A derived display value never enters storage, a default, a mutation input, or a Tier B dependency set.

ADR-0012's structural depth ceiling of 24 and total, terminating, loop-free IR remain binding. No recursion, operation calls, ambient I/O, unbounded traversal, textual expression parser, or evaluator duplication. F4 paths must be typed and bounded. F5 remains subject to its own cardinality, snapshot, absence, and other §5.12 admission conditions. Workflow TypeScript stays on the durable process host under ADR-0073. Its effects invoke whole governed operations and it supplies no request-path expression semantics.

## Scope and acceptance

| Work | Projection required |
| --- | --- |
| CUSTOMIZE-3 slice 2 literal validation (F1 and F3) | Formula/rule |
| CUSTOMIZE-3 slice 3 cross-field and to-one validation (F2 and F4) | Formula/rule |
| CUSTOMIZE-3 slice 4 calculated display fields (F6) | Formula/rule |
| Future first-class expression action guards, relation filters, or F5 in a rule | Formula/rule, with distinct position and primitive admission |
| Saved views, column arrangement, role-based restriction, and cards over declared top-level list measures | Existing surface, query, and policy projections |
| WORKFLOW-1 workflow admission after the host slice | Workflow |

Before implementation adoption, keep the no-definition byte-equality probes for both a first-party and a customized release. Add positive family/reader and negative unsupported, missing consumer, undeclared projection, and historical replay tests. Each primitive still needs the §5.11 contract and provider, UI, assistant, reporting, and rollback evidence for its admitted positions. This proposal carries no validation, rule or calculated-field patch vocabulary until the orchestrator returns the ADR read.
